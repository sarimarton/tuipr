// tuipr — POLL: the background staleness-check state machine (ONLY SIGNALS,
// doesn't reload) + the staleness signature + the gh probes + the header line.
//
// LAYER ORDER: imports downward (layout: the header's degradation measured in
// CELLS; proc: the probes' spawn and the main SHA). Imports NOTHING from core
// or above — the reasoning for the cycle ban is in bin/tui-core.mjs's header.
//
// THE MODULE-LEVEL INVARIANT that test/next-poll.test.ts measures across the
// ENTIRE file: `fetchQueue` cannot be called from here, and the reducers are
// I/O-free (only fetchStalenessProbe may spawn). The poll SIGNALS, reloading
// is the user's decision.
import { clampCells, displayWidth } from './layout.mjs'
import { fetchMainSha, fetchMainShaAsync, spawnCollect, spawnFailure } from './proc.mjs'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

// === POLL: background staleness check (ONLY SIGNALS, doesn't reload) =======
//
// THE PROBLEM: the list sitting on screen silently ages. While the user is
// reviewing a PR, the queue can shift (someone pushes, a PR lands, main
// moves forward) — and the decision (approve / merge) gets made on a stale
// picture. The header's timestamp (task 1) says WHEN we loaded; this section
// says whether something has CHANGED SINCE THEN.
//
// THE MOST IMPORTANT DESIGN DECISION — THE POLL ONLY SIGNALS, IT DOESN'T
// RELOAD: the user's stated argument was that "the cursor re-shuffling is
// dangerous at the worst possible moment (right when you're about to press
// `y`)". A poll that reloads itself would swap the list's order (and thus the
// selected row) AT THE MOMENT OF THE DECISION: the user, looking at #911,
// would press `y` and merge #905 instead. This state machine therefore does
// NOT PRODUCE ANY OUTPUT that reloading could follow from — only a `stale`
// flag, which the header signals, and which the user answers with `R`. A test
// guards the module-level invariant (`fetchQueue` cannot be called from here).
//
// THE COST, MEASURED (not guessed), on real <org> repos, 3 runs each:
//   - `gh pr list --json number,updatedAt` (38 open PRs):  519 / 681 / 724 ms, 1.9 KB
//   - `gh api repos/.../commits/main -q .sha`:               463 / 461 / 514 ms
//   - the FULL `tuipr queue --json` (the reference):    1765 / 1876 ms
// So the probe is ~10-25% of a full reload, and the PR count barely moves it
// (the cost is the round trip, not the payload). LEAVING OUT the
// `files`/`statusCheckRollup` FIELDS is load-bearing: with them the probe
// would cost as much as the reload, and then it would be pointless — a test
// forbids their inclusion.
//
// WHY THE PAIR OF `gh pr list` (list-based) AND LOCAL `git rev-parse`, not
// `gh api commits/main`: the main side is ALREADY read locally by
// `fetchMainSha` (half of the cache anchor), so it's free and gives the same
// reference the cache uses. Two separate main sources (a local ref for the
// cache, the GitHub API for the poll) could CONTRADICT each other: the poll
// would signal "stale" for a shift the cache anchor never even saw, because
// the local ref hadn't been fetched yet — the user would press `R` in vain,
// and the signal wouldn't go away.

/** The poll interval. The user's stated range: 90-120 s. */
export const POLL_INTERVAL_MS = 100_000

/**
 * THE IDLE-STOP THRESHOLD. The user's argument: "so a forgotten TUI doesn't
 * poll overnight". Not a runtime optimization, but HYGIENE: a TUI left open
 * would otherwise hammer the GitHub API for days over a list nobody's
 * looking at.
 */
export const POLL_IDLE_TIMEOUT_MS = 15 * 60_000

/**
 * THE BACKOFF LADDER after a network error.
 *
 * WHY NOT DENSER than the base interval (a test guards this too): the ODDS
 * that a network error means the next probe will also fail are HIGH — a
 * tighter retry in that case just means more failed calls, not an earlier
 * success. The ladder STOPS at the end (doesn't grow unboundedly): on a
 * persistently offline machine the 20-minute cadence is already sparse
 * enough, while it still notices the network's return within a reasonable
 * time.
 */
export const POLL_BACKOFF_MS = [POLL_INTERVAL_MS * 2, POLL_INTERVAL_MS * 6, POLL_INTERVAL_MS * 12]

/**
 * After this many CONSECUTIVE failed probes we signal that we cannot verify
 * staleness.
 *
 * WHY NOT IMMEDIATELY (1 failure): a momentary network hiccup (VPN switch,
 * waking from sleep) is routine, and warning on every one of those would
 * teach the user to ignore the signal. WHY NOT MUCH LATER: a silent "all
 * good" is a lie — if we can't verify, that must be stated before the user
 * bases a decision on an hour-old stale picture.
 */
export const POLL_FAILURES_BEFORE_WARNING = 3

/**
 * THE POLL STATE. Plain data; every stepping function returns a new object.
 *
 * `signature`   — the signature of the last KNOWN picture (what we measure
 *                 against);
 * `lastInputAt` — the time of the last user input (gate (c));
 * `nextDueAt`   — the earliest time for the next probe;
 * `failures`    — count of CONSECUTIVE failed probes;
 * `unverifiable`— whether we signal that we cannot verify;
 * `stale`       — we MEASURED that the picture shifted.
 *
 * `stale` and `unverifiable` are SEPARATE fields, because they are SEPARATE
 * claims: one is a FACT (we measured the shift), the other is an ABSENCE OF
 * KNOWLEDGE. Folded into one field, one of them would be a lie.
 */
export function pollInit({ now = 0, signature = null } = {}) {
  return {
    signature,
    lastInputAt: now,
    nextDueAt: now + POLL_INTERVAL_MS,
    failures: 0,
    unverifiable: false,
    stale: false,
    lastError: null,
  }
}

/**
 * USER INPUT arrived: gate (c)'s clock restarts.
 *
 * WAKING FROM IDLE happens here, and RESCHEDULING `nextDueAt` is
 * load-bearing: if we only set `lastInputAt`, then after an overnight break
 * the first keypress would fire off a probe IMMEDIATELY (`nextDueAt` is long
 * past) — right at the moment the user starts working. Waking up therefore
 * grants a FULL interval: the poll stays in the background, not in the way.
 */
export function pollNoteInput(st, { now = 0 } = {}) {
  const idle = now - st.lastInputAt > POLL_IDLE_TIMEOUT_MS
  return {
    ...st,
    lastInputAt: now,
    // We only reschedule when WAKING from idle. A plain keypress (not idle)
    // must NOT push the probe out, otherwise the poll would NEVER run for an
    // actively typing user — continuous input would postpone it forever.
    nextDueAt: idle ? now + POLL_INTERVAL_MS : st.nextDueAt,
  }
}

/**
 * THE THREE GATES. `null` = all open (the poll may run), otherwise the
 * CLOSING reason.
 *
 * THE ORDER IS DETERMINISTIC (overlay → measuring → idle): if more than one
 * gate is closed, the same reason shows every run. Without this the status
 * text would vary run to run, and a bug report wouldn't be reproducible.
 */
export function pollGateReason(st, { overlayOpen = false, measuring = false, now = 0 } = {}) {
  // (a) An open dialog/overlay: the focus is on the decision. The poll must
  // not interrupt — neither in the header (draws attention away) nor via I/O
  // (slows things down).
  if (overlayOpen) return 'overlay'
  // (b) A running measurement/review: the measurement's result is about to
  // go into the cache, so the "stale" signal would be misleading; plus a
  // concurrent gh call would slow down what the user is WAITING for.
  if (measuring) return 'measuring'
  // (c) Idle: no recent user input. The boundary is STILL open (`>`, not
  // `>=`) — the exact boundary could swallow a whole interval.
  if (now - st.lastInputAt > POLL_IDLE_TIMEOUT_MS) return 'idle'
  return null
}

/**
 * Is a probe due NOW. The gates AND the schedule decide together.
 *
 * A CLOSED GATE ONLY DELAYS, IT DOESN'T SKIP: we do NOT step `nextDueAt`
 * while closed, so due-ness STILL HOLDS after a long overlay session, and it
 * fires immediately when the gate opens. Without this, after 10 minutes of
 * browsing info panels the user would get no staleness signal for hours.
 */
export function pollDue(st, { overlayOpen = false, measuring = false, now = 0 } = {}) {
  if (pollGateReason(st, { overlayOpen, measuring, now }) !== null) return false
  return now >= st.nextDueAt
}

/**
 * The result of a SUCCESSFUL probe.
 *
 * `changed` EXCLUSIVELY sets the `stale` flag — neither a reload nor a
 * cache invalidation follows from it (see the section head).
 *
 * `stale` IS ONE-WAY: once we've measured the shift, the NEXT probe (which
 * already sees the NEW signature as "unchanged") does NOT clear it. The
 * user's picture keeps showing the OLD state — only a real reload
 * (`R` → fresh `pollInit`) removes the signal. This is a measured trap
 * class: an "appeared, then vanished on its own" warning is worse than none.
 */
export function pollProbeResult(st, { changed = false, signature = null, now = 0 } = {}) {
  return {
    ...st,
    signature: signature ?? st.signature,
    nextDueAt: now + POLL_INTERVAL_MS,
    failures: 0,
    unverifiable: false,
    lastError: null,
    stale: st.stale || changed === true,
  }
}

/**
 * The FAILED probe. Retries silently (backoff), and only signals after
 * POLL_FAILURES_BEFORE_WARNING consecutive failures.
 *
 * We KEEP the raw error text (`lastError`) for diagnostics, but we do NOT
 * put it into the header's signal: a multi-line gh/TLS stderr would tear the
 * header apart (this project's four-times-reported wrapping error class).
 */
export function pollFailure(st, { now = 0, message = null } = {}) {
  const failures = st.failures + 1
  // The ladder STOPS at the end: `min` clamps the index, so the wait sticks
  // at the largest step, it doesn't grow unboundedly.
  const step = POLL_BACKOFF_MS[Math.min(failures - 1, POLL_BACKOFF_MS.length - 1)]
  return {
    ...st,
    nextDueAt: now + step,
    failures,
    unverifiable: failures >= POLL_FAILURES_BEFORE_WARNING,
    lastError: message === null || message === undefined ? st.lastError : String(message),
  }
}

/**
 * The HEADER SIGNAL's text. Empty string = no signal.
 *
 * THE GOOD CASE IS SILENT: a fresh picture gets NO signal. "All good" IS the
 * ABSENCE of a signal — a "fresh ✓" label in every header would just be
 * noise, and it would make the real signal harder to spot.
 *
 * PRIORITY OF THE TWO CLAIMS: MEASURED staleness is stronger than
 * unverifiability. Once we've measured that it shifted, that's information
 * calling for action (`R`) — the fact that we can't re-verify since then
 * doesn't change that.
 */
export function pollStatusLabel(st) {
  if (!st) return ''
  if (st.stale === true) return '⟳ stale — R: refresh'
  if (st.unverifiable === true) return '⚠ staleness not verifiable — R: refresh'
  return ''
}

/**
 * THE PICTURE'S SIGNATURE: the queue's PR set + per-PR `updatedAt` + the
 * main SHA.
 *
 * ALL THREE are in it, because there are THREE DIFFERENT classes of shift,
 * and none can be derived from the others:
 *   1) a PR's CONTENT changed (push, rebase, comment) → `updatedAt`;
 *   2) the queue's MEMBERSHIP changed (a new PR came in, one landed) → the
 *      number set;
 *   3) main MOVED FORWARD → the SHA. This does NOT move the PRs'
 *      `updatedAt`, yet it invalidates the merge-tree diagnoses.
 *
 * ORDER INDEPENDENCE is load-bearing: `gh pr list`'s order is not stable
 * (the API's order is not guaranteed for identical timestamps), and an
 * order-sensitive signature would signal FALSE staleness. A false positive
 * is the most expensive damage here: the user would learn to ignore the
 * signal, and then they'd also skim past the REAL staleness. That's why we
 * sort by PR number.
 */
export function stalenessSignature({ prs = [], mainSha = null } = {}) {
  const parts = (Array.isArray(prs) ? prs : [])
    .map((p) => `${p?.number ?? '?'}@${p?.updatedAt ?? ''}`)
    .sort()
  // The ABSENCE of a main SHA is an EXPLICIT marker, not an empty string:
  // without this a missing SHA and a SHA that resolved to empty would give
  // the same signature, so main's movement would stay invisible.
  // (fetchMainSha follows the same principle: null, not "".)
  const sha = typeof mainSha === 'string' && mainSha !== '' ? mainSha : '(nincs-main-sha)'
  return `${sha}|${parts.join(',')}`
}

/**
 * Has the picture shifted. FAIL-CLOSED AGAINST FALSE POSITIVES: if either
 * signature is missing, we report NO change.
 *
 * WHY THIS DIRECTION (it's the reverse at the cache!): there a false "fresh"
 * was the expensive mistake (a merge based on a stale diagnosis), so there a
 * missing anchor NEVER matches. Here a false "stale" is the expensive one:
 * every session start would produce a baseless warning (nothing to measure
 * against), and the user would learn to skim past the signal. "I have no
 * measurement" here is NOT staleness — the measurement error is carried by
 * the `pollFailure` branch, which, after N failures, EXPLICITLY STATES that
 * it cannot verify. So the silence isn't mute: the other branch speaks for
 * it.
 */
export function stalenessChanged(prev, next) {
  if (typeof prev !== 'string' || prev === '') return false
  if (typeof next !== 'string' || next === '') return false
  return prev !== next
}

/**
 * THE CHEAP PROBE: the queue's PR set + the main SHA → signature.
 *
 * NEVER THROWS: the poll is a background process, a throw in the React
 * effect would end up as an unhandled rejection. It returns the error
 * STRUCTURED (`{ ok: false, error }`), and the caller steps the state with
 * `pollFailure`.
 *
 * FAIL-CLOSED ON EVERY BRANCH (a lesson this project learned the hard way):
 * we check both `res.status` AND `res.error?.code` (ENOENT), parse the JSON,
 * and catch a NON-ARRAY response (`gh` writes `null` with exit 0 on a
 * partial GraphQL error!) on a separate, LOUD branch. The most expensive
 * silent failure here would be giving an empty signature for a failed call:
 * `stalenessChanged` would see that as "unchanged", and the poll would show
 * "all good" FOREVER while never having verified anything.
 */
export function fetchStalenessProbe({ label = process.env.NEXT_WORK_NEXT || 'next' } = {}) {
  const parsed = parseStalenessListResult(spawnSync('gh', stalenessProbeArgs(label), { encoding: 'utf8' }))
  if (!parsed.ok) return { ok: false, error: parsed.error }
  // A missing main SHA does NOT fail the probe (fresh clone, no remote ref),
  // but it goes into the signature as an EXPLICIT marker — see
  // stalenessSignature.
  return { ok: true, signature: stalenessSignature({ prs: parsed.prs, mainSha: fetchMainSha() }), error: null }
}

/**
 * (wf31/44) THE STATE OF THE NEXT-REBUILD — for the header's freshness
 * signal.
 *
 * WHY THIS IS NEEDED IN THE TUI: bash `cmd_queue` writes the rebuild status
 * to the SHELL (`Next rebuild: success (…)`), which IMMEDIATELY GETS LOST in
 * fullscreen mode — the TUI enters the alt-screen, and the line stays in the
 * primary buffer. The user's question was exactly this: "shouldn't this
 * show up in the fullscreen too?"
 *
 * WHY A SEPARATE PROBE, AND NOT A FIELD ON `queue --json`: `QUEUE_MODEL` is
 * an ARRAY (the list of PRs), not an object — a rebuild field could only be
 * spliced in there by breaking the contract (`--json` consumers, including
 * the Claude skill, expect an array). `fetchStalenessProbe` already gives an
 * established pattern: the TUI asks over its own measurement channel, the
 * bash path stays untouched.
 *
 * ONLY THE NON-`success` STATE IS INTERESTING (the user's call): we don't
 * announce a successful rebuild — the same principle as the poll signal
 * (`⟳ stale`), where the good state is the ABSENCE of a signal. A fifth
 * permanent header segment would crowd out something else on a narrow
 * terminal.
 *
 * FAIL-SOFT ON EVERY PATH: no `gh`, no permission, corrupted JSON → `null`,
 * and the header simply gets no signal. We don't fail the list for the sake
 * of a rebuild status.
 */
export function fetchRebuildStatus({ workflow = 'next-rebuild.yml' } = {}) {
  const res = spawnSync('gh', [
    'run', 'list', '--workflow', workflow, '--limit', '1',
    '--json', 'conclusion,status,updatedAt',
  ], { encoding: 'utf8' })
  if (res.error || res.status !== 0) return null
  let runs
  try {
    runs = JSON.parse(res.stdout || '[]')
  } catch {
    return null
  }
  if (!Array.isArray(runs) || runs.length === 0) return null
  const run = runs[0]
  // `conclusion` is a COMPLETED run's result, `status` is an in-progress
  // one's. The order is a COPY of the bash path
  // (`.[0].conclusion // .[0].status`) — the two places cannot drift apart,
  // because they describe the same fact.
  const state = run?.conclusion || run?.status || ''
  if (state === '' || state === 'success') return null
  return { state, at: typeof run?.updatedAt === 'string' ? run.updatedAt : '' }
}

/** The probe's argv in ONE place — the sync and async paths cannot drift apart. */
function stalenessProbeArgs(label) {
  return ['pr', 'list', '--state', 'open', '--label', label, '--limit', '200', '--json', 'number,updatedAt']
}

/** The ONE parser for gh pr list → { ok, prs } or { ok: false, error }. */
function parseStalenessListResult(res) {
  const spawnErr = spawnFailure(res, 'gh')
  if (spawnErr) return { ok: false, error: spawnErr }
  if (res.status !== 0) {
    return {
      ok: false,
      error: `gh pr list error (exit ${res.status}): ${(res.stderr || res.stdout || '').trim() || '(no output)'}`,
    }
  }
  let prs
  try {
    prs = JSON.parse(res.stdout)
  } catch (error) {
    return { ok: false, error: `gh pr list's output cannot be parsed as JSON: ${error.message}` }
  }
  // A `null`/object response is NOT an "empty queue": that's a contract
  // violation. An EMPTY ARRAY, however, is a legitimate state (no open
  // next-PR) — the bash side also separates the two
  // (`jq 'if type == "array"'`).
  if (!Array.isArray(prs)) {
    return { ok: false, error: `unexpected gh pr list response (not an array): ${JSON.stringify(res.stdout).slice(0, 200)}` }
  }
  return { ok: true, prs }
}

/**
 * The ASYNC counterpart of fetchStalenessProbe — BYTE-FOR-BYTE the same
 * signature and error contract (shared parser and argv), with a free event
 * loop. This is what provides the poll basis for the background reload
 * after a hunk closes (5/2).
 */
export async function fetchStalenessProbeAsync({ label = process.env.NEXT_WORK_NEXT || 'next' } = {}) {
  const parsed = parseStalenessListResult(await spawnCollect('gh', stalenessProbeArgs(label)))
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, signature: stalenessSignature({ prs: parsed.prs, mainSha: await fetchMainShaAsync() }), error: null }
}

/**
 * Assembling the HEADER LINE, measured and DEGRADED in DISPLAY CELLS.
 *
 * WHY A PURE FUNCTION, not string concatenation in the render tree: the
 * header carries several elements (title, load timestamp, core SHA, poll
 * signal, notice), and this project's four-times-reported error class is
 * exactly that an added element wraps on a narrow terminal. This way the
 * behavior is unit-testable across the whole columns range, not just in a
 * live render.
 *
 * THE ORDER OF DEGRADATION is a design decision — the least important drops
 * out first:
 *   1) the CORE SHA,
 *   2) the load timestamp,
 *   3) the title's shortened form,
 * and the POLL SIGNAL STAYS LONGEST: that's the information calling for
 * ACTION. A header that shows the title but drops the "stale" signal loses
 * exactly what the user looks at it for.
 *
 * (wf31/28) THE `R: refresh` HINT IS NO LONGER IN THE HEADER: the legend
 * (KEYS) below always advertises it, so the header instance was a
 * duplication (user finding: "it shows up in two places, top and bottom.
 * Bottom is enough").
 *
 * The SHA, however, stays BEHIND the LOAD TIMESTAMP and the POLL SIGNAL: the
 * SHA is SESSION-CONSTANT (once read the user knows what they're running),
 * whereas the timestamp and the signal are VARIABLE, information about the
 * CURRENT work that must be read repeatedly. A constant can be lost on a
 * narrow terminal; a variable cannot.
 *
 * When `coreSha` is NULL/EMPTY the segment IS DROPPED — no "unknown", no
 * dangling separator (`filter` discards it before the join). See
 * fetchCoreSha's head: a lying segment is more expensive than a missing one.
 */
/**
 * @param {object} [opts]
 * @param {string} [opts.notice] (wf31/23) THE RIGHT-ALIGNED FEEDBACK — action
 *   results (`#895: merged`) and input responses (`aborted`).
 *
 *   THE USER'S DECISION: the global status line at the BOTTOM of the screen
 *   was removed ("looks silly down there anyway"), and these short feedback
 *   messages moved into the HEADER, RIGHT-ALIGNED. The pending signal does
 *   NOT belong here: that moved next to the triggering legend
 *   (contextually, next to the key).
 *
 *   WHY RIGHT, AND WHY NOT ANOTHER `SEP` SEGMENT: the header's left side is
 *   CONSTANT (title · timestamp · SHA) — the eye reads system identity
 *   there. Text that VARIES per action in the same array would SHIFT the
 *   left-side segments after every action, so even the stable part wouldn't
 *   be stable. Right-aligned, the two information classes also separate
 *   typographically.
 *
 *   THE DEGRADATION ORDER IS REVERSED from the left side: when there's no
 *   room, the NOTICE drops FIRST, not the title/SHA. Reason: the notice is
 *   EPHEMERAL (the next action overwrites it), whereas the SHA is the
 *   screen's only place where the running code's identity appears — this is
 *   the same principle already stated at the `R: refresh` eviction.
 */
export function headerLine({
  loadedAt = null,
  coreSha = null,
  pollLabel = '',
  columns = 80,
  notice = '',
  // (wf31/44) THE REBUILD SIGNAL: `{ state, at }` or `null` (nothing to
  // signal). `fetchRebuildStatus` returns ONLY the non-`success` state, so
  // `null` is the NORMAL case — we don't announce the good state.
  rebuild = null,
} = {}) {
  const limit = Math.max(0, Math.floor(columns))
  const note = typeof notice === 'string' ? notice.trim() : ''
  // (wf31/44) TWO SPACES AFTER THE EM DASH — TYPOGRAPHIC, NOT A CELL ISSUE.
  //
  // The user's finding: "there should be a space after the em dash before
  // 'review workstation'". The source DID have a space (`— r`, codepoints:
  // 2014 20 72 — measured), and `displayWidth` also gives 1 cell for the em
  // dash. Yet on screen it reads `—review`: the font draws the em dash at
  // the FULL WIDTH OF THE CELL (often even overflowing it), so the
  // neighboring space is optically SWALLOWED.
  //
  // THE FIX IS A SECOND SPACE, not a narrower dash: `–` (en dash) or `-`
  // would fix the rendering, but the title would take on a DIFFERENT
  // typographic weight — the em dash is the established "title — subtitle"
  // form. The cell arithmetic stays intact: `displayWidth` also measures the
  // space as 1, so the degradation (candidate list) counts correctly.
  const TITLE = 'tuipr —  review workstation'
  const SHORT_TITLE = 'tuipr'
  const SEP = '  ·  '
  const label = typeof pollLabel === 'string' ? pollLabel : ''
  // DURING LOADING THE HEADER IS ONLY THE TITLE + SHA (user request): the
  // `loading…` in the header DUPLICATED the standalone loading label below
  // it, and `R: refresh` referenced a list that DIDN'T EXIST YET — both were
  // noise.
  const loading = !loadedAt
  const stamp = loadedAt ? `loaded: ${loadedAt}` : ''
  // AN ALL-WHITESPACE SHA also counts as "no SHA": on the
  // `.source-sha`/`package.json` path a whitespace-only file content would
  // otherwise give a silent, empty segment (" core  ·").
  const sha = typeof coreSha === 'string' && coreSha.trim() !== '' ? `core ${coreSha.trim()}` : ''
  // (wf31/44) THE REBUILD SIGNAL SEGMENT. The TEXT form `⚠` (1 cell —
  // measured), not the emoji `⚠️` (2 cells): the project's stated decision
  // that cell arithmetic must not drift (see `rows.mjs`'s flag chapter).
  //
  // THE TIMESTAMP IS SHORTENED: the full ISO stamp (`2026-08-05T02:30:16Z`)
  // is 20 cells, double the header's narrowest segments. DATE+HOUR is enough
  // for the decision ("how current is the picture?"), the seconds are not —
  // this is the same compression the `loaded:` segment also applies (there
  // HH:MM:SS, because it's TODAY).
  const rebuildNote = rebuild && typeof rebuild.state === 'string' && rebuild.state !== ''
    ? `⚠ rebuild: ${rebuild.state}${typeof rebuild.at === 'string' && rebuild.at !== '' ? ` (${rebuild.at.slice(0, 16).replace('T', ' ')})` : ''}`
    : ''

  // THE CANDIDATES from richest to narrowest. The FIRST one that fits in
  // CELLS wins. The list is explicit (not machine combinatorics): the
  // degradation order is a DESIGN decision, and this way it stays readable
  // too.
  const candidates = loading
    ? [
        // While loading: title + SHA (+ poll signal, if any). No stamp, no refresh.
        [TITLE, sha, label],
        [TITLE, sha],
        [SHORT_TITLE, sha],
        [TITLE],
        [SHORT_TITLE],
      ]
    : [
    // (wf31/28) THE `R: refresh` HINT REMOVED FROM THE HEADER — the user's
    // request: "'R: refresh' now shows up in two places, top and bottom.
    // Bottom is enough."
    //
    // THE LEGEND (KEYS) BELOW ALWAYS ADVERTISES IT, so the header instance
    // was pure duplication. The earlier reasoning (the SHA stands BEFORE the
    // hint, because the hint also exists elsewhere) ALREADY CONTAINED THIS
    // CONCLUSION — it just stopped halfway: if the hint also exists
    // elsewhere, then it doesn't just need to go BEHIND the SHA, it can be
    // dropped entirely. Its spot goes to `notice` (right-aligned).
    // THE REBUILD SIGNAL comes AFTER the SHA, BEFORE the poll signal: both
    // are FRESHNESS information, but the poll states the PICTURE's
    // staleness (which `R` cures), while the rebuild states the NEXT
    // BRANCH's (which CI cures). The poll stays longest — that's the
    // directly action-calling signal.
    [TITLE, stamp, sha, rebuildNote, label],
    [TITLE, stamp, sha, label],
    [TITLE, stamp, rebuildNote, label],
    [TITLE, stamp, label],
    [TITLE, label],
    [SHORT_TITLE, label],
    // The signal ALONE: the narrowest branch, where even the title is lost.
    // If there's a signal, it's more important than the title (the user
    // knows what program they're looking at).
    [label],
    [TITLE, stamp],
    [TITLE],
    [SHORT_TITLE],
  ]
  // (wf31/23) RIGHT-ALIGNING THE NOTICE. `GAP` is the minimum gap between the
  // left-side block and the notice — without it, on a narrow terminal the two
  // would RUN TOGETHER, producing an unreadable line like
  // `…core abc123aborted`.
  const GAP = 2
  const noteRoom = note === '' ? 0 : displayWidth(note) + GAP
  const render = (parts) => parts.filter((p) => typeof p === 'string' && p !== '').join(SEP)
  // (wf31/27) TWO FULL PASSES, NOT A PER-CANDIDATE BRANCH.
  //
  // The per-candidate form was a MEASURED bug (from the user's finding: `20
  // PRs in the queue` did NOT show up): the loop accepted the line WITHOUT
  // the notice at the FIRST candidate, so it NEVER reached the narrower
  // candidates. On a 100-cell table the `[title·timestamp·SHA·R: refresh]`
  // form is 87 cells, the notice is +19 → doesn't fit; without the notice,
  // though, it fits, and the loop stopped right there. So the notice was
  // lost even when it WOULD HAVE FIT alongside a NARROWER left side (e.g.
  // without `R: refresh`).
  //
  // THE FIRST PASS: EVERY candidate with the notice. Degradation this way
  // narrows the left side so the notice fits — giving exactly the order the
  // user asked for (the label at the edge of the table).
  //
  // THE SECOND PASS: without the notice. We only reach this if the notice
  // doesn't fit alongside a SINGLE left-side form — in that case the
  // title/SHA wins, because the notice is EPHEMERAL (the next action
  // overwrites it), whereas system identity is not.
  if (noteRoom > 0) {
    for (const parts of candidates) {
      const line = render(parts)
      if (line === '') continue
      if (displayWidth(line) + noteRoom <= limit) {
        const pad = limit - displayWidth(line) - displayWidth(note)
        return `${line}${' '.repeat(Math.max(GAP, pad))}${note}`
      }
    }
  }
  for (const parts of candidates) {
    const line = render(parts)
    if (line === '') continue
    if (displayWidth(line) <= limit) return line
  }
  // Nothing fit (an extremely narrow terminal): we truncate the TITLE in
  // cells. clampCells also correctly handles the VS16 lookahead (see its
  // head).
  return clampCells(label !== '' ? label : SHORT_TITLE, limit)
}
