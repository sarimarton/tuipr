// tuipr — HUNK-FINDINGS: HYBRID findings bookkeeping (against session death).
//
// THE PAID-FOR BUG this layer exists to fix: the review ran to completion (the
// token spend HAPPENED), but the hunk session died WHILE it was running — the
// user had exited the hunk precisely so they could watch the progress in the
// TUI! — and EVERY finding was lost. "Run it again" would have been a RE-SPEND.
//
// So findings get TWO bookkeepings: the hunk session (if it's alive) AND the
// agent's final answer's structured JSON block. This module reads the latter
// and loads it in later.
//
// LAYER ORDER: imports downward (hunk: the session error class and the hint;
// proc: spawn diagnosis). hunk.mjs asks NOTHING back from here — the
// direction is one-way, guarded by scripts/check-next-modules.mjs.
import { HUNK_SESSION_HINT, hunkBin, isNoActiveSession } from './hunk.mjs'
import { spawnFailure } from './proc.mjs'
import { spawnSync } from 'node:child_process'

// === HYBRID FINDINGS: double bookkeeping against session death ==============
//
// THE PAID-FOR BUG: the review ran to completion (the token spend happened),
// but the hunk session died WHILE it was running (the user had exited the
// hunk precisely so they could watch the progress in the TUI!), and EVERY
// finding was lost — "run it again" would have been a re-spend.
//
// THE HYBRID ARCHITECTURE has three legs:
//   (a) the agent ALSO returns the findings structurally in its FINAL answer
//       (a fenced ```json block, {"findings":[…]}) — this is the DOUBLE
//       BOOKKEEPING;
//   (b) if the agent ALSO wrote into the hunk (the session was alive),
//       everything remains as it was;
//   (c) if the session died/never existed, the findings come from the answer
//       JSON: keyed on the PR, the cache stores them, and when the hunk is
//       OPENED they get loaded via the `hunk session comment apply --stdin`
//       batch path. The load is IDEMPOTENT: the `applied` flag records that
//       it happened.
//
// WHY THE FENCED JSON IN THE ANSWER TEXT, AND NOT `--json-schema`: forcing
// the ENTIRE output onto a schema with `--json-schema` would clash with the
// hunk-writing instruction (the agent needs to do work, not just answer), and
// the stream-json `result` field is the final text anyway — the fenced block
// can be parsed reliably out of that. The v1 (non-agent) path's
// `--json-schema` stays, because there the answer itself is the product.

/**
 * Extracting the ANSWER FINDINGS AND THE SUMMARY from the agent's final text.
 *
 * THREE OUTCOMES, three MEANINGS:
 *   - `{ summary, findings }` — the agent gave a structured block; an empty
 *     `findings` array is the MACHINE form of "found nothing" (legitimate),
 *     `summary` is `null` if the agent gave no (or a non-string/empty)
 *     summary;
 *   - `null` — NO block: the agent made no structured statement. This is NOT
 *     an empty list — the caller must not read it as "no findings";
 *   - THROW — there is a block, but the schema is broken (position/filePath/
 *     summary missing). Silently passing it through would break the
 *     batch-apply (fail-closed), or place a comment in the wrong spot.
 *
 * WHY AN OBJECT AS THE RETURN VALUE (wf24/2, the user's "I can't find a
 * summary anywhere" finding): the panel was missing a HUMAN-READABLE summary,
 * which up to then existed NOWHERE (the prompt didn't ask for one either). The
 * summary could have been hung on the array as a non-enumerable field
 * instead, but that would be a HIDDEN contract — JSON.stringify, spread, and
 * deepEqual would all drop it silently. Hence `{ summary, findings }`, passed
 * through by EVERY caller.
 *
 * BACKWARD COMPATIBLE toward the MODEL (not toward the callers): the
 * summary-LESS (old) shape, and even a BARE findings ARRAY, are both accepted
 * — a schema downgrade must not lose the findings of a review that's already
 * been paid for.
 *
 * FOR MULTIPLE blocks, the LAST findings block wins: the agent can print JSON
 * mid-work too, the final summary is authoritative.
 */
export function parseAnswerFindings(text) {
  const src = typeof text === 'string' ? text : ''
  if (src.trim() === '') return null
  const candidates = []
  const fence = /```(?:json)?[ \t]*\n([\s\S]*?)```/gi
  let m
  while ((m = fence.exec(src)) !== null) candidates.push(m[1])
  // The FULL answer as raw JSON is the STRONGEST candidate (answer-only agent):
  // it goes at the end of the list, because we iterate from the back.
  candidates.push(src)
  let found
  let summary = null
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    let parsed
    try {
      parsed = JSON.parse(candidates[i].trim())
    } catch {
      continue
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.findings)) {
      found = parsed.findings
      summary = typeof parsed.summary === 'string' && parsed.summary.trim() !== ''
        ? parsed.summary.trim()
        : null
      break
    }
    // THE BARE ARRAY (schema downgrade): the agent dropped the wrapping
    // object. We accept it — the findings are already paid for, a formal
    // slip must not discard them. There's no summary in that case.
    if (Array.isArray(parsed)) {
      found = parsed
      summary = null
      break
    }
  }
  if (found === undefined) return null
  const findings = found.map((f, i) => {
    if (typeof f?.filePath !== 'string' || f.filePath.trim() === '') {
      throw new Error(`answer finding ${i} is missing filePath — the batch-apply would fail on it`)
    }
    if (typeof f.summary !== 'string' || f.summary.trim() === '') {
      throw new Error(`answer finding ${i} (${f.filePath}) is missing summary — we don't load an empty comment`)
    }
    const newLine = Number(f.newLine)
    const oldLine = Number(f.oldLine)
    const hasNew = f.newLine !== undefined && f.newLine !== null && Number.isInteger(newLine) && newLine > 0
    const hasOld = f.oldLine !== undefined && f.oldLine !== null && Number.isInteger(oldLine) && oldLine > 0
    if (!hasNew && !hasOld) {
      throw new Error(
        `answer finding ${i} (${f.filePath}) has no position (newLine|oldLine) — `
        + 'the hunk batch-apply rejects a finding with no position, fail-closed',
      )
    }
    const out = { filePath: f.filePath }
    // If BOTH are given (agent slip), the post-image (newLine) wins: it's the
    // more common one and the diff's right-hand side — throwing here would
    // discard an entire (already paid-for) review over a redundant field.
    if (hasNew) out.newLine = newLine
    else out.oldLine = oldLine
    out.summary = f.summary
    if (typeof f.rationale === 'string' && f.rationale.trim() !== '') out.rationale = f.rationale
    return out
  })
  return { summary, findings }
}

/**
 * The batch-apply STDIN payload — the MEASURED schema (hunk 0.17.0):
 *   printf '{"comments":[{"filePath":"f.txt","newLine":5,"summary":"…"}]}' \
 *     | hunk session comment apply --repo <path> --stdin
 *   → "Applied 2 live comments", noteId `mcp:<uuid>:<n>`.
 *
 * `rationale` gets appended to summary: the measured apply schema only
 * carries a summary, and losing the rationale is worse than concatenating it.
 */
export function answerFindingsPayload(findings) {
  return JSON.stringify({
    comments: (Array.isArray(findings) ? findings : []).map((f) => ({
      filePath: f.filePath,
      ...(f.newLine !== undefined && f.newLine !== null ? { newLine: f.newLine } : { oldLine: f.oldLine }),
      summary: f.rationale ? `${f.summary}\n\n${f.rationale}` : f.summary,
    })),
  })
}

/**
 * LOADING the cached answer findings into the (already-live) hunk session.
 *
 * FAIL-CLOSED on every branch; the "no live session" error STATES that the
 * findings REMAIN in the cache — the user must not think they were lost
 * (exactly the harm this hybrid layer was built against).
 *
 * For an EMPTY list, we don't call hunk at all: applying 0 comments is just
 * noise.
 */
export function applyAnswerFindings(repoRoot, findings) {
  const list = Array.isArray(findings) ? findings : []
  if (list.length === 0) return 0
  const res = spawnSync(
    hunkBin(),
    ['session', 'comment', 'apply', '--repo', repoRoot, '--stdin'],
    { encoding: 'utf8', input: answerFindingsPayload(list) },
  )
  const spawnErr = spawnFailure(res, 'hunk')
  if (spawnErr) throw new Error(`cannot start loading the answer findings: ${spawnErr}`)
  if (res.status !== 0) {
    if (isNoActiveSession(res)) {
      // NOT the `review` context's wording: that would say "we did NOT spend
      // tokens" — here, however, the review has ALREADY RUN, only the load
      // failed.
      throw new Error(
        `there is no live hunk session for this repo (${repoRoot}), so the answer `
        + `findings cannot be loaded. The findings REMAIN in the cache (all ${list.length}) — the spend wasn't lost. `
        + `What to do: ${HUNK_SESSION_HINT}, then the load can be offered again (Enter on the PR panel).`,
      )
    }
    throw new Error(
      `loading the answer findings into the hunk session failed (exit ${res.status}): `
      + `${(res.stderr || res.stdout || '').trim() || '(no output)'} — the findings REMAIN in the cache.`,
    )
  }
  // The MEASURED success line: "Applied N live comments". If the shape
  // changes, the submitted count is the honest fallback (with exit 0).
  const applied = /Applied\s+(\d+)\s+live comment/i.exec(String(res.stdout ?? ''))
  return applied ? Number(applied[1]) : list.length
}
