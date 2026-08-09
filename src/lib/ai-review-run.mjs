// tuipr — AI-REVIEW-RUN: EXECUTING the AI review.
//
// What lives here: the prompts, the claude argv, the wrapper parse
// (FAIL-CLOSED: exit 0 + `is_error: true` is ALSO a throw), the
// HUMAN-IN-THE-LOOP GATE (claude's success is NOT enough — the findings MUST
// land in the hunk session), the background process, and producing the SEVEN
// end states.
//
// LAYERING: imports downward (allowlist: the permission policy and the
// permission-reality block; ai-review-config: the scope/claude-path/argv
// details; ai-review-view: the AI_REVIEW_TIMEOUT_MS watchdog ceiling). The
// view asks NOTHING back from here — the direction is one-way (measured).
//
// THE GATE'S RATIONALE: claude can return a perfect wrapper (exit 0, subtype
// "success", is_error false) even with an EMPTY hunk session. Without this,
// the TUI would report "0 findings, all clear" — the lying empty response the
// contract forbids.
import {
  AI_REVIEW_ALLOWED_TOOLS_ARGS,
  AI_REVIEW_DISALLOWED_TOOLS_ARGS,
  AI_REVIEW_SETTING_SOURCES_ARGS,
  PERMISSION_REALITY_INSTRUCTION,
  denialMessage,
} from './allowlist.mjs'
import { REVIEW_PATHS, aiReviewScope, budgetArgs, claudePath, modelArgs } from './ai-review-config.mjs'
import { AI_REVIEW_TIMEOUT_MS } from './ai-review-view.mjs'
import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
/**
 * The REAL gate in the agent-driven flow: did a comment ACTUALLY land in the
 * hunk session.
 *
 * WHY CLAUDE'S EXIT CODE ISN'T ENOUGH (a measured trap): `claude -p` can
 * return exit 0 + `subtype:"success"` + `is_error:false` even though the
 * review DID NOT run. In this flow, the agent ITSELF writes the findings into
 * the hunk, so the wrapper's success proves nothing about the findings — the
 * ONLY observable fact is the `comment list` count BEFORE and AFTER. Without
 * this, the TUI would report "0 findings, all clear": exactly the lying empty
 * response the fail-closed contract forbids.
 *
 * A DECREASE is also an error: the review agent has no business with EXISTING
 * comments (even the developer's own), so a shrinking count means it deleted
 * something — that's session corruption, not a successful review.
 *
 * A LEGITIMATE "0 findings" result does NOT come through this path: the agent
 * must report it EXPLICITLY (see aiReviewPrompt), and the caller decides
 * whether to even call the gate.
 */
export function aiReviewGate({ before, after }) {
  if (!Number.isInteger(before) || !Number.isInteger(after)) {
    // A missing MEASUREMENT doesn't let us infer success (the same
    // fail-closed principle as confirmAccepts's armedAt).
    throw new Error(
      'the AI review cannot be verified: the hunk comment count was not MEASURED '
      + `(before=${JSON.stringify(before)}, after=${JSON.stringify(after)}). NOT uploading anything.`,
    )
  }
  if (after < before) {
    throw new Error(
      `the AI review DELETED a comment from the hunk session (${before} → ${after}, ${before - after} `
      + 'lost). The review agent has no business with existing comments — this is session '
      + 'corruption, not a successful review. NOT uploading anything.',
    )
  }
  if (after === before) {
    throw new Error(
      'claude -p ran successfully, but wrote NOT A SINGLE comment to the hunk session '
      + `(${before} → ${after}). A successful wrapper doesn't rule this out (a measured trap: `
      + 'exit 0 + subtype:"success" can also come from a review that never ran), so the review '
      + 'cannot be considered to have run. If the agent genuinely found no findings, it must '
      + 'report that EXPLICITLY.',
    )
  }
  return { added: after - before, before, after }
}

/**
 * THE GATE FOR THE PARALLEL MODEL: a diff of `noteId` SETS, not a count.
 *
 * WHY A COUNT ISN'T ENOUGH (the `aiReviewGate` shape above) FOR THE
 * BACKGROUND REVIEW: there, WHILE claude is running, the USER ALSO writes to
 * the session (they're sitting in the diff). A plain increment can therefore
 * give a FALSE POSITIVE — with two user comments, the gate would claim a
 * "successful AI review" even if claude wrote not a single line. And a FALSE
 * NEGATIVE too: if the agent wrote 2 and the user meanwhile deleted 2, the
 * count doesn't change, even though the review DID RUN.
 *
 * THE SET DIFF RULES OUT BOTH: `added` is exactly the agent findings that
 * appeared WHILE claude was running (`after \ before`).
 *
 * THE FAIL-CLOSED BRANCHES REMAIN, with the same rationale as the count-based
 * version — just ID-based now, so more precisely:
 *   - non-set input → the measurement didn't happen, we don't infer success;
 *   - a DISAPPEARED ID (missing from `after` but present in `before`) → session
 *     corruption (the agent is FORBIDDEN to delete), so NOT a successful
 *     review;
 *   - EMPTY `added` → the "successful wrapper but wrote nothing" measured
 *     trap.
 */
/**
 * Is this the ID of a note written BY HAND by the USER in the hunk TUI?
 *
 * MEASURED (hunk 0.17.0, in a live TUI, driven from tmux):
 *   written with `c` in the TUI → `{ noteId: "user:1785433028013", source: "user" }`
 *   applied via CLI             → `{ noteId: "mcp:1898b8aa-…:0",   source: "agent" }`
 *
 * Built on the PREFIX, not on `source`, because the gate works with SETS OF
 * IDs (a count gives a false positive in the parallel model) — and only the
 * ID is present in the set.
 */
function isUserNoteId(id) {
  return typeof id === 'string' && id.startsWith('user:')
}

/**
 * THE IDs OF NEW FINDINGS WRITTEN BY THE AGENT — the SINGLE source for the
 * set diff.
 *
 * WHY A SEPARATE, EXPORTED FUNCTION (a measured gap, not theoretical): in
 * `doAiReview`, DECIDING the `no-findings` end state also needs this same set
 * diff, BEFORE `aiReviewGateByIds` throws. The first version there computed a
 * RAW diff (`[...after].filter((id) => !before.has(id))`), WITHOUT filtering
 * the `user:` prefix — and the two DRIFTING APART produced a real false
 * positive:
 *
 *   in the parallel model the USER also writes to the session (they're
 *   sitting in the diff). If the agent wrote NOTHING, but the user wrote ONE
 *   note of their own, the unfiltered diff gave 1 element → the `no-findings`
 *   branch was SKIPPED, the run fell through to the gate's throw, and the
 *   user got an ERROR OVERLAY because of their OWN note.
 *
 * ONE SOURCE, ONE FILTER: the gate and the end-state decision both call this
 * same function.
 */
export function aiReviewAgentAdditions({ before, after }) {
  if (!(before instanceof Set) || !(after instanceof Set)) {
    throw new Error(
      'the AI review\'s increment was not MEASURED: the hunk finding-ID set is not a Set '
      + `(before=${JSON.stringify(before)}, after=${JSON.stringify(after)}).`,
    )
  }
  return [...after].filter((id) => !before.has(id) && !isUserNoteId(id))
}

export function aiReviewGateByIds({ before, after }) {
  if (!(before instanceof Set) || !(after instanceof Set)) {
    throw new Error(
      'the AI review cannot be verified: the hunk finding-ID set was not MEASURED '
      + `(before=${JSON.stringify(before)}, after=${JSON.stringify(after)}). NOT uploading anything.`,
    )
  }
  // THE DELETION CHECK ALSO ONLY APPLIES TO AGENT FINDINGS. The user is FREE
  // to delete their OWN note in the TUI (wrote it with `c`, closes it with
  // `[x]`) — that's not session corruption, it's the human-in-the-loop gate
  // doing its job. If we treated this as corruption too, we'd run EVERY
  // review to a fail-closed error for a user tidying up their own note in the
  // parallel flow.
  const removed = [...before].filter((id) => !after.has(id) && !isUserNoteId(id))
  if (removed.length > 0) {
    throw new Error(
      `the AI review DELETED a comment from the hunk session (${removed.length} finding(s) `
      + `disappeared: ${removed.slice(0, 3).join(', ')}${removed.length > 3 ? '…' : ''}). The review `
      + 'agent has no business with existing comments — this is session corruption, not a '
      + 'successful review. NOT uploading anything.',
    )
  }
  // AMONG THE NEW IDs, ONLY THE AGENT-WRITTEN ONES COUNT.
  //
  // WHY THE FILTER IS NEEDED (caught by a test, a real gap): in the parallel
  // model, the USER also writes to the session while the agent is working. A
  // bare "new ID" is therefore not yet an AI finding — if the user wrote one
  // and the agent wrote nothing, an unfiltered set diff would claim "1 new
  // finding", i.e. a SUCCESSFUL review. Exactly the false positive we
  // replaced the count-based gate for; the set diff alone does NOT solve it,
  // only together with the filter.
  //
  // THE INSIGHT IS MEASURED (hunk 0.17.0): a comment written by hand in the
  // hunk TUI has ID `user:<epoch-ms>`, one written via the CLI (`comment
  // apply`) has `mcp:<uuid>:<n>`. The `user:` prefix is thus the mark of a
  // user write — and since the measurement runs through the `--type agent`
  // filter, a user comment couldn't get here anyway: this is the SECOND line
  // of defense, which stays correct even under a future type change.
  // THE SET DIFF COMES FROM THE SHARED FUNCTION: the same one `doAiReview`
  // calls to decide the `no-findings` end state. The duplicated computation
  // already drifted apart once (the `user:` filter was missing on one branch)
  // — see the `aiReviewAgentAdditions` header.
  const addedIds = aiReviewAgentAdditions({ before, after })
  if (addedIds.length === 0) {
    throw new Error(
      'claude -p ran successfully, but wrote NOT A SINGLE new comment to the hunk session '
      + `(${before.size} finding(s) before, ${after.size} now, 0 new). A successful wrapper `
      + 'doesn\'t rule this out (a measured trap: exit 0 + subtype:"success" can also come '
      + 'from a review that never ran), so the review cannot be considered to have run. If the '
      + 'agent genuinely found no findings, it must report that EXPLICITLY.',
    )
  }
  return { added: addedIds.length, addedIds, before: before.size, after: after.size }
}


/**
 * The findings JSON Schema — `--json-schema` uses this to validate the
 * model's response.
 *
 * The schema is NOT arbitrary: findings go up through the EXISTING
 * toGithubComments path, which expects the hunk's schema
 * (filePath/side/line/summary/rationale). `side` is therefore the hunk's
 * vocabulary ('new'/'old'), not GitHub's (RIGHT/LEFT) — the mapping lives in
 * one place, in toGithubComments.
 */
export function aiFindingsSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['filePath', 'side', 'line', 'summary'],
          properties: {
            filePath: { type: 'string', description: "the file's path relative to the repo root" },
            side: { type: 'string', enum: ['new', 'old'], description: 'which side of the diff' },
            line: { type: 'integer', description: 'line number in the post-image (new) or pre-image (old) file' },
            summary: { type: 'string', description: "one sentence: what's wrong" },
            rationale: { type: 'string', description: 'optional longer explanation' },
          },
        },
      },
    },
  }
}

/**
 * The AI review prompt. We do NOT reference a repo-local skill, because the
 * built-in `/review`'s body isn't auditable (it's not a file on disk, and can
 * change with the version), and the official code-review plugin posts
 * ITSELF via `gh pr comment` — in its own format, without our attribution —
 * making it incompatible with the uploadFindings path. So the prompt lives
 * here instead, versioned, in the repo, and EXPLICITLY forbids posting.
 */
function aiReviewPrompt({ pr, scope }) {
  return [
    `Review pull request #${pr}. Fetch the diff yourself: \`gh pr diff ${pr}\``,
    'or per-file with `gh pr diff` / `git diff` — get the PR metadata with `gh pr view`.',
    '',
    'ONLY review the files below (the rest are generated fixtures/lockfiles, skip them):',
    ...scope.map((f) => `  - ${f}`),
    '',
    PERMISSION_REALITY_INSTRUCTION,
    '',
    'Return findings ONLY in the structured output — the developer decides',
    'about uploading, after reviewing them.',
    '',
    'The findings schema (`side` is the side of the diff: "new" is the post-image, "old" is the pre-image;',
    '`line` is that side\'s 1-based file line number, and it must point to a line that',
    'EXISTS in the PR\'s diff — a line outside the diff fails the upload of the WHOLE review).',
    '',
    'Look for real defects: correctness, error handling, race conditions, security,',
    'swallowed errors, missing tests on a critical path. Do NOT give style comments.',
    'If you find nothing, return an empty findings array — do not make up a finding.',
  ].join('\n')
}

/**
 * The shape of the `claude -p` call. A separate, PURE function, so the flags
 * (structured output, schema, ceiling, permission mode) are under test —
 * dropping any of these would silently break the fail-closed contract.
 */
export function aiReviewCommand({ pr, scope, maxBudgetUsd, model }) {
  const args = [
    '-p', aiReviewPrompt({ pr, scope }),
    '--output-format', 'json',
    '--json-schema', JSON.stringify(aiFindingsSchema()),
    // THE CEILING IS OPTIONAL, and by default there ISN'T one. If there's no
    // valid number, the flag doesn't go into argv AT ALL — no `undefined`
    // string, no 0, no "unlimited". `--max-budget-usd undefined` is a parse
    // error on claude's side, and `0` is an immediately-cut-off review; both
    // are worse than the flag being absent.
    ...budgetArgs(maxBudgetUsd),
    // Non-interactively, the permission prompt would hang (nobody to answer
    // it). `dontAsk` is the narrower option: it never even reaches anything
    // outside the --tools list.
    '--permission-mode', 'dontAsk',
    // The tool surface is narrowed: the review needs reading and `gh`, NOT
    // writing. `Skill` is NEEDED: the review paths call a skill (see the
    // agent-path rationale).
    '--tools', 'Bash,Read,Grep,Glob,Skill',
    // The PERMISSION ALLOWLIST (see the `AI_REVIEW_ALLOWED_TOOLS` header) and
    // the explicit deny (mutating gh paths — deny > allow, against loosening).
    ...AI_REVIEW_ALLOWED_TOOLS_ARGS,
    ...AI_REVIEW_DISALLOWED_TOOLS_ARGS,
    // ISOLATION: the user-level CLAUDE.md is excluded (measured:
    // AI_REVIEW_SETTING_SOURCES).
    ...AI_REVIEW_SETTING_SOURCES_ARGS,
    // THE MODEL IS ALWAYS EXPLICIT — inheriting the default is, per the
    // user's measured finding, a silent cost escalation (for them, Fable 5
    // was the saved default).
    ...modelArgs(model),
  ]
  return ['claude', args]
}

/**
 * FAIL-CLOSED parsing of the `claude -p --output-format json` wrapper.
 *
 * The ORDER of the gates is deliberate: first the exit code and the
 * wrapper-level error flags, because those give the most concrete
 * explanation; then the findings parse, which is the ONLY gate that catches
 * the "looks successful but never ran" review (see point 1 of the section
 * header comment).
 *
 * EVERY error path also returns the RAW output: the developer needs to see
 * what the model said — otherwise the "unparseable" message alone is
 * undiagnosable.
 */
/**
 * THE MAIN MODEL from the `modelUsage` map: the one that DID the WORK.
 *
 * (wf31/69) The "main" measure is SPEND, tokens out is secondary: helper
 * calls (haiku for labels, classifications) consume orders of magnitude less
 * than the model writing the review. The key ORDER doesn't decide — see the
 * call site's rationale.
 *
 * WE DO NOT RELY ON KEY NAMES IN ANY SINGLE SHAPE: the `claude -p` wrapper's
 * schema can change between versions (`costUSD` / `costUsd` / `cost_usd`,
 * `outputTokens` / `output_tokens`), and a silent key rename would bring back
 * exactly this bug. So we check every known shape, and if NONE is
 * measurable, we fall back to the first key in key order (the behavior FROM
 * BEFORE wf31/69) — that's at least no worse.
 *
 * FAIL-SAFE: missing/invalid `modelUsage` → `null`. `reviewBody` doesn't
 * write a lying value for a `null` model, the caller decides the default.
 */
function dominantModel(usage) {
  if (!usage || typeof usage !== 'object') return null
  const names = Object.keys(usage)
  if (names.length === 0) return null
  if (names.length === 1) return names[0]
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const pick = (keys) => {
    let best = null
    let bestVal = null
    for (const n of names) {
      const entry = usage[n]
      if (!entry || typeof entry !== 'object') continue
      const val = keys.map((k) => num(entry[k])).find((v) => v !== null) ?? null
      if (val === null) continue
      if (bestVal === null || val > bestVal) {
        bestVal = val
        best = n
      }
    }
    return best
  }
  return pick(['costUSD', 'costUsd', 'cost_usd'])
    ?? pick(['outputTokens', 'output_tokens'])
    ?? names[0]
}

export function parseAiReviewResult(stdout, status, stderr = '') {
  const raw = String(stdout ?? '')
  const clip = (s) => (s.length > 2000 ? `${s.slice(0, 2000)}…[truncated]` : s)

  if (status !== 0) {
    throw new Error(
      `claude -p exited with a non-zero code (exit ${status}).\n`
      + `stderr: ${String(stderr ?? '').trim() || '(empty)'}\n`
      + `stdout: ${clip(raw.trim()) || '(empty)'}`,
    )
  }

  let env
  try {
    env = JSON.parse(raw)
  } catch {
    throw new Error(
      'claude -p\'s output is not parseable JSON — NOT uploading anything.\n'
      + `raw output:\n${clip(raw)}`,
    )
  }

  // Three INDEPENDENT error flags, all three must be checked: none implies
  // the other, and a model-level failure can still give exit 0.
  if (env.is_error === true) {
    throw new Error(`claude -p signaled an error (is_error): ${clip(String(env.result ?? '(no result)'))}`)
  }
  if (env.api_error_status !== null && env.api_error_status !== undefined) {
    throw new Error(`claude -p signaled an API error: api_error_status=${env.api_error_status}`)
  }
  if (env.subtype !== undefined && env.subtype !== 'success') {
    throw new Error(`claude -p exited with a non-success subtype: subtype=${env.subtype}`)
  }
  if (Array.isArray(env.permission_denials) && env.permission_denials.length > 0) {
    throw new Error(
      `${denialMessage(env.permission_denials)} Therefore NOT uploading anything.`,
    )
  }

  // The findings are in `result`, serialized as a string (even with
  // --json-schema): the wrapper's result field is text. IF it's not
  // parseable or has no findings array in it, the review DID NOT run — this
  // is the most important gate.
  const resultText = typeof env.result === 'string' ? env.result : JSON.stringify(env.result ?? null)
  let parsed
  try {
    parsed = JSON.parse(resultText)
  } catch {
    throw new Error(
      'claude -p returned a wrapper reporting success, but its response is NOT the requested '
      + 'findings JSON — so the review did not run. NOT uploading anything.\n'
      + `the model's response:\n${clip(resultText)}`,
    )
  }
  if (!parsed || !Array.isArray(parsed.findings)) {
    throw new Error(
      'claude -p\'s response has NO `findings` array — the review did not run (a successful '
      + 'wrapper does NOT rule this out). NOT uploading anything.\n'
      + `the model's response:\n${clip(resultText)}`,
    )
  }

  // The schema validation runs on the model's side, but WE read the
  // wrapper: a comment without a filePath would fail the WHOLE review on
  // GitHub with a 422, so the incomplete finding must be caught here — it
  // must NOT be let through.
  parsed.findings.forEach((f, i) => {
    if (typeof f?.filePath !== 'string' || f.filePath.length === 0) {
      throw new Error(`finding ${i} is missing filePath — the WHOLE review would fail on GitHub with a 422`)
    }
    if (typeof f.summary !== 'string' || f.summary.length === 0) {
      throw new Error(`finding ${i} (${f.filePath}) is missing summary — not uploading an empty comment`)
    }
    if (f.side !== undefined && f.side !== 'new' && f.side !== 'old') {
      throw new Error(`finding ${i} has an invalid side: ${JSON.stringify(f.side)} (new|old)`)
    }
  })

  // The metadata is MEASURED, not declared: the model from `modelUsage` (this
  // is the model ACTUALLY used), the spend from `total_cost_usd`.
  //
  // (wf31/69) `Object.keys(...)[0]` WAS A MEASURED, OWN BUG. The user's
  // finding: they picked SONNET in the TUI, yet the uploaded review's
  // metadata showed `claude-haiku-4-5-20251001` — alongside `costUsd: 6.24`,
  // which isn't haiku-scale, so the RUN was fine, the SELECTION was wrong.
  //
  // THE CAUSE: `modelUsage` lists EVERY model the run used, not just the main
  // one — Claude Code also calls haiku for its own internal helper calls
  // (label generation, small classifications, subagents) alongside the chosen
  // model. `[0]` thus took the first one in JSON KEY ORDER, which can be
  // anything.
  //
  // WHY NO TEST CAUGHT IT: every fixture contains a SINGLE key
  // (`modelUsage: { 'claude-opus-5': {…} }`) — the bug only shows with
  // multiple models, and `[0]` is always correct with one key.
  const model = dominantModel(env.modelUsage)
  return {
    findings: parsed.findings,
    model,
    costUsd: env.total_cost_usd ?? null,
    sessionId: env.session_id ?? null,
    durationMs: env.duration_ms ?? null,
  }
}

/**
 * Running the AI review. The call spends the RUNNING USER's tokens, so the
 * TUI calls it ONLY after confirmation (aiReviewBlockers + the confirm gate).
 *
 * We check for `claude` being missing HERE TOO (not just at the blockers): an
 * ENOENT spawnSync gives `status: null`, which on the naive `status !== 0`
 * branch would degrade into an "exit null" message — that's not an
 * explanatory error.
 */
export function runAiReview({ pr, scope, maxBudgetUsd, model, cwd }) {
  const cp = claudePath()
  if (!cp) {
    throw new Error(
      'the `claude` CLI is not available on PATH, so the AI review cannot run. '
      + 'Install the Claude Code CLI (or add it to PATH), then try again. '
      + 'Until then, the hunk-diff review (`d`) always works.',
    )
  }
  const [cmd, args] = aiReviewCommand({ pr, scope, maxBudgetUsd, model })
  const res = spawnSync(cmd, args, { encoding: 'utf8', cwd, maxBuffer: 64 * 1024 * 1024 })
  if (res.error) throw new Error(`claude -p failed to start: ${res.error.message}`)
  return parseAiReviewResult(res.stdout, res.status, res.stderr)
}
