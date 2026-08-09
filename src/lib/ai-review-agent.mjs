// tuipr — AI-REVIEW-AGENT: execution of the AGENT-DRIVEN review.
//
// The TUI STARTS and MEASURES; the agent itself writes the findings into the
// hunk session (via the hunk-review skill's `comment apply` batch path). What
// lives here: the agent prompt and argv, the background process with the
// watchdog, the NDJSON stream reader, and the final envelope parsing.
//
// LAYERING: imports downward (ai-review-run: the HUMAN-IN-THE-LOOP gate;
// allowlist, ai-review-config, ai-review-view). ai-review-run.mjs requests
// NOTHING back from here — measured one-directional, guarded by
// scripts/check-next-modules.mjs.
//
// THE GATE IS THE SAME as on the schema-based path: claude's SUCCESS IS NOT
// ENOUGH. If not a single comment landed in the hunk session, the review is
// NOT successful — otherwise the TUI would report "0 findings, all clear",
// which is the lying empty answer.
import { aiReviewGate } from './ai-review-run.mjs'
import { hunkCommentCount } from './hunk.mjs'
import {
  AI_REVIEW_ALLOWED_TOOLS_ARGS,
  AI_REVIEW_DISALLOWED_TOOLS_ARGS,
  AI_REVIEW_SETTING_SOURCES_ARGS,
  PERMISSION_REALITY_INSTRUCTION,
  denialMessage,
} from './allowlist.mjs'
import { REVIEW_PATHS, budgetArgs, claudePath, modelArgs } from './ai-review-config.mjs'
import { AI_REVIEW_TIMEOUT_MS } from './ai-review-view.mjs'
import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'

// --- AGENT-DRIVEN review: the TUI STARTS and MEASURES, the agent writes the findings --
//
// THE RESPONSIBILITY BOUNDARY compared to v1 (runAiReview + injectHunkComments)
// has FLIPPED, and that flip is the whole point:
//   v1: claude RETURNED a structured findings JSON, and the TUI wrote them
//       into the hunk session (injectHunkComments). The TUI had to know the
//       hunk CLI, AND had to flatten the findings model onto our own schema —
//       the severity/rule_ref/category got lost.
//   v2 (this one): the review agent WRITES INTO the hunk ITSELF (via the
//       hunk-review skill's `comment apply` batch path), the TUI ONLY starts
//       and WAITS. The agent can use its own, richer findings model, and the
//       hunk-writing drops out of the TUI.
//
// WHAT THIS FLIP TAKES AWAY: the envelope's response no longer contains the
// findings, so `parseAiReviewResult`'s findings gate (v1's MOST IMPORTANT
// protection) is, IN PRINCIPLE, not applicable here. THE MEASUREMENT takes
// its place: the hunk comment count BEFORE and AFTER — see aiReviewGate. The
// order is therefore fixed: MEASURE → START → MEASURE AGAIN → GATE.

/**
 * The prompt for the agent-driven review.
 *
 * It contains TWO PROHIBITIONS, and each rules out a CONCRETE harm:
 *
 *  1. DO NOT POST TO GITHUB. The findings must go into the hunk session,
 *     because that's where the developer goes through them (`comment rm`),
 *     and the EXISTING 'f' path uploads what REMAINS under our attribution.
 *     If the agent posts on its own, the human-in-the-loop gate is BYPASSED
 *     (the body's `verifiedBy` claim becomes a lie), and the format isn't
 *     ours either. The official code-review plugin does exactly this
 *     (`gh pr comment`), so the prohibition isn't theoretical.
 *  2. DO NOT DELETE/EDIT existing comments. The DEVELOPER's own notes may
 *     also be sitting in the session; the review agent has no business with
 *     those. This isn't just etiquette: the gate measures the INCREASE in
 *     count, so a deletion would mask newly written findings (5 deleted + 5
 *     new = 0 increase → a false "wrote nothing"), or would fail-closed as a
 *     decrease.
 */
// The RESPONSE-JSON instruction — the DOUBLE-ENTRY BOOKKEEPING (leg (a) of
// the hybrid layer). ALWAYS included in the prompt, regardless of session
// state: if the session dies mid-run, the findings can still be salvaged
// from the response.
const ANSWER_FINDINGS_INSTRUCTION = [
  'In your FINAL answer, also return the findings STRUCTURED, in a fenced',
  'JSON block, in EXACTLY this schema:',
  '',
  '```json',
  '{"summary":"2-4 sentences: what you reviewed, what the main risk is, what the verdict is",'
    + '"findings":[{"filePath":"src/a.ts","newLine":5,"summary":"one sentence","rationale":"optional longer rationale"}]}',
  '```',
  '',
  // THE SUMMARY (wf24/2): the user reported, after the sixth live run, that
  // "I can't find a summary anywhere" — and they were right: the prompt
  // NEVER asked for one, so there was nothing TO display. The findings list
  // does not substitute for the verdict.
  'The top-level `summary` is REQUIRED and HUMAN-READABLE: in 2-4 English sentences,',
  'say WHAT you reviewed (files/focus), WHAT the main risk is, and WHAT the verdict is.',
  'This shows up both in the TUI panel and in the GitHub review body — don\'t repeat',
  'the findings list in it, summarize instead.',
  '',
  'The `newLine` is the post-image, the `oldLine` is the pre-image side\'s 1-based line',
  'number — give EXACTLY one of them per finding. If you found nothing, return an',
  'EMPTY findings array (`summary` is still required). This block is REQUIRED: without',
  'it, if the session dies, your findings are lost.',
].join('\n')

function agentReviewPrompt({ pr, repoRoot, reviewPath, sessionAlive = true, headRef = null }) {
  const path = REVIEW_PATHS.find((p) => p.id === reviewPath)
  // The SANCTIONED file-reading path. MEASURED error class: without ref
  // passing, the agent reached for `gh api .../contents | base64 -d` — the
  // permission pattern can't allow the pipe on principle, so it was denied,
  // and the review ended up truncated. Local git show needs the ref the TUI
  // has ALREADY fetched.
  const fileAccessBlock = headRef
    ? [
        '',
        `READING FILE CONTENT: the PR head is available locally — \`git show ${headRef}:<path>\`.`,
        'The `gh api …/contents` path is FORBIDDEN (it would need base64 + pipe, which',
        'the permission layer won\'t let through — your call will be denied and the review truncated).',
      ]
    : []
  const hunkBlock = sessionAlive
    ? [
        'WRITE THE FINDINGS INTO THE HUNK SESSION, NOT TO GITHUB.',
        'Use the `hunk-review` skill (the `hunk session comment apply` batch path),',
        `and write into the \`--repo ${repoRoot}\` session. For every finding give a`,
        'FILE and a LINE (the hunk `--new-line` is the post-image, `--old-line` is',
        'the pre-image side\'s 1-based line number) — do NOT write a finding without',
        'a position, because the upload will fail-closed on it.',
        '',
        'It is FORBIDDEN to delete (`comment rm`) or rewrite a comment ALREADY',
        'PRESENT in the hunk session: the DEVELOPER\'s OWN notes may be among them.',
        'Only add NEW ones.',
      ]
    : [
        // NO live session: requesting the hunk-write would go nowhere (and
        // would spend tokens on it). In that case the findings' ONLY channel
        // is the response JSON.
        'There is NO live hunk session for this repo: do NOT call the hunk CLI, and',
        'do NOT try to open a session. Return the findings EXCLUSIVELY in the',
        'response JSON below.',
      ]
  return [
    `Run the \`${path.command}\` review on pull request #${pr}.`,
    '',
    `Repo root: ${repoRoot}`,
    '',
    ...hunkBlock,
    ...fileAccessBlock,
    '',
    PERMISSION_REALITY_INSTRUCTION,
    '',
    'The developer decides about the upload, after reviewing the findings.',
    '',
    ANSWER_FINDINGS_INSTRUCTION,
    '',
    'Look for real defects: correctness, error handling, race conditions,',
    'security, swallowed errors, missing tests on a critical path. Do NOT give',
    'style comments.',
    'If you truly find nothing, state that EXPLICITLY in your answer —',
    'a silent "I wrote nothing" CANNOT be read as a successful review.',
  ].join('\n')
}

/**
 * The shape of the agent-driven review's `claude -p` call. A separate, PURE
 * function, so the flags and prompt prohibitions are under test.
 *
 * WHY THERE'S NO `--json-schema`: on this path the findings do NOT come back
 * in the envelope response (the agent writes them into the hunk instead), so
 * enforcing a findings schema would be a lying contract — success is
 * measured by aiReviewGate instead.
 *
 * The `--tools` set, however, is BROADER than on v1: the agent has to WRITE
 * (it calls the hunk CLI via Bash), and the review skills kick off an
 * agent fanout, so Task is needed too. This narrowing is still deliberate:
 * Write/Edit are NOT included, so the agent cannot modify the REPO — only
 * the hunk session.
 */
export function agentReviewCommand({ pr, repoRoot, reviewPath, maxBudgetUsd, model, sessionAlive = true, headRef = null }) {
  const args = [
    '-p', agentReviewPrompt({ pr, repoRoot, reviewPath, sessionAlive, headRef }),
    // `stream-json` IS THE PRECONDITION FOR THE PROGRESS SIGNAL, not a style
    // choice.
    //
    // MEASURED FACT (claude 2.1.220): `--output-format json` gives ONE big
    // JSON at the END — stdout was EMPTY for the entire 5.88s wall time in
    // between. So there was nothing TO read as a stream: the user's "I see
    // no feedback at all after 5 minutes" experience was STRUCTURALLY
    // unavoidable on this path.
    //
    // `stream-json`, ON THE OTHER HAND, immediately gives
    // `{"type":"system","subtype":"init"}` (even BEFORE the model call — so
    // "started" can be signaled right away), then per-message `tool_use`
    // blocks and `rate_limit_event`. The `result` line is the SAME object as
    // the old full output, so the envelope parser stays unchanged.
    //
    // `--verbose` IS REQUIRED alongside `stream-json`: otherwise claude
    // refuses the call ("--output-format=stream-json requires --verbose").
    '--output-format', 'stream-json',
    '--verbose',
    // The ceiling is OPTIONAL and OFF by default (see the budget section's
    // rationale: the flag is for API spend, but the user consumes a
    // subscription limit instead).
    ...budgetArgs(maxBudgetUsd),
    '--permission-mode', 'dontAsk',
    // WITHOUT THE `Skill` TOOL THE PATH IS IMPASSABLE — MEASURED (#904).
    //
    // The prompt asks precisely that the agent run `/agent-review` and use
    // the `hunk-review` skill. The old list (`Bash,Read,Grep,Glob,Task`)
    // LEFT OUT the `Skill` tool: in the live trial claude reported
    // `["Task","Bash","Glob","Grep","Read"]` in the `"tools"` field, so
    // calling a skill was IMPOSSIBLE in principle. The #904 run's log
    // confirmed this: the agent ran into permission denials one after
    // another, then stated outright that "the review did not run".
    '--tools', 'Bash,Read,Grep,Glob,Task,Skill',
    // THE PERMISSION ALLOWLIST — alongside `--tools`, the SECOND gate, and
    // the ACTUAL blocker of the #904 run. Rationale and measurement:
    // `AI_REVIEW_ALLOWED_TOOLS`.
    ...AI_REVIEW_ALLOWED_TOOLS_ARGS,
    // The explicit deny (mutating gh paths) — deny > allow, guards against a
    // future allow-list loosening too.
    ...AI_REVIEW_DISALLOWED_TOOLS_ARGS,
    // ISOLATION: the user-level CLAUDE.md excluded, project skills remain
    // (measurement: the head of AI_REVIEW_SETTING_SOURCES).
    ...AI_REVIEW_SETTING_SOURCES_ARGS,
    // THE MODEL IS ALWAYS EXPLICIT — default: opus (see AI_REVIEW_DEFAULT_MODEL).
    ...modelArgs(model),
  ]
  return ['claude', args]
}

/**
 * Running the agent-driven review: MEASURE → START → MEASURE AGAIN → GATE.
 *
 * THE ORDER OF STEPS IS THE CONTRACT:
 *  1. VALIDATING the review path — BEFORE the claude call, because an
 *     excluded path (`/review`, a one-agent one-shot; `/code-review ultra`,
 *     which runs in the cloud and whose binary forbids starting an agent)
 *     either burns money if launched, or silently gives a worse review;
 *  2. the `before` MEASUREMENT — before claude, because without it the
 *     increase can't be computed (the session may already hold the
 *     developer's own comments);
 *  3. launching `claude -p`;
 *  4. fail-closed reading of the envelope (exit code, is_error,
 *     api_error_status, subtype, permission_denials) — this is NECESSARY,
 *     but NOT SUFFICIENT;
 *  5. the `after` MEASUREMENT and aiReviewGate — THIS is the real gate.
 *
 * The relationship between steps 4 and 5 is the point: `claude -p` can,
 * MEASURED, give an exit 0 + `subtype:"success"` + `is_error:false`
 * response even though the review never ran at all. On this path the
 * envelope's response proves NOTHING about the findings (the agent writes
 * those into the hunk), so the ONLY observable fact is the increase in
 * count. Step 4 stays because a concrete envelope-level error (permission
 * denial, API error) gives a MORE EXPLANATORY message than the gate failing
 * at the end with a bare "wrote nothing".
 */
// `maxBudgetUsd` DELIBERATELY has no default: under the default-OFF
// contract, the absence of a ceiling is the normal case, and a baked-in
// `= 3` would silently bring the flag back for every caller that passes
// nothing.
export function runAgentReview({ pr, repoRoot, reviewPath, maxBudgetUsd, model, cwd }) {
  // 1. Validating the review path — BEFORE the claude call (no half-spend).
  const path = REVIEW_PATHS.find((p) => p.id === reviewPath)
  if (!path) {
    const known = REVIEW_PATHS.map((p) => p.id).join(', ')
    throw new Error(
      `invalid review path: ${JSON.stringify(reviewPath)} — the claude call NEVER STARTED. `
      + `Available paths: ${known}. `
      + 'The builtin `/review` (a one-agent one-shot) and `/code-review ultra` '
      + '(runs in the cloud, $5-25/run, and its binary forbids starting an agent) are DELIBERATELY excluded.',
    )
  }

  const cp = claudePath()
  if (!cp) {
    throw new Error(
      'the `claude` CLI is not available on PATH, so the AI review cannot run. '
      + 'Install the Claude Code CLI (or put it on PATH), then try again. '
      + 'Until then, the hunk-diff review (`d`) always works.',
    )
  }

  // 2. The `before` MEASUREMENT. If the hunk session can't be read, we fail
  // LOUDLY right here — claude NEVER STARTS. Reason: without a measurable
  // starting state the gate can't be interpreted, and failing after the
  // token spend is worse than failing before it.
  //
  // `context: 'review'` PICKS THE ERROR TEXT: on this path "no live
  // session" is a PRECONDITION error (the findings would land there), so
  // the message gives the path to opening one — not the raw hunk stderr,
  // which was unusable in the #904 user report.
  const before = hunkCommentCount(repoRoot, { context: 'review' })

  // 3. The call.
  const [cmd, args] = agentReviewCommand({ pr, repoRoot, reviewPath, maxBudgetUsd, model })
  const res = spawnSync(cmd, args, { encoding: 'utf8', cwd, maxBuffer: 64 * 1024 * 1024 })
  if (res.error) throw new Error(`claude -p failed to start: ${res.error.message}`)

  // 4. Fail-closed reading of the envelope — NECESSARY, but NOT SUFFICIENT.
  const envelope = parseAgentReviewEnvelope(res.stdout, res.status, res.stderr)

  // 5. The `after` MEASUREMENT and THE REAL GATE. aiReviewGate throwing is
  // EXPLANATORY: that's where it becomes clear that the "successful" claude
  // wrote nothing, or deleted something.
  //
  // THE CONTEXT HERE IS DIFFERENT (`after`): claude has ALREADY RUN, so on
  // the review branch the sentence "we did NOT spend tokens" would be a LIE
  // here. This error class isn't theoretical either: the agent (or the hunk
  // daemon) may close off the session mid-run, and then, after the `before`
  // succeeds, the `after` fails.
  const after = hunkCommentCount(repoRoot, { context: 'after' })
  const gate = aiReviewGate({ before, after })

  return {
    ...gate,
    reviewPath: path.id,
    model: envelope.model,
    costUsd: envelope.costUsd,
    sessionId: envelope.sessionId,
    durationMs: envelope.durationMs,
    result: envelope.result,
  }
}



/**
 * Reading ONE LINE of the NDJSON `stream-json` stream → a progress signal.
 *
 * MEASURED SCHEMA (claude 2.1.220, `--output-format stream-json --verbose`, live trial):
 *   {"type":"system","subtype":"init","cwd":"…","model":"claude-haiku-4-5",…}
 *   {"type":"system","subtype":"status","status":"requesting",…}
 *   {"type":"stream_event","event":{…},"ttft_ms":1152}
 *   {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash",…}]}}
 *   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning",…}}
 *   {"type":"result","subtype":"success","num_turns":2,…}
 *
 * The `result` line is the SAME JSON object as the full output of
 * `--output-format json` — so `parseAgentReviewEnvelope` can be used
 * UNCHANGED, it just needs to be given the last `result` line.
 *
 * THE RATE-LIMIT EVENT ISN'T SILENT EITHER: the live trial produced
 * `utilization: 0.78` for the 7-day limit. The old code didn't see this AT
 * ALL (it's not in the final envelope), and this was one of the prime
 * suspects behind the "aborted" mislabeling.
 *
 * Returns `null` if the line isn't signal-worthy (unparseable, or
 * uninteresting) — the caller writes nothing in that case. SILENT SWALLOWING
 * IS LEGITIMATE and narrow here: a truncated NDJSON line (JSON cut mid-way
 * at a chunk boundary) is NORMAL, not an error.
 */
export function parseStreamProgressLine(line) {
  const text = String(line ?? '').trim()
  if (text === '') return null
  let ev
  try {
    ev = JSON.parse(text)
  } catch {
    return null
  }
  if (ev?.type === 'system' && ev?.subtype === 'init') return { event: 'init', tool: 'started' }
  if (ev?.type === 'rate_limit_event') {
    const info = ev.rate_limit_info ?? {}
    const pct = Number(info.utilization)
    return {
      event: 'rate-limit',
      tool: Number.isFinite(pct)
        ? `RATE-LIMIT: ${Math.round(pct * 100)}% (${info.rateLimitType ?? '?'})`
        : `RATE-LIMIT: ${info.status ?? '?'}`,
    }
  }
  if (ev?.type === 'assistant') {
    const blocks = ev.message?.content
    if (Array.isArray(blocks)) {
      const use = blocks.find((b) => b?.type === 'tool_use')
      if (use) return { event: 'tool', tool: String(use.name ?? 'tool') }
    }
  }
  // The `result` line is the FINAL envelope — NOT progress, the caller hands
  // it to the envelope parser. The signal is useful though: from this we
  // know the stream has closed.
  if (ev?.type === 'result') return { event: 'result', envelopeLine: text }
  return null
}

/**
 * THE BACKGROUND REVIEW: launching `claude -p` ASYNCHRONOUSLY into the
 * ALREADY-LIVE hunk session.
 *
 * THIS IS THE CONCURRENT MODEL. The user's request, verbatim: "can't we have
 * it so that on the first r it opens [the PR] diff and kicks off a review
 * from a background process?"
 *
 * MEASURED PRECONDITION (hunk 0.17.0, alongside a live TUI, from ANOTHER
 * process): the hunk session is readable AND writable WHILE the TUI is
 * running — the daemon is the broker. All three calls succeeded from a
 * separate process while the hunk TUI was running:
 *   hunk session reload  --repo <path> -- diff        → "Reloaded repo …"
 *   hunk session comment apply --repo <path> --stdin  → "Applied 1 live comments"
 *   hunk session comment list  --repo <path> --type agent --json → 1 comment
 * AND the written comment ALSO SHOWS UP in the RUNNING TUI ("Agent note",
 * `a` = toggle in the AI notes view) — so the user really SEES them appear.
 *
 * WHY `spawn` AND NOT `spawnSync` (same argument as for the merge-tree
 * meter): spawnSync would FREEZE the Ink render loop for the entire duration
 * of the review — no navigating, no quitting, and the "runs in the
 * background" promise would be a lie.
 *
 * THE ORDERING GUARANTEE IS THE CALLER'S RESPONSIBILITY (waitForHunkSession):
 * this function ASSUMES the session is ALREADY alive. Without that, claude
 * would write into the void, and the token spend would be wasted — which is
 * exactly why the waiting is a SEPARATE, measurable step.
 *
 * `spawn` IS INJECTABLE: the stream handling, the kill, and the ENOENT
 * branch can thus be tested without a real child process (and without real
 * token spend).
 *
 * RETURNS: `{ abort, done }` — `done` is a Promise that settles with the
 * envelope metadata (or an error). `abort` is the EXIT PATH: a user quitting
 * the TUI (`q`) must not leave a zombie claude behind.
 *
 * --- THE #904 FIXES, ALL THREE ---------------------------------------------
 *
 * 1. THE ABORT REASON NOW PASSES THROUGH (`abort(reason)`), not just an
 *    `aborted` boolean. In the old code, `q` (quit), `x` (user abort), and
 *    the timeout ALL produced the same `{ aborted: true }`, and the caller
 *    wrote "aborted" — this was the LYING signal the user reported.
 *
 * 2. THE PROGRESS CALLBACK (`onProgress`) receives the `stream-json` NDJSON
 *    lines LINE BY LINE. Without it, the status line stays on the static
 *    starting text — this was the "I see no feedback at all after 5
 *    minutes".
 *
 * 3. THE WATCHDOG (`timeoutMs`) gives its OWN end state. The `claude` CLI,
 *    MEASURED, has no `--timeout` flag, so the ceiling is our
 *    responsibility; without it the review could have run for HOURS.
 */
export function startAgentReview({
  pr, repoRoot, reviewPath, maxBudgetUsd, model, cwd,
  // The HYBRID layer's session state: when false, the prompt asks for the
  // response JSON as the EXCLUSIVE channel instead of the hunk write (see
  // agentReviewPrompt).
  sessionAlive = true,
  spawn: spawnImpl = spawn,
  onProgress,
  timeoutMs = AI_REVIEW_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout, headRef = null }) {
  // VALIDATING the review path before the spawn (no half-spend) — the same
  // contract as on the synchronous path.
  const path = REVIEW_PATHS.find((p) => p.id === reviewPath)
  if (!path) {
    const known = REVIEW_PATHS.map((p) => p.id).join(', ')
    throw new Error(
      `invalid review path: ${JSON.stringify(reviewPath)} — the claude call NEVER STARTED. `
      + `Available paths: ${known}.`,
    )
  }
  const cp = claudePath()
  if (!cp) {
    throw new Error(
      'the `claude` CLI is not available on PATH, so the AI review cannot run. '
      + 'Install the Claude Code CLI (or put it on PATH), then try again. '
      + 'Until then, the hunk-diff review (`d`) always works.',
    )
  }

  const [cmd, args] = agentReviewCommand({ pr, repoRoot, reviewPath, maxBudgetUsd, model, sessionAlive, headRef })
  const child = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd })
  let stdout = ''
  let stderr = ''
  // THE ABORT REASON, NOT JUST THE FACT OF IT. The old `aborted` boolean
  // lumped together quitting, user abort, and timeout — exactly the
  // catch-all branch that produced the #904 lying "aborted".
  let abortReason = null
  let settled = false
  let resolveDone
  let rejectDone
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej })
  // The `done` promise is ALWAYS handled (the caller awaits it), but for an
  // aborted review the caller no longer cares — without the `catch`, an
  // unhandledRejection would crash the process.
  const settle = (fn) => {
    if (settled) return
    settled = true
    fn()
  }

  // THE WATCHDOG. WHY OUR OWN (and not a CLI flag): `claude --help`
  // (2.1.220), MEASURED, doesn't know `--timeout` or `--max-turns`. Without
  // it the review can hang silently for HOURS — for the #904 user this fear
  // was exactly the real risk.
  let watchdog = null
  const clearWatchdog = () => {
    if (watchdog !== null) { clearTimer(watchdog); watchdog = null }
  }
  if (Number(timeoutMs) > 0) {
    watchdog = setTimer(() => {
      // THE TIMEOUT IS ALSO AN ABORT — but with its OWN reason, so the
      // caller gives its OWN message for it.
      abortReason = 'timeout'
      try { child.kill?.() } catch { /* killing an already-exited child isn't an error */ }
      // The `close` event COULD also release this, but the `close` of an
      // already-dead (or never-started) child may never fire — so the
      // settle happens HERE too. `settle` is idempotent, so the two don't
      // collide.
      settle(() => resolveDone({ aborted: true, reason: 'timeout', timeoutMs }))
    }, Number(timeoutMs))
  }

  // READING THE STREAM LINE BY LINE — THIS IS THE ENGINE OF THE PROGRESS
  // SIGNAL.
  //
  // THE BUFFER IS REQUIRED: a chunk boundary can fall in the MIDDLE of a
  // JSON line (measured: the stream's lines run several hundred bytes, the
  // pipe's chunk is 64 KB, but model responses arrive in pieces). Without a
  // line buffer, every truncated line would yield `null`, and the signal
  // would randomly go missing.
  let lineBuf = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (c) => {
    stdout += c
    if (!onProgress) return
    lineBuf += c
    const parts = lineBuf.split('\n')
    // THE LAST ELEMENT IS THE TRUNCATED REMAINDER: it goes back into the buffer.
    lineBuf = parts.pop() ?? ''
    for (const line of parts) {
      const ev = parseStreamProgressLine(line)
      // A CALLBACK ERROR DOESN'T TAKE THE REVIEW DOWN WITH IT: the progress
      // signal is a CONVENIENCE, the review is the WORK. A throwing
      // `onProgress` (e.g. setState on an unmounted React component) would
      // otherwise take down the whole process as an unhandled exception —
      // the TUI too.
      if (ev) { try { onProgress(ev) } catch { /* the signal's error isn't a review error */ } }
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (c) => { stderr += c })

  child.on('error', (error) => {
    clearWatchdog()
    settle(() => rejectDone(new Error(
      error?.code === 'ENOENT'
        ? 'claude -p cannot be started (ENOENT): `claude` is not installed, or not on PATH. '
          + 'This is NOT a review error — the binary itself is missing.'
        : `claude -p failed to start: ${error?.message ?? String(error)}`,
    )))
  })
  // `signal` IS THE SECOND ARGUMENT, AND IT'S NOT DISPOSABLE.
  //
  // MEASURED FACT: if the process is killed FROM THE OUTSIDE (OOM killer,
  // `pkill`, the machine sleeping, the shell's SIGHUP), `close` gives
  // `code === null` — the exit happened VIA SIGNAL. The SIGNAL'S NAME,
  // however, is in the SECOND argument, and the old code DIDN'T EVEN READ
  // IT. Consequence: the end state couldn't name the cause in principle, so
  // at best it could only say "a signal killed it" — while `SIGKILL` (OOM /
  // `kill -9`), `SIGTERM` (orderly shutdown), and `SIGHUP` (the terminal
  // closing) call for THREE DIFFERENT actions from the user.
  child.on('close', (code, signal) => {
    clearWatchdog()
    // WE DON'T ASSERT ANYTHING AFTER AN ABORT: the output of an aborted
    // review isn't a fact (the same principle as the merge-tree meter's
    // abort branch, which was a BLOCKER). WE DO PASS ON THE REASON, though:
    // the caller uses it to know WHICH end state to report.
    if (abortReason !== null) {
      settle(() => resolveDone({ aborted: true, reason: abortReason, timeoutMs }))
      return
    }
    // THE PARSE BEFORE THE `settle` — THIS WAS THE #904 ROOT BUG.
    //
    // The old code read like this:
    //     try { settle(() => resolveDone({ envelope: parse(...) })) }
    //     catch (error) { settle(() => rejectDone(error)) }
    // The `parse` ran INSIDE the arrow passed to settle, but `settle` set
    // `settled = true` FIRST, and only THEN called the function. So a
    // throwing parse meant: (1) settle had already "used itself up", (2) the
    // throw escaped into the catch, (3) where `settle(() => rejectDone(error))`
    // was ALREADY a no-op. Neither `resolveDone` nor `rejectDone` was ever
    // called → the `done` promise stayed PENDING FOREVER → the caller's
    // `await handle.done` got stuck → `showError` NEVER ran → the status
    // line stayed on the starting text forever. THIS is the user's "I see
    // no feedback at all after 5 minutes" experience.
    //
    // PROVEN IN ISOLATION: the broken shape produced a `Warning: Detected
    // unsettled top-level await`, and NEITHER callback of `.then(onOk, onErr)`
    // ever fired, EVEN THOUGH the reject branch had "run".
    //
    // THE FIX: the parse runs in the BODY of the `try`, BEFORE the `settle`
    // CALL. Every envelope-level error (permission_denials, is_error,
    // api_error_status, subtype, non-zero exit, non-JSON stdout) rejects
    // PROPERLY this way.
    let envelope
    try {
      envelope = parseAgentReviewEnvelope(stdout, code, stderr)
    } catch (error) {
      // THE RAW FACTS ARE PASSED ON TOO: the `failed` end state shows the
      // exit code and the FIRST LINE of stderr, but those can't be extracted
      // from the error object. `signal` IS ALSO PASSED ON: the `failed` end
      // state NAMES the signal from it.
      settle(() => rejectDone(Object.assign(error, {
        exitCode: code, signal: signal ?? null, stderrText: stderr,
      })))
      return
    }
    settle(() => resolveDone({ envelope, reviewPath: path.id }))
  })

  return {
    done,
    /**
     * ABORTING THE BACKGROUND REVIEW — KILL, not detach.
     *
     * WHY KILL (and why we don't let it keep running): `claude -p` WRITES
     * into the hunk session. A detached review would keep writing into a
     * session that NOBODY is looking at anymore AFTER the TUI quits — the
     * findings would surface in a DIFFERENT PR's context on the next TUI
     * launch, and the `f` upload would send them up under OUR attribution.
     * That's exactly the lying provenance the feature avoids everywhere
     * else. A zombie is separately forbidden too: the project already paid
     * for that once with the merge-tree meter.
     *
     * `reason` IS THE POINT OF THE FIX: it tells the caller whether the user
     * aborted (`user`), the TUI closing killed it (`exit`), or the watchdog
     * did (`timeout`). The old, reasonless abort called ALL THREE
     * "aborted".
     */
    abort: (reason = 'user') => {
      abortReason = reason
      clearWatchdog()
      try { child.kill?.() } catch { /* killing an already-exited child isn't an error */ }
      // THE SETTLE HERE, IMMEDIATELY — NOT waiting for the `close` event.
      //
      // MEASURED BUG (reproduced in isolation): `spawn(stub)` → `kill()` at
      // 300 ms → the `close` event at 4297 ms. `kill` kills the DIRECT
      // child (`/bin/sh`, in production the `claude` wrapper), but the
      // GRANDCHILDREN keep living and HOLD the stdout pipe open; Node's
      // `close` waits for the stdio EOF too. In production this is worse:
      // `claude -p` starts an agent fanout (the prompt asks for the Task
      // tool), so the grandchildren can keep running for quite a while.
      //
      // THE EFFECT ON THE USER if we waited for `close`: after `x` (abort),
      // the status line says NOTHING until the claude tree finishes on its
      // own — exactly the "I pressed it and nothing happens" experience
      // this patch fixes. `kill` still goes out (no zombie), but the UI
      // doesn't wait on the grandchildren.
      //
      // `settle` IS IDEMPOTENT, so the `close` that arrives later anyway
      // (which here is the `abortReason` branch) OVERWRITES NOTHING.
      settle(() => resolveDone({ aborted: true, reason, timeoutMs }))
    },
  }
}

/**
 * Envelope parsing for the agent-driven path: WITHOUT the
 * `parseAiReviewResult` findings gate (findings don't come back on the
 * response here), but WITH every envelope-level error flag.
 *
 * The metadata is MEASURED, not declared: the model comes from the
 * `modelUsage` key (this is the model ACTUALLY used — a stale env value
 * would give a lying attribution on the PR), the spend from
 * `total_cost_usd`.
 */
export function parseAgentReviewEnvelope(stdout, status, stderr = '') {
  const raw = String(stdout ?? '')
  const clip = (s) => (s.length > 2000 ? `${s.slice(0, 2000)}…[truncated]` : s)

  if (status !== 0) {
    throw new Error(
      `claude -p exited with a non-zero code (exit ${status}).\n`
      + `stderr: ${String(stderr ?? '').trim() || '(empty)'}\n`
      + `stdout: ${clip(raw.trim()) || '(empty)'}`,
    )
  }

  // NDJSON-TOLERANT PARSE. `--output-format stream-json` gives MANY lines,
  // and the FINAL `{"type":"result",…}` line is the SAME object as the old
  // full output of `--output-format json` (MEASURED: bit-identical
  // structure in the live trial). So we don't replace the parser: we just
  // hand it the LAST `result` line.
  //
  // BACKWARD COMPATIBILITY IS DELIBERATE: a single JSON object with no `\n`
  // (the stubs on the synchronous `runAgentReview` path, and any old caller)
  // passes through the same way — that's the special case of "one line that
  // happens to be result-typed".
  let env
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  // THE LAST `result` LINE, searched from the BACK: `stream_event` and
  // `assistant` lines also arrive during the stream, and those are NOT
  // envelopes.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let cand
    try {
      cand = JSON.parse(lines[i])
    } catch {
      continue
    }
    // We also accept an object WITHOUT a `type` field: the old (non-stream)
    // contract didn't require `type: "result"`, and a sudden tightening
    // would SILENTLY break existing callers.
    if (cand?.type === undefined || cand?.type === 'result') { env = cand; break }
  }
  if (env === undefined) {
    throw new Error(
      'the claude -p output has NO `result` envelope line — the review cannot be verified.\n'
      + `raw output:\n${clip(raw)}`,
    )
  }

  // Four INDEPENDENT error flags: none implies the other, and a
  // model-level failure can still give exit 0.
  if (env.is_error === true) {
    throw new Error(`claude -p signaled an error (is_error): ${clip(String(env.result ?? '(no result)'))}`)
  }
  if (env.api_error_status !== null && env.api_error_status !== undefined) {
    throw new Error(`claude -p signaled an API error: api_error_status=${env.api_error_status}`)
  }
  if (env.subtype !== undefined && env.subtype !== 'success') {
    throw new Error(`claude -p exited with a non-success subtype: subtype=${env.subtype}`)
  }
  // A DENIAL ISN'T FATAL ON ITS OWN — IT'S DATA. The user's third failed run
  // showed this: 3 denied calls caused the WHOLE review to be classified as
  // "FAILED", even though the agent had produced findings too. A partial
  // review != a zero review: the caller decides — a degraded result with
  // findings (a caveat), or, with no findings, the old loud error (with the
  // denialMessage text).
  const deniedCommands = Array.isArray(env.permission_denials)
    ? env.permission_denials.map((d) => String(d?.tool_input?.command ?? d?.tool_name ?? '(unknown)'))
    : []

  return {
    deniedCommands,
    denials: Array.isArray(env.permission_denials) ? env.permission_denials : [],
    model: Object.keys(env.modelUsage ?? {})[0] ?? null,
    costUsd: env.total_cost_usd ?? null,
    sessionId: env.session_id ?? null,
    durationMs: env.duration_ms ?? null,
    result: typeof env.result === 'string' ? env.result : null,
  }
}
