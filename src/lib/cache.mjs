// tuipr — CACHE: PR-number-keyed, SESSION-lifetime measurement cache + list indicator
// + review-trace bookkeeping + the AI-findings slots.
//
// PURE MODULE: ZERO project imports and ZERO I/O. This is not accidental, it's a
// MEASURED invariant — test/next-cache.test.ts reads the WHOLE file, and requires
// that it contain neither spawn nor file I/O: the indicator producers run on
// every render, so a process-spawn lurking here would slow the list down.
//
// (The test used to slice core.mjs BETWEEN the `// === CACHE` … `// === CACHE-END`
// markers. After the file-per-section split, the module IS the section itself —
// which eliminates the class of bug where a shifted marker SILENTLY yields an
// empty slice, which every forbidding assertion "passes".)

// === CACHE: PR-number-keyed, SESSION-lifetime measurement cache + list indicator ======
//
// The PROBLEM this eliminates: reopening the `i` panel reran the merge-tree
// probes EVERY time (7 candidates on #911, seconds). The user called this
// "distracting", and rightly so: the same answer to the same question —
// unless whatever the answer derives from has moved.
//
// WHAT THE ANSWER DERIVES FROM is the ANCHOR, and EXACTLY TWO things:
//   1) the PR's `updatedAt` — a new push/rebase/comment: the measured head is
//      no longer this;
//   2) the trunk (`origin/<main|dev>`, see trunkBranch) SHA — the merge-tree
//      probe measures AGAINST the trunk, so a trunk move CHANGES THE RESULT
//      without touching the PR.
// The two do NOT substitute for each other: a trunk push that doesn't touch a
// PR doesn't move that PR's updatedAt, yet still invalidates the diagnosis.
//
// WHY WE DON'T DELETE, BUT MARK STALE INSTEAD: the list needs to signal that
// THERE IS a measured result, just no longer valid. Deletion ("no measurement")
// and staleness ("there was one, but the base moved") mean DIFFERENT next steps
// for the user, and showing a cached result as "done" is the most expensive
// mistake: the user would merge a PR with a moved base, citing the measured
// absence of conflicts.
//
// WHY SESSION-LIFETIME (not on disk): the next image moves hourly; a
// persistent cache would outlive it by days, and the anchor check would want a
// gh/git call per row on every startup — bringing back exactly the slowdown
// the cache was built to remove.
//
// (1d) THIS DECISION APPLIES TO THE **MEASUREMENT CACHE** (diagnosis), AND IS
// UNCHANGED. The REVIEW RESULT, however, moved to a SEPARATE, PERSISTENT layer
// (bin/next/review-store.mjs), because it's data of a DIFFERENT NATURE: PAID
// FOR (tokens spent), and it's not about the queue's STATE but about the PR's
// DIFF — so it's valid for exactly as long as its anchor holds, not "until the
// end of the session". The argument above doesn't apply to it either: the
// disk read runs ONCE (at startup, batched), not per row and not per render,
// so it doesn't slow the list down. The user's request: "have the app cache
// reviews to disk, because restarting all the time is tiring."
//
// THE TWO LAYERS DO NOT BLEND: this file STAYS ZERO-I/O (see the header) — on
// the render path THIS memory cache is what's used; the disk only moves at TUI
// startup and when a review completes/is discarded.

/** The cache's slots. The diagnosis and the review report go stale INDEPENDENTLY. */
const CACHE_SLOTS = new Set(['diagnosis', 'reviewReport'])

/** The accepted sources of the review trace. */
const REVIEW_TRACE_SOURCES = new Set(['ai', 'hunk'])

/**
 * The glyphs of the FOUR-STATE list indicator.
 *
 * WIDTH AS MEASURED (tmux 3.7b, CSI 6n cursor-advance, tmux running in Ghostty):
 *   ⋯ U+22EF advance=1 · ✓ U+2713 advance=1 · ~ U+007E advance=1 · ⊙ U+2299 advance=1
 * Not guessed: the user reported the column-shift FOUR TIMES, and its root
 * cause was exactly someone guessing a glyph's width.
 *
 * The "done" mark is `✓` U+2713 (THIN check), NOT `✔` U+2714 — U+2714 is the
 * approve column's `approved` mark (RMARKS). "One meaning, one glyph": if the
 * two matched, the eye would read the approve mark where the question is
 * MEASUREMENT readiness, and the two columns would blur together.
 *
 * The `none` state has NO glyph: it's the most common row state, and an empty
 * placeholder on every row is just noise (plus one cell per row, at the cost
 * of the title budget).
 */
export const CACHE_GLYPHS = {
  measuring: '⋯',
  fresh: '✓',
  stale: '~',
}

/**
 * The REVIEW TRACE glyph. `⊙` U+2299 (CIRCLED DOT OPERATOR), MEASURED at 1 cell.
 *
 * WHY not `●`/`○`: those are ALREADY taken (queue membership and the approve
 * column respectively) — "one meaning, one glyph".
 */
export const REVIEW_TRACE_GLYPH = '⊙'

/**
 * The cache's storage. SESSION-lifetime: the life of one TUI instance.
 *
 * `entries`: `"<pr>:<slot>"` → entry. The FLAT key is deliberate: a per-PR
 * sub-Map would produce insertion-order-dependent emptiness states (empty
 * sub-Map vs. non-existent) that every reader would have to handle.
 *
 * `reviewTrace`: PR number → source set. SEPARATE from the entries, because
 * its nature is DIFFERENT: the trace is a FACT about the session ("a review
 * ran on this PR"), not a MEASUREMENT — it doesn't go stale when main moves,
 * and `R` doesn't clear it either.
 */
export function createCache() {
  // `aiFindings` is the HYBRID layer's storage (PR number → { findings, applied }):
  // findings stored FROM the review's RESPONSE. SEPARATE from `entries`, because
  // it's not a measurement (doesn't go stale with the anchor), and SEPARATE from
  // the trace, because it has content — see cacheStoreAiFindings's header.
  return { entries: new Map(), reviewTrace: new Map(), aiFindings: new Map() }
}

const slotKey = (pr, slot) => `${pr}:${slot}`

function assertSlot(slot) {
  if (!CACHE_SLOTS.has(slot)) {
    // LOUD: a mistyped slot name would SILENTLY give a cache that never hits
    // (every open would remeasure, and no one would notice the cache is dead).
    throw new Error(
      `unknown cache slot: ${JSON.stringify(slot)} — valid: ${[...CACHE_SLOTS].join(', ')}`,
    )
  }
}

/**
 * The INVALIDATION ANCHOR for one row: the PR's `updatedAt` + the `origin/main` SHA.
 *
 * FAIL-CLOSED on missing data: if either side is missing, the `unknown: true`
 * marker is set, and `anchorsEqual` NEVER reports a match — not even with
 * itself. WHY: if we silently mapped a missing `updatedAt` to `""`, two
 * entries measured at DIFFERENT times would have MATCHING anchors, so we'd
 * show a stale diagnosis as "fresh". Better to remeasure than to lie about
 * freshness.
 */
export function cacheAnchor({ row, mainSha } = {}) {
  const updatedAt = typeof row?.updatedAt === 'string' && row.updatedAt !== '' ? row.updatedAt : null
  const sha = typeof mainSha === 'string' && mainSha !== '' ? mainSha : null
  const anchor = { updatedAt, mainSha: sha }
  if (updatedAt === null || sha === null) anchor.unknown = true
  return anchor
}

/** Whether two anchors match. An UNKNOWN anchor NEVER matches (fail-closed). */
export function anchorsEqual(a, b) {
  if (!a || !b) return false
  if (a.unknown === true || b.unknown === true) return false
  return a.updatedAt === b.updatedAt && a.mainSha === b.mainSha
}

/**
 * Recording a MEASUREMENT START. The `measuring` state takes PRECEDENCE over
 * stale: once a remeasure has started, the row is "measuring…", not "stale" —
 * the user sees exactly what's happening.
 */
export function cacheMarkMeasuring(cache, pr, slot, { anchor } = {}) {
  assertSlot(slot)
  cache.entries.set(slotKey(pr, slot), { measuring: true, anchor: anchor ?? null, value: null, error: null, aborted: false })
  return cache
}

/**
 * Recording a MEASUREMENT RESULT. Three outcomes, three branches:
 *   - `value`   — the measured result (this is the only one that's "done"),
 *   - `error`   — the measurer fell over: NO value, so NOT done,
 *   - `aborted` — the user interrupted it: a partial result isn't a diagnosis.
 * The errored/aborted entry is ALSO stored (the `measuring` state must be
 * closed out), it just doesn't count as done.
 */
export function cachePut(cache, pr, slot, { value = null, error = null, aborted = false, anchor } = {}) {
  assertSlot(slot)
  cache.entries.set(slotKey(pr, slot), {
    measuring: false,
    anchor: anchor ?? null,
    value,
    error,
    aborted,
  })
  return cache
}

/** An entry, or `null`. The caller decides what to do with it via `cacheEntryState`. */
export function cacheGet(cache, pr, slot) {
  assertSlot(slot)
  return cache.entries.get(slotKey(pr, slot)) ?? null
}

/**
 * The FULL cache invalidation (`R`). Does NOT clear the review trace: that's
 * not a MEASUREMENT, but a fact about the session. If we cleared it, after a
 * review that ACTUALLY HAPPENED the attestation would fall back to the
 * shorter ("no review happened") body — the attestation would then lie, just
 * in the other direction.
 */
export function cacheInvalidateAll(cache) {
  cache.entries.clear()
  return cache
}

/**
 * The state of ONE entry measured against the CURRENT anchor:
 *   `none`      — no entry, or there is one but it has no measured value
 *                 (error / abort): nothing to show as "done";
 *   `measuring` — the measurement is running;
 *   `fresh`     — has a value, and the anchor MATCHES;
 *   `stale`     — has a value, but the anchor has moved (or is unknowable).
 */
export function cacheEntryState(entry, anchor) {
  if (!entry) return 'none'
  if (entry.measuring === true) return 'measuring'
  // Giving a "done" checkmark to a measurement that ended in error/abort would
  // be the worst lie: there is no measured result. These are `none`s, so the
  // row can be remeasured.
  if (entry.error !== null && entry.error !== undefined) return 'none'
  if (entry.aborted === true) return 'none'
  if (entry.value === null || entry.value === undefined) return 'none'
  return anchorsEqual(entry.anchor, anchor) ? 'fresh' : 'stale'
}

/**
 * A PR's state for the list. The default slot is `diagnosis` — the list
 * indicator speaks about this measurement (the review report has its own
 * separate indicator: the review trace).
 */
export function cacheState(cache, pr, anchor, slot = 'diagnosis') {
  return cacheEntryState(cacheGet(cache, pr, slot), anchor)
}

/**
 * Marking a REVIEW TRACE: a review ran on this PR in THIS SESSION.
 *
 * THE LIMITATION STATED PLAINLY: the hunk session is REPO-scoped, not
 * PR-scoped (`hunk session comment list --repo <root>`), so the "which PR
 * does a comment belong to" information CANNOT be queried from hunk. WE keep
 * track of this ourselves — and we only know what WE started. A comment
 * written in a previous session (or by hand from the hunk CLI) does NOT show
 * up as a trace. docs/next.md states this: we can't act as if we know
 * something we don't.
 */
export function markReviewTrace(cache, pr, source) {
  if (!REVIEW_TRACE_SOURCES.has(source)) {
    throw new Error(
      `unknown review-trace source: ${JSON.stringify(source)} — valid: ${[...REVIEW_TRACE_SOURCES].join(', ')}`,
    )
  }
  const set = cache.reviewTrace.get(pr) ?? new Set()
  set.add(source)
  cache.reviewTrace.set(pr, set)
  return cache
}

/** Whether there's a review trace started IN THIS SESSION on this PR. */
export function hasReviewTrace(cache, pr) {
  return (cache.reviewTrace.get(pr)?.size ?? 0) > 0
}

/**
 * The TRACE's SOURCES on this PR, in DETERMINISTIC order.
 *
 * WHY THIS IS NEEDED BESIDE `hasReviewTrace`'s boolean: the attestation body
 * names the PROVENANCE ("claude -p AI review" vs. "hunk inline review"), and
 * this text goes into the PR's AUDIT TRAIL. A raw `Set`'s iteration order is
 * INSERTION order, so the same two traces (ai + hunk) in a different order
 * would produce a different body — audit text that changes run to run,
 * pointless diff noise. We filter against REVIEW_TRACE_SOURCES's declared
 * order, which is fixed.
 */
export function reviewTraceSources(cache, pr) {
  const set = cache?.reviewTrace?.get(pr)
  if (!set || set.size === 0) return []
  return [...REVIEW_TRACE_SOURCES].filter((s) => set.has(s))
}

/**
 * The cache state's LIST INDICATOR — compact (1 cell) and DIMMED.
 *
 * The dimming follows the user's 3rd principle: "yellow is ONLY for genuine
 * warnings (cost, blockers)". The cache status is metadata about the
 * measurement, not a warning — not even stale: that doesn't signal an error,
 * just that a remeasure is needed.
 *
 * The `none` state returns `null`: we don't pad with emptiness.
 */
export function cacheIndicatorFlag(state) {
  const glyph = CACHE_GLYPHS[state]
  if (!glyph) return null
  return { label: glyph, color: 'gray' }
}

/**
 * The review trace's LIST INDICATOR. `null` without a trace (the default row
 * gets no mark).
 *
 * The COLOR is `whiteBright` — reached in TWO STEPS, from the user's
 * measurements: `gray` was "barely visible", and `cyan` "could be even more
 * vivid". `gray` is the color of METADATA indicators (cache status, stacked,
 * draft), and the review trace is NOT metadata: it says there IS something to
 * look at on this PR, which is the list's most action-worthy information.
 *
 * WHY `whiteBright`, AND NOT `white`: plain `white` is the terminal's DEFAULT
 * text color — a default-colored mark isn't "more vivid", just unmarked.
 * `whiteBright` is the bright ANSI variant (a chalk named color, passes Ink's
 * `colorize`'s `color in chalk` check), so it's ACTUALLY lighter than the
 * rest of the row's elements.
 *
 * THE COLOR FAMILIES ARE EXCLUDED: yellow belongs to genuine warnings (the
 * user's 3rd principle: cost, blockers), green to the approve column, cyan to
 * the dep- and can-approve indicators — white is the ONLY free, standout value.
 *
 * THE GLYPH IS UNCHANGED (`⊙`): a denser mark (e.g. `◉` U+25C9) would be more
 * eye-catching, but its WIDTH isn't measured — most of the geometric-shapes
 * block is "ambiguous width", which jumps to 2 cells in a CJK context. The
 * user reported the column-shift FOUR TIMES, and its root cause was exactly
 * someone guessing a glyph's width. We only swap a glyph AFTER measuring; the
 * color is free.
 */
export function reviewTraceFlag(has) {
  return has === true ? { label: REVIEW_TRACE_GLYPH, color: 'whiteBright' } : null
}


// --- The AI review's RESPONSE FINDINGS: the cache state machine's hybrid slice ---
//
// These used to live in the hybrid-findings section, but they manage cache
// state (the `cache.aiFindings` Map), so the cache module is their home.
/**
 * STORING the RESPONSE FINDINGS — keyed by PR, with the `applied` flag.
 *
 * SEPARATE from the measurement entries (`entries`) and the trace
 * (`reviewTrace`), because its nature is DIFFERENT: a finding is a PAID-FOR
 * FACT (the spend happened), not a measurement — it doesn't go stale when
 * main moves, and `R` can't drop it either. If `R` cleared it, the "review
 * ran, everything's lost" harm would recur from a reflexive refresh.
 */
export function cacheStoreAiFindings(cache, pr, findings) {
  if (!Array.isArray(findings)) {
    throw new Error(`response findings did not arrive as an array: ${JSON.stringify(findings)}`)
  }
  cache.aiFindings.set(pr, { findings, applied: false })
  return cache
}

/** The PR's stored response findings (`{ findings, applied }`), or null. */
export function cacheAiFindings(cache, pr) {
  return cache?.aiFindings?.get(pr) ?? null
}

/**
 * The load happened: the `applied` flag is set, AND the TARGET SESSION's
 * identifier is also recorded. THIS is the idempotency gate — but the gate is
 * tied to SESSION IDENTITY, not just to the PR (the user's 5/3 finding): the
 * hunk's `q` takes the session down with it, and `applied` would falsely say
 * "done" against a DEAD session — the new, empty session would go without a
 * load, and the notes would "disappear".
 *
 * NOT written when `sessionId` is null/undefined: the guard is fail-safe in
 * that case (doesn't duplicate — see answerFindingsNeedApply).
 */
export function cacheMarkAiFindingsLoaded(cache, pr, sessionId) {
  const cur = cache.aiFindings.get(pr)
  if (cur) {
    cache.aiFindings.set(pr, {
      ...cur,
      applied: true,
      ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
    })
  }
  return cache
}

/**
 * WHETHER TO LOAD the cached response findings on open — the PURE decision of
 * the guard tied to SESSION IDENTITY.
 *
 * THE FOUR BRANCHES, stated plainly:
 *   - no pending / empty findings → NO (nothing to load);
 *   - not yet applied → YES (the first load);
 *   - applied, and the recorded target session IS STILL ALIVE (same id) → NO
 *     — this is the "doesn't duplicate in a live session" invariant (a
 *     repeated Enter/r doesn't duplicate either);
 *   - applied, but the target session HAS ENDED or ANOTHER session is live →
 *     YES: the notes aren't there in the new session, so we reload them from
 *     the copy (the user's 5/3 finding — a repeated `r` produced an empty
 *     review).
 *
 * FAIL-SAFE BRANCH: applied, but NO recorded sessionId (the session list
 * wasn't measurable at load time) → we do NOT reload. Of the two failure
 * directions, duplication is worse (the user would see the same finding
 * TWICE in the hunk, and the upload would carry it up twice too); skipping
 * at worst leaves the old, known behavior.
 */
export function answerFindingsNeedApply(pending, liveSessionId) {
  if (!pending || !Array.isArray(pending.findings) || pending.findings.length === 0) return false
  if (pending.applied !== true) return true
  if (typeof pending.sessionId !== 'string' || pending.sessionId === '') return false
  return pending.sessionId !== liveSessionId
}

/**
 * EXPLICIT DISCARD of cached AI findings (the second press of double-`x`).
 *
 * Drops ONLY the findings — the REVIEW TRACE (reviewTraces) STAYS: the review
 * happened and the spend is a real fact, the discard only clears up the
 * result instance. This very discard is the precondition for restarting (see
 * `r`'s lifecycle): deliberate friction against accidental double-spending.
 */
export function cacheDiscardAiFindings(cache, pr) {
  cache?.aiFindings?.delete(pr)
  return cache
}

/**
 * PRs carrying PAID-FOR response findings that are NOT YET LOADED.
 *
 * NOTE — HAS NO CONSUMER IN THE TUI TODAY (wf31/9). Originally it was the
 * exit guard's input (silent-loss-1): back then the findings cache lived
 * ONLY in process memory, so a silent `q` really did discard the paid-for
 * result. Since the disk cache (review-store), this no longer holds: the
 * findings are saved to `/tmp` and PERSIST, and startup reads them back — so
 * the guard was no longer preventing loss, just reporting on the cache's
 * operation. Per the user's decision the cache is an automatic default that
 * needs no announcement, so the pending branch was retired.
 *
 * WHY IT STAYS ANYWAY: it's a clean, tested selector over cache state ("is
 * there unfinished, paid-for work"), which may get a future consumer (e.g. a
 * summary indicator in the header). Worth deleting once that doesn't
 * materialize.
 *
 * `applied !== true` plus non-empty findings is the yardstick: the applied
 * instance is already in the hunk (or the session-identity guard decides on
 * it at open time), and an empty list isn't a loss.
 */
export function cacheUnappliedAiFindingPrs(cache) {
  const out = []
  for (const [pr, v] of cache?.aiFindings?.entries?.() ?? []) {
    if (v?.applied !== true && Array.isArray(v?.findings) && v.findings.length > 0) out.push(pr)
  }
  return out
}
