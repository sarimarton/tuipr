// The Ink (React) layer for the review workstation.
//
// Kept in a separate module from the pure logic (tui-core.mjs), so the
// unit tests can run without an installed ink/react — the tests import
// only the pure functions, and this file loads ONLY at TUI startup.
//
// WARNING: this module imports from CORE, never from the entry point
// (tui.mjs). A back-import would create a circular ESM cycle, which would
// deadlock the entry's top-level await (exit 13, empty output) — see the
// detailed writeup in the core's file head. test/next-tui.test.ts checks as a
// static invariant that this import never slides back in.
//
// React is deliberately written here with `createElement`, not JSX: the
// bin/*.mjs scripts in this repo run directly with `node`, without a build
// step (see claude-sdk.mjs), so introducing a JSX transform is not viable.

import { spawnSync } from 'node:child_process'
import process from 'node:process'
import tty from 'node:tty'
import { EventEmitter } from 'node:events'

import { Box, render, useApp, useInput, useWindowSize } from 'ink'
import React, { createElement as h, useCallback, useEffect, useState } from 'react'

import {
  denialMessage,
  aiReviewBlockers,
  aiReviewBudgetState,
  // Model selection (5b): env starting value, cyclic switcher, visible row.
  aiReviewModelState,
  modelStep,
  // BACKGROUND-REVIEW VISIBILITY (#904): the progress indicator and the SEVEN end states.
  AI_REVIEW_TIMEOUT_MS,
  aiReviewAgentAdditions,
  aiReviewOutcome,
  aiReviewPanelLines,
  aiReviewSummary,
  // The HYBRID FINDINGS layer (dual bookkeeping): answer parsing, PR-keyed
  // findings cache, and the batch-load on hunk-open.
  answerFindingsNeedApply,
  applyAnswerFindings,
  cacheAiFindings,
  cacheMarkAiFindingsLoaded,
  cacheStoreAiFindings,
  hunkLiveSessionId,
  // The `r` LIFECYCLE KEY + the DOUBLE-`x` (the user's 4th live test): r
  // is state-dependent (start / running / open), x gets a two-press
  // confirmation (abort on a running review, discard on a finished one), the
  // footer label is state-dependent.
  aiReviewLifecycle,
  cacheDiscardAiFindings,
  rKeyLabel,
  parseAnswerFindings,
  approveBody,
  budgetStep,
  budgetToggle,
  buildInfoModel,
  // (wf31/56) The FADE's pure computations (layout.mjs): the color
  // interpolation and the scheduler step. The render side only REQUESTS the
  // color, it doesn't compute.
  fadeProgress,
  queryTerminalColors,
  buildRows,
  // (wf31/35) For the HARD CLIPPING OF THE HEADER (measures in cells, never
  // cuts an emoji in half).
  clampCells,
  // (wf31/45) For the cell-measured gap of the right-aligned pending label.
  displayWidth,
  cacheAnchor,
  modalChoiceStep,
  modalHasChoices,
  MODAL_CHOICES,
  panelClose,
  panelFooter,
  panelKeys,
  panelOpen,
  panelSections,
  panelToInline,
  panelToModal,
  panelViewport,
  cacheEntryState,
  cacheGet,
  cacheInvalidateAll,
  cacheMarkMeasuring,
  cachePut,
  cacheState,
  claudePath,
  clipBodyLines,
  confirmAccepts,
  createCache,
  fetchMainSha,
  fetchMainShaAsync,
  fetchPrFiles,
  fetchPrRefs,
  fetchQueue,
  fetchQueueAsync,
  fetchStalenessProbeAsync,
  fetchRepoRoot,
  // (1a) The short identifier of the loaded core for the header — MEMOIZED, so
  // it can be called from the render (the spawn runs ONCE per session lifetime).
  fetchCoreSha,
  hasReviewTrace,
  headerLine,
  hunkComments,
  probeHunkSession,
  reloadHunkSession,
  reviewSpawnOptions,
  makeStuckViewWatchdog,
  openReviewView,
  waitForHunkSession,
  hunkAgentNoteIds,
  aiReviewGateByIds,
  startAgentReview,
  listLayout,
  // (1b) The indent prefix for the staggered stacked marker — SHARED source
  // with the title budget (listLayout), so the mark column can't drift.
  // (1d) The DISK CACHE for review results (/tmp). The memory cache stays on
  // the render path; this layer ONLY persists the review results already paid for.
  reviewStoreAnchor,
  reviewStoreDelete,
  reviewStoreEntryState,
  reviewStoreLoadAll,
  reviewStoreStateLoadable,
  reviewStoreWrite,
  lerpHex,
  markReviewTrace,
  fetchRebuildStatus,
  fetchStalenessProbe,
  pollDue,
  pollFailure,
  pollInit,
  pollNoteInput,
  pollProbeResult,
  pollStatusLabel,
  POLL_INTERVAL_MS,
  stalenessChanged,
  progressReducer,
  overlayFrame,
  applyProgressToInfo,
  applyProgressToPanel,
  progressAbort,
  progressInit,
  progressLabel,
  reviewCommand,
  reviewInnerCommand,
  openReviewViaPty,
  NODE_PTY_UNAVAILABLE,
  reviewPathOptions,
  reviewTraceSources,
  // (2) The pure layer of the REVIEW CASCADE MENU — in place of the
  // DISCONTINUED confirmation modal. `reviewPathWarning` was DROPPED: the menu
  // gets a compact, one-line warning (`reviewMenuWarning`); the verbose form
  // was the old dialog's content. The THRESHOLD (large) still comes from
  // `aiReviewSummary`.
  reviewMenuAdvance,
  reviewMenuBack,
  reviewMenuLines,
  reviewMenuOpen,
  reviewMenuSelection,
  reviewMenuStep,
  reviewMenuToggle,
  reviewMenuWarning,
  spawnFailure,
  startProgressDiagnosis,
  stepIndex,
  uploadFindings,
} from './tui-core.mjs'

// The RENDER LAYER (queue row + the three overlay bodies). A separate module
// because it renders FROM PROPS and closes over ZERO App state — see the
// module's file head.
//
// THE DEPENDENCY DIRECTION IS ONE-WAY: the app imports the render, the render
// imports ONLY the core. A back-import (render → app) would create a
// circular ESM, which the extended cycle detector in
// scripts/check-next-modules.mjs phase (3) mechanically forbids — this
// project's MEASURED, silent error class (exit 13, empty output).
import {
  // (wf31/55) The DIMMED TEXT COLOR — from the render module's SINGLE source.
  // The header and the list rows must show the SAME faded level under an open
  // panel; a hex written separately in two places would drift for sure.
  FADED_COLOR,
  Row,
  // (wf31/39) `Text` comes from the RENDER module, not from `ink`: it's a
  // NON-WRAPPING wrapper (`wrap: 'truncate'`) that eliminates the wrap-flicker
  // on resize. The rationale sits at its definition. A direct `ink` import
  // here would SILENTLY bring the flicker back on those lines.
  Text,
  approveModalProps,
  confirmBody,
  errorBody,
  infoBody,
  mergeModalProps,
  resolveModalProps,
  renderLines,
} from './tui-render.mjs'

// The model name goes into the body attribution. Overridable via env, because
// the TUI doesn't know which model helped produce the findings.
//
// WARNING: this is the MANUALLY DECLARED name, and we only use it on the hunk
// path ('d' + 'f'). On the AI path ('r') we do NOT declare the model: we
// MEASURE it from the claude-wrapper's `modelUsage` key (parseAiReviewResult),
// because the actual model is knowable there — a stale env value would give a
// false attribution on the PR.
const MODEL = process.env.TUIPR_REVIEW_MODEL || 'claude-opus-5'

// The AI-review model (the alias for claude `--model`) is NO LONGER a
// module-level constant: the env (`TUIPR_AI_REVIEW_MODEL`) only gives the
// STARTING VALUE for the confirmation panel's model selector
// (aiReviewModelState, read in askAiReview), and the TUI toggle (`m`)
// overrides it per run. The MEASURED FINDING that led here: a call without
// `--model` inherited the user's SAVED default (Fable 5 in their case), and a
// single review exhausted the session budget.

/**
 * THE NUMBER OF ACTIVE PROGRESS TICKERS — the OBSERVABLE measure of timer leaks.
 *
 * WHY THIS IS NEEDED (MEASURED GAP, adversarial mutation MUT8'): the ticker's
 * cleanup could be disabled such that
 *   (a) the source-grep test PASSES (the `clearInterval(timer)` literal stays
 *       in the file, just moved ahead of an earlier `return undefined`), and
 *   (b) the behavior test built on `process.getActiveResourcesInfo()` gives
 *       `✖`, BUT THE RUNNER THEN HANGS — the summary line never gets written,
 *       needing SIGKILL after 120s. In CI this is a JOB TIMEOUT, not a failed test.
 *
 * So `getActiveResourcesInfo()` isn't a good enough ORACLE: it's global, noisy
 * (the runner's own handles are in there too), and its signal drowns in the
 * hang. THIS counter is DIRECT, LOCAL, and INDEPENDENT of the hang — together
 * with `unref` (see the ticker's cleanup) the leak turns into a normal,
 * failing assertion.
 *
 * MODULE-LEVEL, NOT A REF: the measurement must stay valid AFTER the
 * component UNMOUNTS, when the React tree (and every `ref` in it) no longer exists.
 */
let tickerCount = 0

/** The number of active progress tickers. Test oracle; production never calls it. */
export function activeTickers() {
  return tickerCount
}

// The SPEND CAP doesn't live here as a constant: it's OFF BY DEFAULT, and can
// be toggled ad hoc on the confirmation overlay ('b'), unemphasized (see the
// core's budget chapter: `--max-budget-usd` is meant for API spend, while the
// user actually consumes a subscription limit, so its effect is uncertain).
// The env (TUIPR_AI_REVIEW_BUDGET_USD) only gives a STARTING VALUE — it does
// not enforce a cap.

// The LEGEND advertises a single key for the PR panel: ENTER. The earlier 'c'
// (conflict diagnosis) and 'i' (why a dep?) merged into ONE panel, and then at
// the user's request the opening key moved from `i` to Enter ("instead of the
// dropdown »i« it could be Enter") — in the list, OPENING a row is
// universally Enter.
//
// 'i' STILL WORKS (a silent alias, see the keybind branch), but we do NOT
// advertise it: two advertised keys for the same function is just noise in
// this narrow, shrinking footer.
// (wf31/11) `R_KEY_IDLE_LABEL` RETIRED. The global legend no longer carries an
// r-segment (see `KEYS` below), so there's nothing to SWAP in it — the
// constant's only purpose was the swap pattern. The `r`'s STATE-DEPENDENT
// label still lives UNCHANGED where the key is actually advertised: in the
// panel footer (`panelFooter({ rLabel })`), and the render computes it
// directly from `rKeyLabel`.
//
// EXPORTED: the footer tests used to scrape a `const KEYS = '…'` out of the
// FILE TEXT with a regex. That coupling is doubly fragile: (a) changing the
// literal's form (quotes → template literal) SILENTLY gives an empty match,
// and the test fails on its own regex, not on the code; (b) the source text
// doesn't even show the value of an interpolated segment. The tests now read
// the VALUE, not the source-code representation.
export { KEYS }
// (wf31/6) `f: upload review` — the user: "»upload« isn't
// informative enough. Make it »upload review«." The old "upload findings"
// named the MECHANISM (what we collect), not the RESULT (what appears on the
// PR): from the user's point of view, a REVIEW is what goes up under that
// name. `panelFooter` carries the same text — the two must say the same thing.
// (wf31/11) THE GLOBAL LEGEND NARROWED TO THE LIST LEVEL — the user's request:
// "Take the conflict measurement, d, r and f out of this. a and m can stay."
//
// THE PRINCIPLE THAT MAKES THIS RIGHT (not just a shortening): the FOUR
// REMOVED keys are DETAILED operations on ONE PR — the conflict measurement,
// the diff review, the AI review and the review upload all presuppose that
// the user has ALREADY decided WHICH PR they're dealing with. That decision
// is made IN THE PANEL, and the panel's footer (`panelFooter`) advertises all
// four anyway. At the LIST level, then, navigation, entering (`Enter`), the
// two LANDING actions (`a`/`m` — these are the queue view's own operations,
// meaningful row by row) and the global keys (`R`/`q`) remain.
//
// WITH `r` GONE, THE `legendWithRLabel` HELPER ALSO WENT AWAY (born in
// wf31/5, it closed off the empty r-label's dangling separator). Not
// "orphaned" but MOOT: the legend no longer carries an r-segment, so there's
// nothing to swap. A kept, forever-no-op helper is worse than deletion — it
// would suggest to the next reader that the legend is state-dependent, when
// it's actually static. `panelFooter`'s OWN filtering (`filter` for empty
// segments) is UNCHANGED: there `r` is still state-dependent, and the
// guard stays in place there too.
//
// `Enter`'s DESCRIPTION IS "details" (the user's request). The old "PR panel
// (info + steps)" described the panel's INTERNAL STRUCTURE, which is
// irrelevant at the list level — the user wants to know WHAT HAPPENS on
// keypress: the details open up.
// (wf31/28) `d`/`r` CAME BACK, THE NAVIGATION SEGMENT SHORTENED.
//
// From the user's finding: "d and r are missing from the list legends because
// I took them out, but the commands still work." The decision was to bring
// them back, with a shortened legend.
//
// WHY BRINGING THEM BACK IS JUSTIFIED (the wf31/11 removal was partly wrong):
// `d` (diff) and `r` (review) are ROW-LEVEL gestures — you don't need to open
// a panel to know which PR is meant: the CURSOR tells you. This is the SAME
// level as `a`/`m`, which the user kept anyway. `c` (conflict measurement) and
// `f` (upload), however, STAY removed: the former is advertised by the
// measured strip in its own context, the latter by the panel footer (and only
// when there's something to upload).
//
// THE "CRAMMED UI" COUNTERARGUMENT NO LONGER HOLDS: since wf31/27 the legend
// lives at the TABLE's width (not the monitor's), and the
// `j/k or ↑/↓: navigation` → `j/k: row` shortening frees up the space. The
// arrows STILL work, we just don't advertise them — same principle as the `i`
// alias (two advertised keys for one function is noise).
// (wf31/30) THE `⏎` UNICODE GLYPH instead of the word `Enter` — the user's
// request: "In the legend, instead of »Enter« there should be the Enter
// character, it has a unicode glyph". `⏎` (U+23CE RETURN SYMBOL) is 1 cell
// wide (measured: not in WIDE_RANGES, not an emoji form), so it frees up 5
// cells compared to the text form.
const KEYS = 'j/k: row · ⏎: details · d: diff · r: review · a: approve · m: merge · R: refresh · q: quit'

/**
 * (wf31/45) THE PENDING LABEL — ON THE RIGHT EDGE OF THE LEGEND, WITH INVERSE HIGHLIGHT.
 *
 * The user's path to here, because the decisions build on each other:
 *   1. wf31/23 — the global status line retired, the pending moved into a
 *      legend SEGMENT (`d: diff (running…)`);
 *   2. the user's finding: "hard to track visually, there's a layout jump on
 *      the status line" — the segment lengthening shifted the following four
 *      segments by 7 cells, exactly the ones the eye used as an anchor;
 *   3. the user's suggestion: "the bottom-right corner is empty, so it
 *      shouldn't need its own row" — the legend is ~93 cells, the right side
 *      is free the whole way;
 *   4. the user's refinement: "I'd show it with an inverse bg-color, so light
 *      background, dark char".
 *
 * WHY IT'S JUMP-FREE: the legend's LEFT side is byte-for-byte unchanged, the
 * pending appears and disappears at the RIGHT end of the line. The eye sees
 * nothing else move.
 *
 * WHY IT LIVES HERE (and not on its own line): the UI ALREADY HAS the "left =
 * constant, right = ephemeral" axis — the header's `notice` sits right-aligned
 * the same way. The legend, one line down, follows the same rule, so ONE
 * reading habit serves two places.
 *
 * WHY THE GESTURE, NOT THE KEY (`⏳ opening hunk…`, not `⏳ d…`): the user
 * SEES the key on the left — the right side says WHAT'S HAPPENING. This is
 * the one lesson kept from the retired status line.
 */
// THE THREE DOTS ARE ASCII, NOT `…` (U+2026) — MEASURED REASON, from the
// user's finding: "in the pending legend only TWO dots are visible instead of three".
//
// `…` is **Ambiguous** per East Asian Width: `displayWidth` treats it as 1
// cell (correctly, since that's true in most terminals), but Ghostty/the font
// renders it wider — a single glyph with three dots, which loses its third
// dot when squeezed into 1 cell. Because of the right-alignment this sits
// right at the END of the line, where there's nowhere for it to overflow into.
//
// WHY WE DON'T EXTEND `WIDE_RANGES`: `U+2026` is NOT Wide, it's Ambiguous —
// treating it as 2 cells would introduce a false cell of width EVERYWHERE
// else it's used (panel texts, status lines). We replace the ambiguous glyph
// itself instead: `...` is three ASCII characters, so it's EXACTLY 3 cells in
// ANY terminal, no measuring or guessing needed. The hourglass (`U+23F3`)
// stays — its EAW is Wide, it's in the table, and MEASURED it correctly gets 2 cells.
const PENDING_LABELS = {
  d: '⏳ opening hunk...',
  f: '⏳ uploading review...',
  a: '⏳ approve...',
  m: '⏳ merge...',
  R: '⏳ refreshing...',
}

/**
 * The pending label for the running action's key, or `null`.
 *
 * FAIL-SOFT ON AN UNKNOWN KEY: `null`, so the legend stays unchanged. A
 * made-up label (e.g. printing the key) would be worse than no indicator at
 * all — the UI is blocked under `busy` anyway.
 */
export function pendingLabelFor(key) {
  if (typeof key !== 'string' || key === '') return null
  return PENDING_LABELS[key] ?? null
}

/**
 * The legend + the right-aligned pending in ONE line, measured in CELLS.
 *
 * The return is `{ left, gap, right }`: the render splits it into THREE
 * Texts, because `right` gets an INVERSE highlight (`inverse`) while `left`
 * stays dim. A concatenated string couldn't do this — the attribute lives
 * per-Text.
 *
 * WHY `inverse`, AND NOT FIXED HEX COLORS: ANSI `inverse` (`\e[7m`) swaps the
 * terminal's OWN foreground and background colors, so the THEME DECIDES the
 * result — light background + dark char on a dark theme (what the user
 * asked for), the reverse on a light theme. A fixed `backgroundColor:
 * '#d8dee9'` would be exact on the user's machine, but on a light theme it
 * would BLEND INTO the background and the indicator would vanish.
 *
 * THE DEGRADATION follows the `headerLine` pattern: if the two don't fit, the
 * PENDING drops, the legend stays. Reason: the legend advertises CONTROLS
 * (without it the UI is unusable), the pending is EPHEMERAL — and the user
 * senses the `busy` state anyway from the buttons not responding.
 */
export function legendWithPending(keys, key, columns = 0) {
  const label = pendingLabelFor(key)
  if (label === null) return { left: keys, gap: '', right: '' }
  const limit = Math.max(0, Math.floor(Number(columns) || 0))
  // `GAP` is the minimum spacing: without it, on a narrow terminal the
  // legend's last segment and the pending would RUN TOGETHER (`q: quit⏳ approve…`).
  const GAP = 4
  const need = displayWidth(keys) + GAP + displayWidth(label)
  if (limit <= 0 || need > limit) return { left: keys, gap: '', right: '' }
  return { left: keys, gap: ' '.repeat(limit - displayWidth(keys) - displayWidth(label)), right: label }
}

// The FIXED row cost of the panel's frame (chrome) — for the viewport computation.
//
// We do NOT estimate the CONTENT height: `clipBodyLines` MEASURES it (with
// wrapping, against the frame's inner width). Estimation used to be a
// MEASURED BUG: a per-section "roughly this many lines" heuristic didn't
// account for WRAPPING, a long advice paragraph took 3-4 lines, the estimate
// gave 1 — and the frame swelled to 29 lines on a 12-line terminal, pushing
// the HEADER off-screen. The chrome, however, is TRULY fixed: top frame +
// title + blank + blank + footer + bottom frame.
const PANEL_CHROME_ROWS = 6

/**
 * THE TABLE'S HORIZONTAL SEPARATOR LINE — between the header/table and the table/footer.
 *
 * The user's request: "a horizontal line in the current empty rows, i.e. a
 * separator. Naturally up to the table's edge, not the viewport's."
 *
 * THE WIDTH IS THE CALLER'S JOB (`layout.width`, with a physical ceiling) —
 * this function just draws. That way it can be given the same measure that
 * `Row`'s background and the header's `notice` also use: the right edge of
 * all three elements lines up.
 *
 * `dimColor`: the line is STRUCTURE, not content — the eye should stop on the
 * rows, not on the frame. The measured advance of `─` U+2500 (BOX DRAWINGS
 * LIGHT HORIZONTAL) is 1 cell (the box-drawing block isn't ambiguous-width,
 * unlike geometric shapes).
 *
 * `null` FOR ZERO/NEGATIVE WIDTH: `repeat` would throw, and a 0-cell line
 * would just be a silent empty row anyway.
 *
 * (wf31/51) `line: false` gives a SILENT PLACEHOLDER instead of the line —
 * the HEIGHT is unchanged (1 row). The user's request: "with the info panel
 * open, the top separator isn't needed either, but of course still reserve
 * the space, no layout jump. It's just too many lines together with the info
 * panel's frame."
 *
 * SEPARATING THE TWO IS LOAD-BEARING: if the line simply DISAPPEARED, the
 * tree would be one row shorter, and the list would JUMP UP ONE ROW when the
 * panel opens — the top separator sits ABOVE the list, so its absence shifts
 * everything. The placeholder row exists precisely to prevent that: the line
 * vanishes, the space stays.
 *
 * ONE SPACE, NOT `w` OF THEM: what matters is the row's HEIGHT (1), not its
 * width — a `w`-cell space row is worth exactly the same, just more bytes on output.
 */
function tableSeparator(width, key, { line = true } = {}) {
  const w = Math.max(0, Math.floor(Number(width) || 0))
  if (w <= 0) return null
  return h(Text, { key, dimColor: true }, line ? '─'.repeat(w) : ' ')
}

// --- (wf32) THE ROOT CAUSE OF THE SHELL HANG AFTER HUNK-CLOSE, AND THE FIX ---
//
// THE SYMPTOM (from the user's finding, MEASURED in tmux, `stty -f <tty> -a` +
// `sample`/`lldb` on the process): AFTER the `d`→hunk→`q` transition the
// screen SOMETIMES returns immediately, and SOMETIMES hangs at the SHELL
// PROMPT (`alternate_on=0`), and the list only appears on a LATER keypress
// (any key) — with UPDATED content, which shows the TUI process was ALIVE the
// whole time, only the screen was lying. This is NOT a render bug: measured
// (`stty -f <tty> -a` polled every 10ms after `q`), the terminal stayed in
// `icanon` (cooked) mode, while Ink should have restored it to RAW mode.
//
// THE ROOT CAUSE (proven with an isolated reproduction WITHOUT Ink — see the
// tmux measurement log in the PR description): the `hunk` child runs with
// `stdio: 'inherit'`, so it also inherits our stdin fd 0. Ink's `App.js`
// `pauseInput()` detaches its own `'readable'` listener and `unref()`s the
// stream before starting the hunk — this is correct at the JS level, but the
// libuv `uv_tty_t` handle CANNOT interrupt the EARLIER `read()` syscall that
// was actively reading in raw mode (a known libuv limitation, see
// libuv/libuv#982: "Calling uv_read_stop on stdin tty causes EOF to never be
// read"). The thread therefore stays in ONE SYNCHRONOUS, BLOCKING `read()` on
// our stdin fd — and while it's there, the Node event loop CANNOT process the
// SIGCHLD signaling the hunk child's death either: `child.on('close', …)`
// (which `openReviewView` waits on) STALLS, often for SECONDS, sometimes TENS
// OF SECONDS. Ink's `endSuspend()` (which would restore raw mode via
// `resumeInput()`) can only run AFTER this — so the terminal stays cooked
// until some INPUT (a stray keypress, even the NEXT `d`) unblocks it. This
// also explains the non-deterministic symptom: `sample`/`lldb` on the process
// showed a naive `uv__stream_io → read` call (libsystem_kernel.dylib), BUT a
// `setInterval` ticker proved the event loop was NOT blocked entirely — only
// from the moment the main thread ENTERED this blocking read after `q`, and
// from then on NOTHING (timer, watchdog, poll) could run until input arrived.
//
// THE FIX: since the blocking `read()` CANNOT BE REVOKED AT THE STREAM LEVEL
// (measured: no combination of `stdin.pause()`/`unref()`/`removeListener()`
// releases an old target that's ALREADY reading) — only `stdin.destroy()`
// BEFORE the spawn, then a FRESH `tty.ReadStream(0)` AFTER the child's `close`
// (see the `destroyOldTarget`/`attachFreshTarget` heads — the SEPARATION of
// the TWO STEPS and their timing is itself a MEASURED decision that avoids
// two separate error classes). We confirmed with a DIRECT native `stty`
// measurement: calling `setRawMode(true)` on the old, destroyed stream sets
// the JS-side `isRaw` flag to `true` DISHONESTLY, without touching the NATIVE
// terminal mode — that's why we need a TRULY fresh stream, not a "repair" of
// the old object.
//
// THE INK INTEGRATION: Ink's `render()` closes over `process.stdin` ONCE, AT
// STARTUP, into `Instance.options.stdin` (see `ink/build/render.js`), and
// there's no public API for a runtime swap — `App.js`'s `pauseInput`/
// `resumeInput` callbacks also reference this same CLOSED-OVER reference. A
// full `unmount()`+fresh-`render()` on every `d`/`q` transition WOULD SOLVE IT
// (a new Instance would read a fresh `process.stdin`), but that would mean
// losing the ENTIRE React state (cursor, notice, panel, cache — see the App
// state listing above) on EVERY single hunk-open — an unacceptable price.
//
// DELEGATINGSTDIN IS THE MIDDLE GROUND: `App.js` calls EXACTLY EIGHT things on
// stdin (verified in the source): `isTTY` (read), `addListener('readable',
// …)`, `removeListener('readable', …)`, `read()`, `setEncoding('utf8')`,
// `setRawMode(bool)`, `ref()`, `unref()`. This is a closed, stable surface —
// the wrapper is an `EventEmitter` that delegates these eight calls to an
// INTERNAL, SWAPPABLE `_target` stream, and forwards the `_target`'s events
// (primarily `'readable'`) on its OWN emitter. We give Ink's `render()` THIS
// wrapper as stdin — so Ink NEVER sees the real `tty.ReadStream` directly,
// meaning we can swap the wrapper's `_target` at any time without Ink ever
// needing to know.
//
// THE SWAP SPLITS INTO TWO STEPS, AND THEIR TIMING IS LOAD-BEARING (MEASURED,
// on the second attempt's failure — see the `attachFreshTarget` head):
// `destroyOldTarget()` must run BEFORE THE SPAWN (after Ink's
// `beginSuspend()` has already detached the old target's listeners), while
// `attachFreshTarget()` must run AFTER THE CHILD'S `close` EVENT, NEVER
// EARLIER — a fresh stream before/during the spawn would REINTRODUCE the
// TTY-read race with the hunk child (the exact detour the `script -q
// /dev/null` PTY isolation, see the `reviewCommand` head, already eliminated
// on the hunk's own process group).
class DelegatingStdin extends EventEmitter {
  constructor(initialTarget) {
    super()
    // (startup-freeze) THE CONSTRUCTOR DOES NOT ATTACH A LISTENER — it only
    // stores the target. The earlier immediate `_attachTarget` put a
    // 'readable' listener on `process.stdin` AT MODULE LOAD, which pulls the
    // stream into reading (registering the listener itself starts a native
    // read on fd 0). This disproved `runTui`'s assumption that during
    // `queryTerminalColors` "nobody is reading stdin yet": the query's own
    // `/dev/tty` reader and the fd 0 reader raced SIMULTANEOUSLY for the same
    // terminal device — on macOS, moreover, /dev/tty uses libuv's
    // select-fallback thread. The race's outcome is timing-dependent; on the
    // losing branch the input was lost forever (the TUI rendered, but
    // responded to no keypress — not even Ctrl-C — roughly every 3rd-4th
    // startup). The attachment is therefore done by `engage()`, AFTER the
    // query CLOSES, before render().
    this._target = initialTarget
    this._forwardedEvents = ['readable', 'end', 'error']
  }

  /**
   * The ACTUAL attachment of the starting target — called by `runTui`, AFTER
   * the color query (`queryTerminalColors`) closes and BEFORE `render()`. Up
   * to this point we GUARANTEE no reader on fd 0 (see the constructor's rationale).
   */
  engage() {
    this._attachTarget(this._target)
  }

  _attachTarget(target) {
    this._target = target
    // We remove ALL previous forward listeners FIRST, otherwise an earlier
    // _attachTarget call (on the same target, hypothetically) would attach
    // twice. We remove on the `target` (not the wrapper!) — this removes our
    // OWN internal forward functions, not the 'readable' listener attached by
    // App.js (App.js keeps that on the WRAPPER, not the target).
    for (const ev of this._forwardedEvents) {
      target.removeListener(ev, this._forwardHandlerFor(ev))
      target.on(ev, this._forwardHandlerFor(ev))
    }
  }

  // A STABLE handler reference per event type — the removeListener/on pair
  // only works if both sides get the same function.
  _forwardHandlerFor(ev) {
    this._handlers ??= {}
    this._handlers[ev] ??= (...args) => this.emit(ev, ...args)
    return this._handlers[ev]
  }

  /**
   * DESTROYING the OLD target — TO BE CALLED BEFORE THE SPAWN.
   *
   * MEASURED BUG (on wf32's FIRST, INSUFFICIENT attempt, an earlier
   * combined-destroy+fresh-stream form of `swapToFreshTarget`): `_attachTarget`
   * registers its OWN `forwardHandler` on the target's `'readable'` IN THE
   * CONSTRUCTOR — this registration BY ITSELF switches the Node stream into
   * "readable listening" mode, REGARDLESS of whether there's still an active
   * listener on the WRAPPER (from App.js's side). App.js's `pauseInput()`
   * calls `wrapper.removeListener('readable', …)` — this ONLY removes the
   * wrapper's OWN EventEmitter listener, NOT the `forwardHandler` sitting on
   * the target. The old target thus stays CONTINUOUSLY in reading mode, and
   * by the time `destroy()` gets here, the blocking native `read()` is
   * ALREADY in progress.
   *
   * THE FIX: WE OURSELVES remove the forward listener from the old target
   * BEFORE calling destroy() — so at the moment of destroy, the old target is
   * NOT reading anything (no 'readable' listener), so `destroy()` hits a
   * TRULY idle stream, not one already reading.
   *
   * FAIL-SOFT: `destroy()` may throw as a no-op on a closed/already-destroyed
   * stream — this must not fail the caller, because the goal (stopping the
   * old reader) is achieved anyway (already destroyed).
   *
   * DELIBERATELY DOES NOT create a fresh target here — see the
   * `attachFreshTarget` head: creating the fresh stream EARLIER (WHILE the
   * child is RUNNING) brought back ANOTHER MEASURED error class (the
   * pre-wf26/wf31/19 TTY race: the fresh stream and the `stdio:'inherit'`
   * hunk child would read the SHARED inherited fd SIMULTANEOUSLY).
   */
  destroyOldTarget() {
    const oldTarget = this._target
    try {
      for (const ev of this._forwardedEvents) {
        oldTarget?.removeListener(ev, this._forwardHandlerFor(ev))
      }
    } catch { /* see the fail-soft rationale above */ }
    try {
      oldTarget?.destroy()
    } catch { /* see the fail-soft rationale above */ }
  }

  /**
   * Attaching a FRESH `tty.ReadStream(0)` — TO BE CALLED AFTER THE CHILD'S
   * `close` EVENT, NEVER EARLIER.
   *
   * MEASURED BUG (on wf32's SECOND attempt, caught with `sample`/`lldb` + the
   * `forwarding event: readable` log line): if the fresh stream is created
   * BEFORE THE SPAWN, it REINTRODUCES the TTY-read race shared with the hunk
   * child — exactly the error class that the `script -q /dev/null`
   * PTY isolation (see the `reviewCommand` head) already eliminated on the
   * hunk's OWN process group. Because of `stdio:'inherit'`, the fresh stream
   * would watch the SAME inherited fd as the hunk child — two active readers,
   * two possible winners, a non-deterministic outcome.
   *
   * THE FIX: the fresh stream is only created ONCE the child has NOTHING LEFT
   * to read from the fd (it's gone) — this is the moment right after the `close` event.
   */
  attachFreshTarget() {
    this._attachTarget(new tty.ReadStream(0))
  }

  // --- Delegated methods/properties — App.js's EXACT, closed surface -----
  get isTTY() { return this._target.isTTY }
  get isRaw() { return this._target.isRaw }
  get destroyed() { return this._target.destroyed }
  setRawMode(mode) { return this._target.setRawMode(mode) }
  setEncoding(enc) { return this._target.setEncoding(enc) }
  read(...args) { return this._target.read(...args) }
  ref() { return this._target.ref?.() }
  unref() { return this._target.unref?.() }
}

// MODULE-LEVEL SINGLETON, NOT `App` STATE: `openHunkView` (inside the `App`
// component, stabilized with `useCallback`) and `runTui` (in the `render()`
// call) must reference the SAME wrapper — a wrapper closed over React state
// would give a NEW reference on every render, while the stdin GIVEN to Ink's
// `render()` stays the ONE FROM STARTUP regardless (see the module chapter:
// Ink reads it once, closed over). It starts with `process.stdin`: this is
// the REAL starting target that runTui gives to render().
const stdinWrapper = new DelegatingStdin(process.stdin)

// THE RENDER LAYER (queue row + the three overlay bodies) LIVES IN ITS OWN
// MODULE: bin/tui-render.mjs. The move was MECHANICAL — the block closed over
// ZERO App state (no hook, no setter, no ref in its closure), so the hook
// order (React's silent error class) is unaffected.


// EXPORTED so the RENDER (and the keypress handling) can be manually verified
// with an Ink instance mounted over a fake stdout/stdin. The unit tests still
// don't import this module (it would need ink/react) — verification is a
// separate, manual run.
/**
 * @param {object} [props]
 * @param {number} [props.pollIntervalMs] the background-poll TICK rate. Only
 *   given by the TEST HARNESS (in production the core's POLL_INTERVAL_MS is
 *   the measure); a denser tick by itself does NOT poll more often, because
 *   due-ness is decided by the poll state machine's `nextDueAt`.
 * @param {() => number} [props.pollNow] the INJECTED CLOCK. Without it, `Date.now()`.
 *   The tests use it to scale virtual time so the 100s due-time and the
 *   15-minute idle timeout are reachable within real milliseconds — without
 *   real waiting, without sacrificing determinism.
 * @param {number} [props.sessionWaitMs] the ceiling for waiting on the
 *   HUNK SESSION to appear. In production the core's default (10s); the TEST
 *   HARNESS shortens this, because waiting 10 real seconds for the timeout
 *   branch is pointless (and flaky). The BEHAVIOR doesn't change because of
 *   it: the same state machine runs, only the bound moves.
 * @param {number} [props.aiTimeoutMs] the BACKGROUND-REVIEW CEILING. In
 *   production the core's `AI_REVIEW_TIMEOUT_MS` (30 min, from the MEASURED
 *   CI distribution); the TEST HARNESS shortens this, because waiting 30 real
 *   minutes for the timeout branch isn't possible. The same watchdog runs,
 *   only the bound moves.
 * @param {number} [props.aiTickMs] the PROGRESS-TICK rate (1s in production).
 *   MEASURED cost: ~12ms CPU/tick, i.e. ~1.2% on one core at a 1s tick — so
 *   negligible. A few tens of ms in tests.
 * @param {number} [props.aiFindingPollMs] the FINDING-COUNTER read rate (5s
 *   in production). MEASURED cost: 0.42s per `comment list` call alongside a
 *   LIVE hunk TUI, so at 5s it's an ~8% duty cycle (at 1s it would be 42% —
 *   that's a lot).
 */
export function App({
  pollIntervalMs, pollNow, sessionWaitMs,
  aiTimeoutMs, aiTickMs, aiFindingPollMs,
  // (wf31/62) The RUNTIME-MEASURED terminal colors (OSC 10/4, once at
  // startup) — the fade-tween's starting points. `null` if the terminal didn't respond.
  themeColors = null,
} = {}) {
  // (wf31/42) `waitUntilRenderFlush` is Ink's OWN flush: internally it runs
  // `reconciler.flushSyncWork()`, plus it waits out the macrotask queue and
  // (in concurrent mode) the next render commit. This is what GUARANTEES a
  // pending indicator is ON SCREEN BEFORE the blocking work starts —
  // `setTimeout(0)` just hopes for it.
  const { exit, suspendTerminal, waitUntilRenderFlush } = useApp()
  // The RAW queue model (the `queue --json` array). The rows TO DISPLAY are
  // COMPUTED from this + the cache states PER RENDER (see below) — buildRows
  // is pure and I/O-free, so this isn't a cost. SEPARATING THE TWO STATES is
  // load-bearing: if we stored the finished rows, refreshing the cache
  // indicator would require reloading the whole queue (a gh call), and the
  // indicator would achieve exactly the opposite of what it was built for.
  const [model, setModel] = useState([])
  const [index, setIndex] = useState(0)
  // (wf31/23) The FEEDBACK appears at the RIGHT edge of the header (the
  // global status line retired). It carries two message classes:
  //   · RESULT (`#895: merged (merge)`, `#904: approved`),
  //   · INPUT RESPONSE (`aborted`, `too soon — press again`).
  // PENDING is NOT part of this: that moved into the legend (`pendingKey`).
  const [notice, setNotice] = useState('')
  // (wf31/25) OPTIMISTIC STATES: PR number → `'merged'` | `'approved'`.
  //
  // WHY THIS IS NEEDED (measured finding, the user's #895 case): `gh pr merge`
  // returned exit 0, `reload()` RAN, and the PR STILL stayed `● in queue` in
  // the list — GitHub's GraphQL index updates asynchronously, so in the
  // seconds after a merge `gh pr list --state open` STILL returns the old
  // state. The same holds for approve: the `✔ approved` rmark only arrived
  // after the next successful reload.
  //
  // WE KNOW OUR OWN ACTION'S RESULT (exit 0), so we don't ask the API that's
  // lagging behind. The marker goes into `buildRows`, which overwrites the
  // MARK (`✔ merged`) and the rmark (`✔ approved`), plus dims the row.
  //
  // WHEN IT DISAPPEARS: once the MODEL has caught up with itself — the
  // `reload` branch removes entries that the fresh data already reflects (a
  // merged PR disappeared from the list / the approval appeared in
  // `reviewDecision`). So the marker doesn't get stuck, and doesn't lie any
  // longer than necessary either.
  const [optimistic, setOptimistic] = useState({})
  // THE LOAD TIMESTAMP — the header states it. The user's request: "The
  // header should show WHEN we last loaded." Without it, the list on screen
  // can't be told apart from one 20 minutes old, and a decision (approve/merge)
  // gets made on a stale picture.
  const [loadedAt, setLoadedAt] = useState(null)
  // The trunk's (`origin/<main|dev>`) SHA: the other half of the cache
  // anchor. Measured ONCE per load (not per row) — see the fetchMainSha head.
  const [mainSha, setMainSha] = useState(null)
  // (wf31/44) THE NEXT-REBUILD STATE for the header — `{ state, at }` or `null`.
  //
  // WHY STATE, AND WHY WE DON'T MEASURE IT IN THE RENDER: `fetchRebuildStatus`
  // is a `gh run list` SPAWNSYNC, which on the render path would run PER
  // FRAME (the header recomputes on every keypress, every poll tick) — this
  // project's explicit error class (see the rationale for memoizing
  // `fetchCoreSha`). The measurement therefore runs on the LOAD path, where
  // the other `gh` calls also run.
  //
  // `null` IS THE NORMAL CASE: `fetchRebuildStatus` returns ONLY the
  // non-`success` state (we don't advertise the good state — the user's decision).
  const [rebuild, setRebuild] = useState(null)
  // (1d) The main SHA ALSO IN A REF. WHY IT'S NEEDED ALONGSIDE STATE —
  // MEASURED BUG, from a LIVE RENDER: `persistReview` is called from
  // `doAiReview`'s long-running branch, STABILIZED with `useCallback([])`,
  // which closes over the `mainSha` valid AT CREATION TIME — and that's still
  // `null` then (the queue load runs afterward). This put a `mainSha: null`
  // anchor on disk, which in FAIL-CLOSED fashion NEVER matches: the entry was
  // stale forever, so the disk cache SILENTLY didn't work. (This doesn't
  // affect the memory cache: it computes its anchor at RENDER time.)
  //
  // The REF reads AT THE MOMENT OF THE CALL, so the stable callback also sees
  // the fresh value — instead of opening up `useCallback`'s dependency list,
  // which would re-create the review mid-run.
  const mainShaRef = React.useRef(null)
  useEffect(() => { mainShaRef.current = mainSha }, [mainSha])
  // The MEASUREMENT CACHE. `useRef`, NOT state: writing an entry does NOT
  // re-render on its own (the measurement event renders anyway, via the
  // `info` state), and a Map put into state would want a new reference on
  // every write. The RENDER knows it changed from `cacheVersion` — so the
  // indicator refreshes, but a cache write doesn't trigger a render storm.
  const cache = React.useRef(createCache())
  const [cacheVersion, setCacheVersion] = useState(0)
  const bumpCache = useCallback(() => setCacheVersion((v) => v + 1), [])

  // --- (1d) THE DISK CACHE FOR REVIEW RESULTS -------------------------------
  //
  // THE USER'S REQUEST: "the app should cache reviews to disk, because it's
  // tiring to always restart." The memory cache dies together with the TUI,
  // so after a restart the PAID FOR (tokens spent) findings were lost —
  // this layer eliminates exactly that loss.
  //
  // PERSISTING IN ONE PLACE (`persistReview`), not scattered across call
  // sites: findings storage has TWO branches (live hunk session / answer-only),
  // and repeating the anchor assembly in both is exactly the kind of
  // duplication one branch falls behind on. Deletion (`forgetReview`) is likewise in one place.
  //
  // FAIL-SOFT: the store returns `false`/`null` on error, and WE DON'T
  // SURFACE anything to the UI either. The review's result STILL EXISTS in
  // memory — a "/tmp not writable" error message ALONGSIDE the paid-for
  // result is just noise, with no actionable step.
  const persistReview = useCallback((row, findings, summary) => {
    if (!Array.isArray(findings) || findings.length === 0) return
    try {
      reviewStoreWrite({
        repoRoot: fetchRepoRoot(),
        pr: row.number,
        // THE ANCHOR'S THREE PARTS: the PR's updatedAt, the main SHA (the
        // memory cache already uses this) and the CORE SHA — other code may
        // use a different schema.
        // The main SHA comes from the REF (at the moment of the call), NOT
        // from the closed-over state — see the mainShaRef head: the stable
        // `doAiReview` callback closed over the `null` starting value, and
        // the anchor fail-closed NEVER matched.
        anchor: reviewStoreAnchor({ row, mainSha: mainShaRef.current, coreSha: fetchCoreSha() }),
        findings,
        summary: typeof summary === 'string' ? summary : null,
      })
    } catch {
      // `fetchRepoRoot` CAN THROW (a non-git cwd). We can't lose the run for
      // the sake of persistence — everything is still in the memory cache.
    }
  }, [])

  // --- THE ACCOMPANYING DATA FOR REVIEWS RESTORED FROM DISK -----------------
  //
  // PR number → `{ summary, toolDrift }`. It carries TWO things, and BOTH come
  // from the SAME user finding ("PR 904's review isn't loaded in the TUI") —
  // because the finding was actually THREE separate bugs, not one:
  //
  //   1) `coreSha` BLOCKED the load (fixed in the store: `tool-drift`).
  //   2) Hydration did NOT WRITE the `aiReview` STATE, so the PR panel's
  //      review section stayed EMPTY. The findings WERE there in the memory
  //      cache (the `r: discard` label and the list glyph showed this too),
  //      but the user looks for the review IN THE PANEL — and there, NOTHING
  //      from the previous run was visible.
  //   3) The store's `summary` (the VERDICT) WAS LOST: the memory cache
  //      (`cacheStoreAiFindings`) only stores the findings, not the summary.
  //      So a restart silently dropped the review's MOST VALUABLE part.
  //
  // So `summary` IS NOT DECORATION: the `done`/`done-answer` panel writes the
  // summary ABOVE the findings, because "the findings list is NOT a verdict"
  // (`aiReviewPanelLines` wf24/2). Without it, the restored review would be a
  // raw list with no conclusion.
  //
  // WHY STATE, AND NOT IN THE `cache` REF: this is a RENDER INPUT (the panel reads it),
  // so setting it MUST cause a render. The `cache` ref deliberately doesn't
  // render on its own (`bumpCache` does that) — a flag stored there at the
  // moment of hydration would be left out of the render that ALREADY RAN, and
  // would only show up on the next, RANDOM render. Hooking it onto
  // `bumpCache` would mean the indicator hangs off a side effect of the cache
  // version — the same doctrine behind separating `cacheVersion`/`aiFindings`.
  //
  // WHY A PR-KEYED OBJECT, AND NOT A MAP: an object literal together with
  // `useState` gives an IMMUTABLE update (new reference → render), which
  // mutating a Map doesn't — a `map.set()` would NOT render, and we'd run
  // right back into the error class above.
  const [restoredReviews, setRestoredReviews] = useState({})

  const forgetReview = useCallback((pr) => {
    // DISCARDING ALSO DELETES FROM DISK: otherwise on the next startup the
    // user's explicit decision (double-`x`) would silently reverse itself,
    // and the discarded findings would come back.
    try {
      reviewStoreDelete({ repoRoot: fetchRepoRoot(), pr })
    } catch { /* fail-soft: see persistReview */ }
    // THE RESTORATION COMPANION GOES TOO: there's nothing to show for a
    // discarded review, and a leftover entry would carry a FOREIGN summary
    // and a false "measured by a different core version" caveat over to the
    // NEXT (freshly run) review's panel.
    setRestoredReviews((cur) => {
      if (!cur[pr]) return cur
      const { [pr]: _dropped, ...rest } = cur
      return rest
    })
  }, [])

  // --- THE BACKGROUND POLL (staleness check) --------------------------------
  //
  // THE CLOCK is a reference closed over in a `useCallback`: `Date.now()` in
  // production, the injected (scaled) clock in tests. WHY WE DON'T read the
  // prop directly at the call sites: `now()` is needed both in the tick
  // callback AND in `useInput`, and a scattered `pollNow ? pollNow() : Date.now()`
  // repeated three times is exactly the kind of duplication where one branch
  // falls behind.
  const now = useCallback(() => (pollNow ? pollNow() : Date.now()), [pollNow])
  // THE POLL STATE lives in a `useRef`, NOT in state.
  //
  // WHY: the poll steps itself forward in the background (due-time
  // calculation, backoff), and these steps do NOT change the UI. If it were
  // state, every tick would re-render the whole list — for a 100-row queue
  // this would load the poll's cost onto the UI, every 100 s, for no reason.
  // RENDERING is triggered EXCLUSIVELY by the VISIBLE indicator (`pollLabel`
  // state), which the tick callback only writes when it has ACTUALLY changed.
  const poll = React.useRef(pollInit({ now: 0 }))
  // THE VISIBLE poll indicator (the header text). Separate state from the poll
  // state: this is the ONE thing the poll is allowed to cause a render for.
  const [pollLabel, setPollLabel] = useState('')
  // SENTINEL FOR THE RUNNING PROBE: two probes can NEVER run at once.
  // `fetchStalenessProbe` is spawnSync-based (blocking), so if a tick were to
  // start while the previous probe is running, the two blocking calls would
  // queue up, and the UI would freeze for twice as long.
  const probing = React.useRef(false)
  const [busy, setBusy] = useState(false)
  // (wf31/23) THE RUNNING ACTION'S KEY — marked in the LEGEND, not in a global
  // status line (that's been retired). The user's request: "Whenever a pending
  // state is needed, always put it at the triggering legend entry, maybe with
  // a '(loading)' label, so it's contextual."
  //
  // The KEY (not the full label) is used because the legend recognizes the
  // segment from the key (`a: approve` → `a: approve (running…)`). A full
  // string here wouldn't fit into the legend.
  //
  // Lives TOGETHER with `busy`: `runExclusive` sets and clears both in the
  // same try/finally — so it can't get stuck on error paths either.
  const [pendingKey, setPendingKey] = useState(null)
  // (wf31/72) WHICH PR THE ACTION IS RUNNING ON — pending is tied to the ROW.
  //
  // The user's request: "during approve, while the pending UI is up, I want to
  // be able to navigate to another PR […] and have the pending approve show
  // up in the table too, so when I navigate away I can see the old row is
  // pending."
  //
  // UNTIL NOW PENDING WAS GLOBAL (`busy` + `pendingKey`), and lived in the
  // legend — that was enough as long as navigation was DISABLED while an
  // action was running (the user stayed put where the action ran). With
  // navigable pending, though, the indicator needs to know WHICH row to stick to.
  //
  // A SINGLE NUMBER, NOT A MAP: `actionLock` allows only ONE action at a time,
  // so multiple concurrent pendings can't exist — a map here would be a
  // dishonest affordance.
  const [pendingPr, setPendingPr] = useState(null)
  // THE VISIBLE STATE OF THE AI REVIEW — LIVES IN THE PR PANEL (the user's
  // point 3: "the status message at the bottom of the screen isn't a good
  // spot, it mutates the layout"). An object:
  //   { pr, status: 'starting'|'running'|'done'|'done-answer'|'no-findings'|
  //     'aborted'|'timeout'|'killed-by-exit'|'failed', startedAt?, added?,
  //     findings?, offer?, message? }
  // The panel shows it WHEN its row matches (aiReview.pr === panel.row.number).
  // Use of the bottom global status line for AI-review matters (progress/final
  // state) has been RETIRED — the status line at most gives input feedback
  // ("no AI review running…").
  const [aiReview, setAiReview] = useState(null)
  // (2) THE REVIEW-CASCADE-MENU STATE — replacing the RETIRED confirmation modal.
  //
  // Shape: the core's `reviewMenuOpen` state (`{ stage, armedAt, pathIndex,
  // model, budget, warning? }`), or `null` (closed menu).
  //
  // WHY A SEPARATE STATE, AND WHY NOT IN `panel.modal`: the menu is NOT a
  // modal. `panelToModal` also switches the MODE (`mode: 'modal'`), from which
  // `panelKeys` excludes list navigation and `d`/`a`/`m` — but the menu lives
  // in the panel's INLINE mode, in the footer's place. Had it gone into the
  // modal state, opening the menu would have silently taken away all of the
  // panel's other keys, and the `modalHasChoices`-based arrow branches would
  // have kicked in too (up/down would step the choice instead of the list).
  // The SEPARATE state is thus not a convenience: it's the separation of the
  // two dialog typologies (inline vs. modal).
  //
  // BINDING TO THE ROW: the menu carries WHICH PR it was opened for in the
  // `pr` field. `j/k` don't live under the menu (see the useInput menu
  // branch), but poll/reload can rewrite the model — a menu not bound to a
  // row number would then start a review on a DIFFERENT PR (the same stale
  // class that the measurement callbacks' `row.number !== pr` guard excludes).
  const [reviewMenu, setReviewMenu] = useState(null)
  // THE TICK COUNTER: steps once a second while a review is running, and
  // drives BOTH the panel's elapsed-time row AND the list row's Braille
  // spinner AT THE SAME TIME (point 4's requirement: with the existing
  // ticker, NOT a separate timer). Doesn't step without a review, so it
  // doesn't render either.
  const [aiTick, setAiTick] = useState(0)
  // ARMING THE DOUBLE-`x` (the user's request, literally: "abort/discard
  // should need pressing 'x' twice"). Shape: { pr, kind: 'abort' | 'discard' }
  // or null. The first `x` arms it (the label switches to "confirm
  // abort/discard"), the SECOND executes. ANY OTHER key cancels it (reset at
  // the very top of useInput), so the armed state can't get stuck; completion
  // during a review fails on the KIND match (an abort-arm doesn't execute a
  // discard — it re-arms instead). Does NOT affect the dwell gate (armedAt).
  const [xArm, setXArm] = useState(null)
  // THE UNIFIED PR PANEL — ONE state in place of the previous FOUR dialogs.
  //
  // THE PREVIOUS STATE: `info` AND `confirm` were SEPARATE state, and the FOUR
  // dialogs (info / approve / merge / ai-review) opened and closed
  // independently of each other. It had two measured consequences:
  //
  //   1) THE LOOP: in the info panel, `a`/`m`/`r` fell into the "any other
  //      key" branch — it SILENTLY closed the panel and started nothing. The
  //      user had to exit in order to act ("look → step back → act").
  //   2) THE ORPHAN CONFIRM: the closing paths drifted apart (one branch
  //      closed one, but not the other). A confirm left open above the list
  //      meant the next `y` would confirm a PR that was ALREADY FORGOTTEN.
  //
  // THE NEW MODEL: ONE state, with two MODES (the mode follows from the
  // dialog typology, not from configuration — see the core's PANEL section):
  //   mode 'inline' — INFO: BELOW the selected row, the list stays visible the
  //     whole time, and you can also navigate below the panel (even during a
  //     measurement).
  //   mode 'modal'  — CONFIRMATION: the RENDER is the same inline panel (5a:
  //     the list stays visible), but up/down steps the CHOICE, not the list,
  //     and d/r/a/m are inactive.
  //
  // `progress` (the measurement state machine) lives in the PANEL's state, not
  // in a separate state: the measurement is one of the panel's bars, and
  // splitting it out would bring back exactly that four-dialog fragmentation.
  // NOT the same as `busy`: busy would BLOCK (it makes sense for spawnSync-based
  // actions), whereas here the whole point is that the UI stays usable.
  const [panel, setPanel] = useState(null)
  // THE MODAL CHOICE INDEX (up/down arrow). Separate state, NOT in the panel:
  // stepping it doesn't touch the panel's content or the dwell anchor
  // (armedAt), so rewriting a panel object here would just be noise — and
  // rewriting `armedAt` carries a RISK too (the dwell gate could be restarted
  // indefinitely by mashing the arrow, exactly as stated for the 'b'/Tab branch).
  const [choiceIndex, setChoiceIndex] = useState(0)
  // (wf31/30) THE `caveatOpen` STATE RETIRED — TWO STATES INSTEAD OF THREE.
  //
  // The user's decision: "in the info panel, the detailed info has three
  // states compared to main: idle (no info, offers c), verdict collapsed, and
  // verdict expanded. And Enter is taken here. That's not right. Let there be
  // TWO states. Idle and loaded details. That frees up Enter for the info
  // toggle."
  //
  // Measurement details NOW always show expanded, if there's a measurement —
  // the full rationale sits at the head of `caveatLines` in the render. The
  // `Enter` freed up this way CLOSES THE PANEL (see the `key.return` branch).
  // THE TWO VIEWS derive from panel state. NOT a separate state: DERIVED — so
  // it's structurally impossible for the two to drift apart (the old code left
  // an orphan confirm for exactly this reason).
  //
  //   `modal` — the CONFIRMATION data (kind/row/blockers/armedAt/summary/…).
  //     This is what the old `confirm` state carried, and `confirmBody`/
  //     `confirmAccepts` still expect this shape today — so the CONTRACT is
  //     UNCHANGED, only the storage was merged.
  //   `info`  — the panel's INFO view ({ row, progress }), as `infoBody` and
  //     the progress reducer expect it.
  const modal = panel?.mode === 'modal' ? panel.modal : null
  const info = panel ? { row: panel.row, progress: panel.progress } : null
  // Handle of the running measurement (for killing it). Ref-like state: we
  // don't render from it, we only abort with it — so writing to it doesn't
  // trigger a re-render either.
  const diagHandle = React.useRef(null)
  // THE MOST RECENT AI-review's MEASURED metadata: { row, model, costUsd,
  // sessionId, generated }. It's state because the following 'f' upload
  // writes the body's attribution from it — the model was MEASURED, not
  // declared, and the generated-vs-kept ratio is the human-gate metric. Kept
  // per PR: if the user moves to another row and uploads there, the
  // attribution must NOT carry over.
  const [aiRun, setAiRun] = useState(null)
  // THE ERROR OVERLAY's state: { row, message }.
  //
  // WHY THE STATUS LINE ISN'T ENOUGH (the user's point 1 names the error
  // message explicitly): the dimmed one-line status at the bottom of the list
  // (a) truncates multi-line gh/git stderr to one line, so the real cause
  // doesn't even show, and (b) the NEXT status write — even a plain j/k
  // navigation — silently overwrites it. A denied merge or a failed approve
  // thus looks as if it never happened. The overlay STOPS the user: it must be
  // acknowledged.
  //
  // It does NOT replace the status line, it SUPPLEMENTS it: the status is the
  // short summary (still readable after the overlay closes), the overlay is
  // the full text.
  const [errorState, setErrorState] = useState(null)
  // THE SINGLE error-display path. Every error branch goes through this, so
  // the "status line + overlay" pair can't drift apart (one branch opening an
  // overlay, the other silently only writing status — exactly the measured
  // defect).
  const showError = useCallback((row, message) => {
    const text = String(message ?? '').trim() || 'unknown error'
    // The status line is the ONE-LINE summary (the overlay shows the full text).
    setNotice(`error: ${text.split('\n')[0]}`)
    setErrorState({ row: row ?? null, message: text })
  }, [])

  /**
   * OPENING THE CONFIRMATION MODAL — via a SINGLE path, for every action.
   *
   * WHY IN ONE PLACE: in the old code FOUR separate `setConfirm({...})` calls
   * existed (approve / merge / upload / ai-review), and each one set
   * `armedAt` itself AND decided for itself what to do with an open info
   * panel. The dwell gate (confirmAccepts) thus lived and died in four
   * places, and one forgotten `armedAt` would have SILENTLY disabled the
   * typeahead protection on that one branch.
   *
   * `panelToModal` KEEPS `row` AND `progress`: if the modal opens from an
   * already-open INFO panel, Esc STEPS BACK to the panel, and the measured
   * diagnosis isn't lost. If there was no panel (opened from the list),
   * `panelOpen` now opens one — so Esc goes to the PANEL there too, meaning
   * the "look → act → look again" loop closes in ONE place, as the user
   * requested.
   *
   * THE CHOICE INDEX RESETS: every new decision starts at NO (fail-closed).
   * Without this, a cursor left on "Yes" from a previous modal would carry
   * over to the next one — exactly the kind of sticky state that's
   * unacceptable for an irreversible action.
   */
  const openModal = useCallback((row, modalProps) => {
    setChoiceIndex(0)
    setPanel((cur) => panelToModal(cur ?? panelOpen({ row }), { armedAt: Date.now(), ...modalProps }))
  }, [])

  /**
   * Partial update of an open MODAL (budget switch, review-path stepping).
   *
   * `armedAt` is DELIBERATELY left untouched: these gestures mean neither
   * confirmation nor abort, so the dwell gate must not restart. If they did
   * arm it, the 250 ms protection could be restarted INDEFINITELY by mashing
   * the ceiling/path control — the typeahead gate would become bypassable on
   * exactly the path that spends the most tokens (AI review).
   */
  const patchModal = useCallback((patch) => {
    setPanel((cur) => (cur?.mode === 'modal' ? { ...cur, modal: { ...cur.modal, ...patch } } : cur))
  }, [])

  /**
   * Reloading the queue. The `hard` path (the `R` key) ALSO invalidates the
   * cache; the soft path (a reload after an action) does NOT — an action
   * (approve / merge / findings upload) doesn't move the merge-tree probes'
   * results, and a silent cache drop would force a re-measurement after every
   * approve, i.e. bring back exactly the slowdown the cache was built to avoid.
   *
   * THE MAIN SHA IS REFRESHED ON EVERY LOAD: if main has moved, the anchor
   * moves, so the EXISTING entries become STALE — without deletion, because
   * the list needs to signal that a measured result EXISTS, it's just no
   * longer valid.
   */
  const reload = useCallback(({ hard = false } = {}) => {
    try {
      const fresh = fetchQueue()
      // THE ORDER is load-bearing: cache invalidation runs BEFORE setting the
      // model, otherwise one render would still see the old (now invalid)
      // entries as "fresh" against the new anchor.
      if (hard) cacheInvalidateAll(cache.current)
      const sha = fetchMainSha()
      setMainSha(sha)
      // THE REBUILD STATE is measured on the same load path as the main SHA.
      // `fetchRebuildStatus` is FAIL-SOFT (`null` for anything unmeasurable),
      // so no try/catch: a rebuild status can't fail the queue load.
      setRebuild(fetchRebuildStatus())
      setModel(fresh)
      setLoadedAt(new Date())
      bumpCache()
      // (wf31/25) CLEANING UP THE OPTIMISTIC MARKS — whatever the fresh model
      // ALREADY reflects drops out here. Without this, a mark would GET STUCK:
      // an `approved` optimistic entry would forever override the rmark, even
      // if the review had meanwhile been revoked.
      //
      // THE TWO STATES REACH THEIR GOAL DIFFERENTLY, hence two separate
      // conditions:
      //   · `merged` — the PR has DISAPPEARED from the open list (this is the
      //     goal; the model has caught up);
      //   · `approved` — `reviewDecision` has ARRIVED as `APPROVED`.
      // Whatever has NOT yet been fulfilled STAYS — the next reload examines
      // it again.
      setOptimistic((cur) => {
        const keys = Object.keys(cur)
        if (keys.length === 0) return cur
        const byNumber = new Map(fresh.map((r) => [r.number, r]))
        const next = {}
        for (const k of keys) {
          const row = byNumber.get(Number(k))
          if (cur[k] === 'merged') {
            // The row is STILL there → the mark is needed. If it's gone, the
            // mark has nothing left to override.
            if (row !== undefined) next[k] = 'merged'
          } else if (cur[k] === 'approved') {
            // The model doesn't know about the approve YET → keep it. If it
            // already does (or the row is gone), let it go.
            if (row !== undefined && row.reviewDecision !== 'APPROVED') next[k] = 'approved'
          }
        }
        // SAME REFERENCE FOR IDENTICAL CONTENT: `buildRows`'s memo also watches
        // `optimistic`, and a new (but equal) object would recompute the whole
        // row list on every reload.
        return keys.length === Object.keys(next).length ? cur : next
      })
      // THE POLL'S BASELINE RESTARTS: any earlier staleness indicator GOES
      // AWAY — the user just did what the indicator asked for. A leftover
      // indicator after a refresh would teach the user that the indicator
      // lies, and they'd stop trusting it.
      //
      // THE BASELINE IS BUILT ON THE SAME PATH AS THE PROBE
      // (`fetchStalenessProbe`), NOT from the freshly loaded `queue --json`
      // model.
      //
      // WHY — A MEASURED BUG, FROM A LIVE RENDER: the first version computed
      // the baseline from the queue model ("it's free, the fields already
      // exist"). But the TWO SOURCES CAN DIFFER: `queue --json` reads with its
      // own filtering and at its own moment, the poll reads with its own `gh
      // pr list` at its own moment. If the two signatures differ (because
      // something genuinely changed meanwhile, or because the two fetches see
      // different moments), then the FIRST tick after `R` IMMEDIATELY detected
      // "drift" — the indicator came right back, and it could NEVER be made to
      // go away. In a live render this behaved exactly like that: after `R`,
      // the header kept showing "⟳ stale", i.e. a lying, forever-blinking
      // warning — the exact failure class this feature was meant to eliminate.
      //
      // THE COST (measured ~550 ms) IS DELIBERATELY ACCEPTED, and it's not in
      // the UI's way: `queue --json` itself is ~1.8 s, so the baseline probe
      // is ~30% of the load, and it runs ONLY at load time (not per render).
      // The alternative — comparing signatures taken from two different
      // sources — isn't a performance question, it's a CORRECTNESS one:
      // different sources can't be measured against each other.
      const base = fetchStalenessProbe()
      poll.current = pollInit({
        now: now(),
        // On a FAILED probe the baseline is `null`: `stalenessChanged` is
        // fail-closed against false positives (nothing to measure against →
        // no "stale"), and the next SUCCESSFUL probe picks up the baseline.
        // So a momentary network error at load time does NOT cause a false
        // indicator.
        signature: base.ok ? base.signature : null,
      })
      setPollLabel('')
      setNotice(`${fresh.length} PRs in the queue${hard ? ' (refresh: cache invalidated)' : ''}`)
    } catch (error) {
      // A queue-load error is NOT row-specific (nothing to select), but it
      // still gets an overlay: without it the TUI would show an empty list
      // with no explanation, which reads as "no PRs" — a lying silence where
      // a fail belongs.
      showError(null, `queue failed to load: ${error.message}`)
    }
  }, [bumpCache, showError, now])

  /**
   * The BACKGROUND variant of the soft reload — the path taken after closing
   * the hunk view (5/2).
   *
   * WHY A SEPARATE PATH (the 2nd finding of the user's 5th run, MEASURED with
   * a timestamped spawn log, a hard cost projection): the reload() after `q`
   * ran, INSIDE runExclusive, as spawnSync — queue --json ~1.9 s + git
   * rev-parse ~60 ms + gh pr list staleness probe ~0.55 s —, so the app showed
   * "working…" for ~2.5 seconds and was DEAF (the event loop was blocked too:
   * a pressed key died on the busy guard). The contract: after the view
   * closes, the UI is IMMEDIATELY alive, and the fresh queue arrives in the
   * background.
   *
   * Writes the SAME states as reload()'s soft path (model, main SHA, cache
   * version, poll baseline, status) — there is no `hard` branch here: this
   * path is always the soft refresh after an action. Error handling is also
   * reload()'s: an overlay, not a throw.
   */
  const reloadAsync = useCallback(async () => {
    try {
      const fresh = await fetchQueueAsync()
      const sha = await fetchMainShaAsync()
      setMainSha(sha)
      // THE REBUILD STATE is measured on the same load path as the main SHA.
      // `fetchRebuildStatus` is FAIL-SOFT (`null` for anything unmeasurable),
      // so no try/catch: a rebuild status can't fail the queue load.
      setRebuild(fetchRebuildStatus())
      setModel(fresh)
      setLoadedAt(new Date())
      bumpCache()
      // The POLL's BASELINE is built via the PROBE path here too (not from the
      // queue model) — the same principle and the same measured failure class
      // as in reload().
      const base = await fetchStalenessProbeAsync()
      poll.current = pollInit({
        now: now(),
        signature: base.ok ? base.signature : null,
      })
      setPollLabel('')
      setNotice(`${fresh.length} PRs in the queue`)
    } catch (error) {
      showError(null, `queue failed to load: ${error.message}`)
    }
  }, [bumpCache, showError, now])

  useEffect(() => { reload() }, [reload])

  // --- (1d) LAZY HYDRATION OF THE DISK CACHE (ONCE, at startup) -------------
  //
  // WHEN: AFTER the queue ARRIVES, because the anchor comparison NEEDS the
  // PR's `updatedAt` — which comes from the queue. `mainSha` is set in the
  // same load.
  //
  // WHY ONCE (`hydratedRef`): disk reads are I/O. `model`/`mainSha` change on
  // EVERY reload (`R`, soft reload after an action), so as a dependency every
  // refresh would re-read /tmp — but nothing changed on disk meanwhile (WE
  // write it, and the memory cache already knows about that). Hydration is
  // about the session's STARTUP: "what did we bring along from earlier runs".
  //
  // THE SUBJECT ANCHOR MUST MATCH, THE TOOL ANCHOR NEEDN'T (the review-store
  // header's ranking): a `stale` (moved diff) entry is NOT loaded — the
  // review was about a DIFFERENT state of the PR, so as a finding it would be
  // a FALSE claim about the current code. `tool-drift` (same diff, measured
  // by a DIFFERENT core version) IS loaded, though, marked with a caveat.
  // (The store also keeps the stale file; a future `~`-flagged use has the
  // data, but the load path stays clean.)
  const hydratedRef = React.useRef(false)
  useEffect(() => {
    if (hydratedRef.current) return
    // We WAIT for the queue: with an empty model we couldn't compare against
    // the anchor, and a load without an anchor would create exactly the
    // stale-findings bug.
    if (loadedAt === null || model.length === 0) return
    hydratedRef.current = true
    try {
      const stored = reviewStoreLoadAll({ repoRoot: fetchRepoRoot() })
      const coreSha = fetchCoreSha()
      let restored = 0
      // ACCOMPANYING DATA FOR THE RESTORED ONES: the summary (verdict) and the
      // tool-drift indicator, keyed by PR — see `restoredReviews`'s header.
      const carried = {}
      for (const row of model) {
        const entry = stored[row.number]
        if (!entry || !Array.isArray(entry.findings) || entry.findings.length === 0) continue
        const anchor = reviewStoreAnchor({ row, mainSha, coreSha })
        const state = reviewStoreEntryState(entry, anchor)
        // THE DECISION GOES THROUGH THE CENTRAL MAPPING
        // (`reviewStoreStateLoadable`), NOT a strict `!== 'fresh'` here. A
        // MEASURED FAILURE CLASS: exactly this kind of strict equality once
        // turned a core mismatch equivalent to `tool-drift` into a silent
        // load ban — the user's finding #904. A future fourth state would
        // fall into the blocking branch just as silently.
        if (!reviewStoreStateLoadable(state)) continue
        // THE SUMMARY AND THE DRIFT INDICATOR TRAVEL TOGETHER. `summary` comes
        // from the store (the memory cache doesn't store a summary),
        // `toolDrift` comes from the state.
        carried[row.number] = {
          summary: typeof entry.summary === 'string' && entry.summary.trim() !== ''
            ? entry.summary
            : null,
          toolDrift: state === 'tool-drift',
        }
        // Goes INTO THE MEMORY CACHE, with `applied: false` (the store never
        // gives anything else): from here on the EXISTING lifecycle carries
        // it — `r` announces "opening review", and the opening loads the
        // notes into the hunk via the logic bound to session identity.
        cacheStoreAiFindings(cache.current, row.number, entry.findings)
        // THE REVIEW TRACE IS ALSO RESTORED: the review ACTUALLY ran (the
        // spend happened), just in an earlier process. Without the trace, the
        // attestation body would fall into the shorter ("no review happened")
        // branch — that would be a lie.
        markReviewTrace(cache.current, row.number, 'ai')
        restored += 1
      }
      if (restored > 0) {
        bumpCache()
        // THE ACCOMPANYING DATA goes to the RENDER INPUT: the panel's review
        // section gets the summary and the drift caveat from here.
        setRestoredReviews(carried)
        // (wf31/54) THE RESTORE NOTICE RETIRED. The user's finding about the
        // header: "1 cached review restored (from disk) (of which 1 was
        // measured with a different core version) — I don't think this text
        // is needed, too much info."
        //
        // THE OLD RATIONALE ("silent restoration is worse, it doesn't show
        // what's ready") HAS SINCE BECOME OBSOLETE: the restored review trace
        // is VISIBLE per PR in the list (`⊙`, in `whiteBright` since wf31/49,
        // clearly visible) — so the user sees it right on the row where they
        // decide, not in a global summary.
        // The drift caveat likewise lives in the PANEL (drift caveat), on the
        // `d` path — right where they look at the review too.
        //
        // AND IT ALSO OVERWROTE THE BETTER ONE: the load/refresh path already
        // prints the queue count (`N PRs in the queue`), and this call
        // repeated the SAME THING with a long tail — i.e. it replaced a
        // short, useful indicator with a longer one that was already
        // degrading at the right edge of the header anyway.
        //
        // WHAT REMAINS: `setRestoredReviews(carried)` and `bumpCache()` —
        // those are the parts that matter for BEHAVIOR (the panel's review
        // section and the drift caveat live off them), not the text.
      }
    } catch {
      // FAIL-SOFT: non-git cwd, unreadable /tmp. The TUI keeps working with
      // the memory cache, and no raw error goes into the UI.
    }
  }, [loadedAt, model, mainSha, bumpCache])

  // THE ROWS are COMPUTED from the raw model + the cache states, on every render.
  //
  // THE CACHE STATES IN ONE PASS over the model: one Map read + one anchor
  // comparison per PR, PURELY (no gh, no git, no hunk). This is the concrete
  // shape of the user's point 4: the indicator doesn't slow down the list,
  // because producing the indicator isn't I/O. `cacheVersion` is the
  // dependency: the indicator refreshes because the cache changed — not
  // because the queue is reloaded.
  // THE ROW SPINNER (4): while a review is running on a PR, its row gets a
  // 1-cell Braille spinner. The frame index is the existing ticker's
  // `aiTick` — there is NO separate timer. Without a review the map is null,
  // so the flag column is unchanged.
  const spinningPr = aiReview && (aiReview.status === 'running' || aiReview.status === 'starting')
    ? aiReview.pr
    : null
  const { rows, cacheStates } = React.useMemo(() => {
    const states = {}
    const traces = {}
    for (const r of model) {
      const anchor = cacheAnchor({ row: r, mainSha })
      states[r.number] = cacheState(cache.current, r.number, anchor)
      traces[r.number] = hasReviewTrace(cache.current, r.number)
    }
    return {
      rows: buildRows(model, {
        cacheStates: states,
        reviewTraces: traces,
        reviewSpinners: spinningPr === null ? null : { [spinningPr]: aiTick },
        // (wf31/72) THE RUNNING ACTION IS TIED TO THE ROW: the PR left behind
        // still shows it's working even once the cursor has moved elsewhere.
        // `pendingKey` is WHICH action, `pendingPr` is WHICH row — the two are
        // set together and vanish together in `runExclusive`, so they can't
        // drift apart.
        pendingAction: pendingPr !== null && pendingKey !== null
          ? { pr: pendingPr, key: pendingKey }
          : null,
        optimistic,
      }),
      cacheStates: states,
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, mainSha, cacheVersion, spinningPr, aiTick, optimistic, pendingPr, pendingKey])

  const selectable = rows.filter((r) => r.selectable)
  const current = selectable[index]

  // The title column adapts to the TERMINAL's width: with fixed padding, on a
  // narrow terminal Ink wraps (the row breaks into two lines, the separator
  // collapses).
  //
  // THE FIELD'S NAME IS `columns`, NOT `width` — A MEASURED BUG: `const {
  // width } = useWindowSize()` ALWAYS returned undefined (Ink returns `{
  // columns, rows }`), so the 120 fallback below hit on every render.
  // Consequence: on a 60-column terminal, list degradation NEVER kicked in
  // (the wrapping reported three times over), and the overlay's frame ended
  // up fixed at 118 cells. Measured in live Ink rendering at 60/100/190
  // columns — static tests don't catch this class of bug, because the call
  // itself is syntactically fine.
  // THE FALLBACK is decided HERE, in ONE place: on a non-TTY (or mid-resize),
  // columns can be 0/undefined, and a width of 0 would swallow every column.
  // (wf31/33) OUR OWN WIDTH MEASUREMENT FROM THE RESIZE EVENT.
  //
  // WHY INK'S `useWindowSize` ISN'T ENOUGH BY ITSELF: it too sets state off
  // the `stdout` 'resize' event, BUT our own calculation also uses a SECOND,
  // derived measure via `layout.width` (the table's width from its content)
  // — and the two can diverge within the same tick. `process.stdout.columns`
  // comes from the KERNEL (TIOCGWINSZ), so it's valid at the very moment of
  // resize, and this closes that gap.
  //
  // THIS DOESN'T FIX THE GLITCH ITSELF (measured, in the user's finding) —
  // `alternateScreen` answers that, see the head of `runTui`. This
  // measurement is correct in its own right, though: rows are built with the
  // real measure on the FIRST resize render, not a tick late.
  const [measuredSize, setMeasuredSize] = useState(() => ({ columns: process.stdout.columns || 0, rows: process.stdout.rows || 0 }))
  // (wf31/37) DEBOUNCING THE RESIZE — against the FLICKER while shrinking.
  //
  // From the user's finding: "when shrinking there's wrapping flicker, but it
  // recovers afterward". The "recovers" part is the key: the FINAL STATE is
  // correct (full screen mode fixed it), the flicker comes from the
  // IN-BETWEEN frames.
  //
  // THE MECHANISM: while dragging with the mouse, the terminal sends DOZENS
  // of `resize` events (one per cell). Each one runs Ink's `resized` (clear +
  // layout + render) AND our state update (another render). The frames race
  // each other: one hasn't even been written out yet when the next one
  // already wants to clear — and in the in-between states the width measures
  // can drift by a tick, so a given frame renders WRAPPED.
  //
  // THE DEBOUNCE merges the IN-BETWEEN renders: during the drag, only the
  // very last size counts. `50 ms` is the usual UI threshold — an
  // imperceptible delay, but it collapses a 20-event drag into 1-2 renders.
  //
  // WHY WE DON'T DEBOUNCE `useWindowSize` ITSELF: that belongs to INK, not to
  // us. Ink's `resized` runs on every event regardless (we can't influence
  // that) — but it's OUR state update that also triggers the tree's
  // RECOMPUTATION, so debouncing here is the most effective.
  //
  // A SINGLE LISTENER: the earlier (wf31/33) IMMEDIATE update was DROPPED.
  // Two listeners on the same event would have been a CONTRADICTION: the
  // immediate branch requested a render on every event, producing exactly
  // the flood of frames the debounce is meant to eliminate.
  //
  // THE CONSEQUENCE, stated plainly: during the resize gap (~50 ms),
  // `width`/`termRows` sit at the OLD measure, so in-between frames can wrap.
  // This is DELIBERATELY accepted: the hard clamp of `Row`/header
  // (`clampCells`) absorbs it too, and the final state is always correct —
  // the flicker is shorter than the competing renders would be.
  useEffect(() => {
    let timer = null
    const onResize = () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        setMeasuredSize({ columns: process.stdout.columns || 0, rows: process.stdout.rows || 0 })
      }, 50)
      // The `unref` is LOAD-BEARING: without it, a pending timer would also
      // delay the TUI's exit (Node keeps the event loop alive because of it).
      timer.unref?.()
    }
    process.stdout.on('resize', onResize)
    return () => {
      process.stdout.off('resize', onResize)
      if (timer !== null) clearTimeout(timer)
    }
  }, [])
  const { columns } = useWindowSize()
  // (wf31/28) THE FALLBACK IS THE REAL TERMINAL WIDTH, NOT A FIXED 120.
  //
  // From the user's finding: "the app is responsive, but there's an annoying
  // artifact where the header and the highlighted row jumble up at the top
  // when I shrink the ghostty window (also happens in Terminal.app)".
  //
  // THE MEASURED MECHANISM: during resize, Ink's `useWindowSize()` can
  // TEMPORARILY return `0`/`undefined` columns (between the SIGWINCH and the
  // state update), and the old `|| 120` fallback then produced a LYING, FIXED
  // width. In a window shrunk to 70 cells, the header and the highlighted row
  // were thus built at 120 cells — and Ink WRAPPED them, which is exactly the
  // reported "jumbling". The effect has been MORE VISIBLE since the
  // highlight was introduced (wf31/26): the background fill also paints the
  // wrong width, so the wrapped remainder sits as a colored strip on the next
  // line.
  //
  // `process.stdout.columns` comes from the KERNEL (TIOCGWINSZ), so it's
  // VALID at the very moment of resize — no React-state lag in it. The fixed
  // `80` is now only a fallback for the truly unknown case (non-TTY), and
  // there the conservative (NARROWER) value is correct: an underestimated
  // width TRUNCATES, an overestimated one WRAPS — and wrapping is the
  // measured failure class (the mark column drifts row by row).
  // (wf31/33) WIDTH FROM THREE SOURCES, THE SMALLEST WINS.
  //
  //   · `measuredColumns` — OUR OWN resize measurement (from the kernel). At
  //     the moment of resize this is the freshest;
  //   · `columns` — Ink's `useWindowSize`. Can lag by a tick, but on normal
  //     (non-resize) renders this is the authoritative source;
  //   · `process.stdout.columns` — a direct measurement, for when the states
  //     are still empty (first render).
  //
  // WHY THE SMALLEST: an UNDERESTIMATED width TRUNCATES (cosmetic), whereas
  // an OVERESTIMATED one WRAPS — and wrapping throws off Ink's row-number-based
  // clearing (this is the reported "jumbling"). The two error directions
  // don't cost the same, so we pick the conservative direction.
  //
  // The `80` is the final fallback: on a non-TTY (test harness, pipe) neither
  // measurement gives a value, and a width of 0 would swallow every column.
  // (wf31/38) THE IMMEDIATE CAP — THE PATTERN ESTABLISHED BY HUNK.
  //
  // From the user's finding: "I checked hunk standalone. It debounces both on
  // shrink and on grow, so the debounced approach is entirely fine, it's just
  // that in our TUI we need to prevent wrapping specifically on shrink. Hunk
  // somehow avoids wrap flicker, just an immediate cap."
  //
  // SEPARATING THE TWO MEASURES — THIS IS THE CORE OF THE SOLUTION:
  //   · `layoutWidth` (DEBOUNCED) — the TABLE is built from this: the title
  //     column's budget, the tail-degradation level, the header's alignment.
  //     RECOMPUTING these is expensive and jumpy, so debouncing them is CORRECT;
  //   · `capWidth` (IMMEDIATE) — the CLAMP ceiling comes from this. This is
  //     the physical limit: if the terminal is narrower RIGHT NOW, the row
  //     must NOT overhang RIGHT NOW — otherwise the terminal wraps, and
  //     wrapping throws off Ink's clear computation (the flicker).
  //
  // WHY THIS WORKS WITHOUT FLICKER: on shrink the cap drops IMMEDIATELY, so
  // rows FIT even in the in-between frames (truncated, but not wrapped) — and
  // the table layout settles on its final measure after 50 ms. On GROW the
  // cap gets bigger while the table is still at the old (narrower) measure:
  // there the rows simply don't use the new space yet, which shows up ONLY as
  // delayed responsiveness — and per the user, that's "fine".
  //
  // `process.stdout.columns` comes from the KERNEL (TIOCGWINSZ), so it's
  // valid at the very moment of resize — no React-state lag in it. That's why
  // it's NOT state: it's fresh on every render, and the render runs anyway
  // because of Ink's `resized`.
  const capWidth = process.stdout.columns || 0
  const widthCandidates = [measuredSize.columns, columns, process.stdout.columns]
    .filter((n) => typeof n === 'number' && n > 0)
  const width = widthCandidates.length > 0 ? Math.min(...widthCandidates) : 80
  const layout = listLayout(rows, width)

  // THE SEPARATOR LINES' WIDTH — THE TABLE'S EDGE, WITH A PHYSICAL CEILING.
  //
  // `layout.width` is the table edge computed FROM THE CONTENT (the same
  // measure `Row`'s background and the header's `notice` get), while
  // `capWidth` is the IMMEDIATE terminal measurement. The SMALLER wins, and
  // this isn't caution: a line wider than the terminal would WRAP, and
  // wrapping throws off Ink's clear computation — that's the root of the
  // resize flicker (see `Row`'s `terminalColumns` rationale).
  const separatorWidth = capWidth > 0
    ? Math.min(capWidth, layout.width || capWidth)
    : layout.width

  // THE LEGEND-PENDING'S SINGLE SOURCE OF TRUTH — COMPUTED IN ONE PLACE. Two
  // legends read it (the list's footer and the panel's); both must show the
  // SAME thing — computed separately, the two could drift apart.
  const activePendingKey = busy ? pendingKey : null

  // OPENING / SWITCHING THE HUNK SESSION — the single path for SESSION
  // AFFINITY.
  //
  // The user's request: "couldn't the TUI keep its own singleton hunk
  // session?" Given the MEASURED limits of hunk's API, this is the most we
  // can do:
  //
  //   - only `hunk diff`/`hunk show` can OPEN a session, and it starts an
  //     INTERACTIVE TUI (there's no `--headless`/`--detach`/`--background`),
  //     so opening always means taking over the terminal;
  //   - `hunk session reload --repo … -- diff <range>`, though, REPLACES the
  //     content of a LIVE session — so switching PR does NOT need a new hunk
  //     to be started.
  //
  // THE ORDER, WHICH IS THE CONTRACT:
  //   1. RELOAD, if a live session exists (preserving the singleton). This is
  //      FREE and does NOT take over the terminal.
  //   2. If none is live (or the session is ORPHANED — deleted repo root,
  //      dead daemon), OPEN: `hunk diff` with the CORRECT cwd.
  //
  // `wantView` decides whether the VIEW also needs opening:
  //   - for `d` (diff review), YES — reload does NOT bring hunk to the
  //     foreground, so the view also needs opening AFTER the reload,
  //     otherwise the user pressed `d` and would see nothing;
  //   - on `r` (AI review)'s session-OPENING path the view is a SIDE EFFECT
  //     (the session is needed, not the view), but hunk can't open without a
  //     view — so it opens there too, and the user closes it with `q`.
  //
  // THE CWD IS LOAD-BEARING (this was the root cause of the user-reported
  // bug): `hunk diff` must start FROM THE REPO ROOT, otherwise the session
  // gets created at a DIFFERENT root than the one `hunkComments(repoRoot)`
  // looks for via the `--repo` flag.
  const openHunkView = useCallback(async (row, { wantView, agentNotes = false }) => {
    const repoRoot = fetchRepoRoot()
    const [base, head] = fetchPrRefs(row.number)
    // 1. RELOAD: if a live session exists, switch that one — we don't open a
    // new one.
    const reloaded = reloadHunkSession(repoRoot, base, head)
    // Opening the VIEW. Also needed AFTER a reload if the user wants to SEE it
    // (`d`): the reload swaps the CONTENT, it does NOT bring the hunk TUI to
    // the foreground.
    if (!reloaded || wantView) {
      // `agentNotes` is the REVIEW-OPENING path (measured: `hunk diff
      // --agent-notes` = "show agent notes by default") — the AI comments are
      // visible right away.
      // (wf31/19) PASSING THE TERMINAL SIZE: the child runs in its OWN PTY
      // (`script -q /dev/null` — the freeze fix, see `reviewCommand`'s
      // header), and that PTY's size is NOT the real terminal's. For the hunk
      // TUI to draw correctly, the measured size must be set on it.
      //
      // THE SOURCE is `process.stdout`, NOT React's `useWindowSize()`: this
      // callback runs via `suspendTerminal`, where Ink is currently dropping
      // renders — a value read at render time could be stale here.
      // `process.stdout.columns/rows` is the truth valid at the moment of SPAWN.
      //
      // ON A NON-TTY, `null` IS PASSED (`columns` is `undefined` there):
      // `reviewCommand` also skips the `stty` prefix in that case — we don't
      // write in a made-up size.
      const [cmd, args] = reviewCommand(row.number, base, head, {
        agentNotes,
        columns: process.stdout.columns ?? null,
        rows: process.stdout.rows ?? null,
      })
      // AN ASYNCHRONOUS child (not `spawnSync`): the hunk TUI runs until the
      // user's `q`, and `spawnSync` would BLOCK Node's event loop until then —
      // which would make a parallel background review IMPOSSIBLE IN PRINCIPLE
      // (measured: the session was already alive, yet the waiting poll still
      // didn't run again, claude only started after the diff was closed). See
      // `openReviewView`'s header.
      // (wf26) THE CHILD GETS ITS OWN `/dev/tty` fd (see `reviewSpawnOptions`'s
      // header): with `stdio: 'inherit'`, Node's libuv got STUCK in the TTY's
      // blocking `read()`, the hunk child turned into a zombie, and the TUI
      // FROZE FOREVER after the view closed (the user's finding from run 6).
      //
      // The `finally` ALWAYS closes the fd — on the throw path too: `d` runs
      // many times in a session, and the leak would kill the TUI with EMFILE.
      const spawnOpts = reviewSpawnOptions(repoRoot)
      // INPUT FOR THE NODE-PTY RELAY — from the `script`-based path's
      // `reviewCommand` (`ptyWrap`) only the OUTPUT (the `[cmd,args]` above)
      // is needed; the node-pty path needs the command WITHOUT the `script`
      // wrapper, written so it can go into `bash -c`. `reviewInnerCommand`
      // runs the SAME template substitution as `reviewCommand` — in one
      // place, so the two can't drift apart.
      const innerCommand = reviewInnerCommand(row.number, base, head, { agentNotes })
      // THE STUCK-VIEW WATCHDOG AND THE RETURN-PATH SHELL-FLASH COMPENSATION
      // ARE SHARED between the TWO (node-pty / script) paths — only ONE of
      // them runs per `d` press, so the sharing doesn't duplicate any side effect.
      const watchdog = makeStuckViewWatchdog(repoRoot)
      const onChildExit = () => {
        globalThis.__tuiprTrace?.('CHILD_EXIT (hunk exited)')
        process.stdout.write('\u001B[?1049h')
      }
      try {
        await suspendTerminal(async () => {
          // (wf31/48) RELEASING THE PENDING INDICATOR — HERE, AT THE VERY START
          // OF THE CALLBACK.
          //
          // The user's finding: "switching back from hunk to the TUI, the old
          // pending flashes for a moment."
          //
          // THE MECHANISM, from ink 7.1.1's source: `endSuspend()` calls
          // `onRender()`, which draws the INK DOM TREE (`render(this.rootNode)`)
          // — it does NOT re-run the React components. The DOM tree, though, is
          // mutated by React's COMMIT, and the commit runs DURING the suspend
          // TOO (only the terminal write is skipped: `onRender` returns early on
          // `isSuspended`). A `setState` during suspend thus REACHES
          // `endSuspend`'s frame — if React managed to commit it.
          //
          // THAT'S WHY IT'S HERE, NOT AT THE END OF THE CALLBACK: the hunk
          // session runs for SECONDS, and React commits plenty during that time.
          // A clear placed at the end of the callback would race the commit
          // against `endSuspend` — the previous round (wf31/46) failed on
          // exactly this.
          //
          // NO VISIBLE EARLY DISAPPEARANCE: Ink's `beginSuspend()` has ALREADY
          // cleared its own frame by this point (`log.clear()`), so the
          // indicator isn't visible anyway from here on — the screen belongs to hunk.
          //
          // (The wf31/47 `pendingMuted` REF WAS RETIRED — ITS OWN MEASURED BUG:
          // writing the ref did NOT TRIGGER A RE-RENDER, so `activePendingKey`
          // read at render time never got recomputed, and the DOM stayed
          // unchanged. The ref follows the `actionLock` pattern, which is a
          // value read in an EVENT HANDLER — it can't be carried over to render time.)
          globalThis.__tuiprTrace?.('CB_START (suspend callback entered)')
          setPendingKey(null)
          // (wf31/40) ELIMINATING THE SHELL FLASH — IMMEDIATELY BACK TO THE ALT SCREEN.
          //
          // From the user's finding: "switching TUI -> hunk briefly shows the
          // shell screen, would be good to avoid that."
          //
          // THE MECHANISM (ink 7.1.1, `beginSuspend`): suspend writes
          // `exitAlternativeScreen`, so we fall back to the PRIMARY buffer —
          // where the shell prompt and the scrollback live. Hunk only starts
          // AFTER THAT, and enters ITS OWN alt screen. So the shell's image
          // flashes between the two.
          //
          // THE FIX: as the callback's FIRST thing, we step back into the alt
          // screen. Hunk thus starts into an EMPTY secondary buffer, not into
          // the shell's image — the flash disappears. Hunk's own
          // `enterAlternativeScreen` afterward is then a no-op (we're already
          // there), and its exit pairs with our restoration in the `finally`
          // (wf31/37).
          //
          // WHY NOT BEFORE THE SUSPEND: there, Ink's `beginSuspend` still lies
          // ahead, and THAT would step out again — the order doesn't work reversed.
          //
          // FAIL-SOFT: `write` can throw on a closed stream, and a throw HERE
          // would take down the `d` path over a cosmetic operation.
          try {
            process.stdout.write('\u001B[?1049h')
          } catch { /* an error entering it can't fail opening the view */ }
          // (wf31/20) THE `process.stdin.pause()`/`resume()` PAIR RETIRED — IT
          // WAS ITS OWN BUG, AND CAUSED A NEW SYMPTOM.
          //
          // WHY IT WAS ADDED (wf31/18): at the time the freeze was thought to
          // be the parent's TTY read, and `pause()` is the stream-level stop.
          // A LATER MEASUREMENT showed the real cause was at the PROCESS GROUP
          // level (the kernel decides based on pgrp) — the own PTY (`script -q
          // /dev/null`) answers that, and `pause()` there is no longer NEEDED.
          //
          // WHY IT WAS HARMFUL: Ink's `resumeInput` (from `endSuspend`) calls
          // `attachReadableListener()`, which listens on the `'readable'`
          // EVENT. My `resume()`, though, put the stream into `flowing: true`
          // — there data flows on the `'data'` event, and `'readable'` does
          // NOT fire. The returning TUI thus stayed SILENTLY DEAF: in the
          // user's finding, after `q` there was "empty screen, the list
          // doesn't re-render."
          //
          // THE ORDER WAS WRONG TOO: my `resume()` ran in the callback's
          // `finally`, while Ink's `resumeInput()` ran AFTER THAT (in
          // `endSuspend`) — so my own `resume()` set a state that Ink's
          // restoration could no longer override.
          //
          // THE LESSON, WHICH IS WHY THIS COMMENT STAYS: Ink's `pauseInput`/
          // `resumeInput` pair is SYMMETRIC and SELF-CONSISTENT. Anyone who
          // sets stdin's state from the suspend callback BREAKS this
          // symmetry — handling stdin during suspend is INK'S JOB.
          //
          // (wf32) THIS DOCTRINE IS UNCHANGED, AND THE CALLS BELOW DON'T
          // BREAK IT: we're not calling stdin's STREAM API (pause/resume/
          // setRawMode) differently than Ink does — we're swapping the target
          // reference BEHIND the wrapper, which Ink doesn't even know about —
          // Ink still EXCLUSIVELY performs its own pause/resume calls, just on
          // a DIFFERENT target now (first none, then fresh).
          //
          // THE CALL SITE IS LOAD-BEARING (see the `DelegatingStdin` module
          // header for the full, measurement-backed rationale — there are TWO
          // MEASURED, INTERSECTING failure classes here, and correct timing
          // sits BETWEEN them):
          //   1. `destroyOldTarget()` BEFORE THE SPAWN: Ink's `beginSuspend()`
          //      (already ran above) has ALREADY detached the old target's
          //      'readable' listener via the wrapper — so the old target has
          //      NO active JS-side reader when we `destroy()` it. If this ran
          //      LATER (after the spawn), the blocking native `read()` would
          //      already be in progress (it forms WHILE the child is RUNNING).
          //   2. `attachFreshTarget()` AFTER `close`, NOT BEFORE: creating a
          //      fresh stream EARLIER (WHILE the child is RUNNING) would
          //      reintroduce the pre-wf26/wf31/19 TTY race — the fresh stream
          //      and the hunk child would read the SAME inherited fd AT THE
          //      SAME TIME because of `stdio:'inherit'`.
          stdinWrapper.destroyOldTarget()
          // (wf31/16) THE STUCK-VIEW WATCHDOG REMAINS: if the hunk process IS
          // still running but the session does NOT show up within the grace
          // period, the watchdog closes the view — instead of the whole
          // terminal freezing, we get a loud error. This covers the SYMPTOM;
          // the CAUSE is fixed by the dedicated PTY (on the `script` path TOO,
          // on node-pty too — see the head of `openReviewViaPty`).
          //
          // (wf31/48) THE RETURN-PATH SHELL FLASH — THIS WAS THE ~40 ms window
          // that `onChildExit` compensated for AS EARLY AS POSSIBLE (the gap
          // between `close`/`exit`). On the node-pty path this compensation is
          // now just a SAFETY NET: `openReviewViaPty` withholds the `?1049l`
          // itself, so the terminal in PRINCIPLE never falls back to the
          // primary buffer — on the `script` path (fallback), though, this
          // REMAINS the primary defense.
          //
          // PRIORITY goes to node-pty: if available, `?1049l` filtering
          // ELIMINATES (not just narrows) the shell flash. `NODE_PTY_UNAVAILABLE`
          // is the FALLBACK signal — the caller recognizes THIS `.code`; every
          // OTHER error is RE-THROWN, since that's not "no node-pty", but a
          // REAL review error that must NOT be masked by a silent script fallback.
          try {
            await openReviewViaPty(innerCommand, {
              cwd: repoRoot,
              columns: process.stdout.columns ?? null,
              rows: process.stdout.rows ?? null,
            }, { watchdog, onExit: onChildExit })
          } catch (error) {
            if (error?.code !== NODE_PTY_UNAVAILABLE) throw error
            await openReviewView(cmd, args, spawnOpts, { watchdog, onExit: onChildExit })
          }
          // (wf32) THE CHILD IS ALREADY GONE — there's no more competing reader
          // on the fd, so it's NOW safe to attach the fresh stream. This call is
          // LOAD-BEARING: the `close` event NOW arrives deterministically and
          // fast (measured: ~50ms), because thanks to the `destroyOldTarget()`
          // above, the main thread does NOT get stuck in a blocking `read()`
          // while the hunk runs. Ink's `endSuspend()` (which `suspendTerminal`
          // calls AFTER the callback returns, in its own `finally`) can
          // therefore run IMMEDIATELY, and already finds the fresh target.
          globalThis.__tuiprTrace?.('CHILD_CLOSE (promise resolved)')
          stdinWrapper.attachFreshTarget()
          globalThis.__tuiprTrace?.('CB_RETURN (endSuspend next)')
        })
        globalThis.__tuiprTrace?.('AFTER_SUSPEND (endSuspend ran)')
      } finally {
        spawnOpts.closeFds?.()
      }
    }
    return { repoRoot, reloaded }
  }, [suspendTerminal])

  // The hunk takes over the terminal; Ink suspends itself, then returns and
  // reloads the queue (the picture may have changed during the review).
  //
  // THE RE-ENTRANCY GUARD (`actionLock`) is NOT the same as `busy`, and can
  // NOT be substituted with it. MEASURED BUG, the user's first report ("after
  // the 'd' flow, once the hunk closes it prints »working…« and 'r' does nothing"):
  //
  //   1. `d` sets `busy` and goes into `suspendTerminal` (the hunk is running);
  //   2. Ink DROPS RENDERS WHILE SUSPENDED (ink.js: `onRender` returns
  //      early if `isSuspended`), so the `useInput` closure sees the
  //      PRE-SUSPEND `busy: false` — the `if (busy) return` guard
  //      STRUCTURALLY cannot take effect;
  //   3. the second action (`d` or `r`) therefore RUNS, and the second
  //      `suspendTerminal` THROWS: "The terminal is already suspended."
  //      (MEASURED, ink 7.1.1: `beginSuspend()` throws if `isSuspended`);
  //   4. the second call's `finally` calls `setBusy(false)` — WHILE THE FIRST
  //      IS STILL RUNNING —, and on the `doApprove`/`doMerge` path (where
  //      there was no try/finally) `busy` stayed PERMANENTLY stuck: "working…"
  //      forever, and not a single key worked.
  //
  // THAT'S WHY THE GUARD IS `useRef`, NOT state: the ref write is IMMEDIATELY
  // visible in the same synchronous block, WITHOUT A RENDER — so even when
  // Ink is in the middle of dropping renders. A state-based guard would fall
  // into the same trap.
  const actionLock = React.useRef(false)

  // The handle of the RUNNING BACKGROUND REVIEW (for killing it). `useRef`,
  // like the measurement handle: we don't render from it, we only abort with it.
  const aiHandle = React.useRef(null)

  // (wf28/1) THE `aiPrevDone` SAVE-AND-RESTORE WAS REMOVED — BECAUSE THE
  // INVARIANT IT PROTECTED IS NOW MET STRUCTURALLY.
  //
  // WHAT IT WAS: `askAiReview` (the menu-opening path) UNCONDITIONALLY
  // overwrote the single-slot `aiReview` state with `{ status: 'starting' }`.
  // If the slot happened to be carrying ANOTHER PR's finished (done/done-answer)
  // review, that was lost — and losing the done state would have made `r`
  // there a RESTART, so a new, paid review could have started WITHOUT the
  // friction of an explicit dismissal (double-`x`). So the old code SET THE
  // done state ASIDE into a ref, and GAVE IT BACK on every outcome of a
  // dismissed confirmation (esc / `n` / blocker / throw).
  //
  // WHY IT'S NO LONGER NEEDED: with the wf28/1-2 fix, the menu-opening PATH NO
  // LONGER WRITES `aiReview` state (see `askAiReview`'s head). If we don't
  // write, there's nothing to overwrite: the other PR's done state STAYS PUT.
  // So the save-and-restore round trip didn't fall victim to a simplification
  // — it became UNNECESSARY.
  //
  // WHY I DIDN'T LEAVE IT THERE "just to be safe": MEASURABLY, the ref has no
  // WRITER left (the only write was in `askAiReview`'s deleted block), so
  // `restoreAiPrevDone` would have become an ETERNAL no-op — but not a
  // harmless one: its body is `setAiReview((cur) => cur.status === 'starting'
  // ? prev : cur)`, with `prev === null`. Meaning if a REAL, running review's
  // 'starting' phase (written by `doAiReview`) had ever fired it, it would
  // have zeroed out a LIVE review's state — the #904 "progress disappeared"
  // bug class sneaking back in, just now through an apparently dead code path.

  // --- BACKGROUND REVIEW VISIBILITY (#904) ------------------------------------
  //
  // THE USER'S REPORT: "for 5 minutes I don't see any feedback anywhere, the app
  // still shows the message above". The old code wrote a static status line ONCE,
  // and after that NOTHING — no elapsed time, no finding count, no tool signal.
  //
  // THE MEASUREMENT STATE LIVES IN a `useRef`, the VISIBLE signal in state — the
  // same split as for the background poll, and for the same reason: the tick
  // must read the fresh values EVERY second, but a render should be caused ONLY
  // by a change to the VISIBLE text.
  //
  // WHY REF AND NOT STATE for `startedAt`/`findings`/`tool` (the project's
  // learned trap, SECOND TIME): "Ink DISCARDS rendering during suspend". On the
  // `r` path the hunk TUI takes over the terminal for its entire lifetime, so
  // state written during suspend inside closures is NOT visible — this is
  // exactly what stuck `busy` earlier. A ref write is visible immediately,
  // WITHOUT a render.
  const aiLive = React.useRef(null)
  // (The AI-review VISIBLE state — `aiReview` state — is declared at the top of
  // the component, because the rows-useMemo also reads it for the row spinner.)
  // THE EXIT CONFIRMATION alongside a running review (#904). `claude -p` writes
  // into the hunk session, so it CANNOT be detached — exiting KILLS the review.
  // If the kill is unavoidable, we ask AT THE MOMENT OF EXIT, not report
  // afterward (the user just reported getting a notice hours later).
  //
  // WHY NOT the `panel`'s MODAL mode: that is BOUND to a PR (`panel.row`), while
  // exit is a GLOBAL gesture — and the panel's modal also hides the list, which
  // here is a needless loss of context.
  //
  // (wf31/9) A SINGLE REASON, HENCE A PLAIN BOOL. The exit question appears ONLY
  // because of a RUNNING AI review: there, exiting kills an in-progress,
  // token-spending run, so the stake is a REAL, irreversible loss.
  //
  // THE STORY OF THE REMOVED SECOND REASON (`pending` — not-yet-loaded, paid-for
  // findings), kept as a lesson: the guard dated from the memory-only cache era,
  // where exiting really did discard the findings. Since the disk cache
  // (review-store), those persist in `/tmp` and startup reads them back in — so
  // the question no longer prevented a loss, it merely INFORMED ABOUT HOW THE
  // CACHE WORKS. The user's decision: "This prompt is NOT needed. The cache
  // should stay an automatic default, no need to inform the user about it." The
  // `kind` field thereby became single-valued, i.e. dead information, so the
  // state went back to a bool; `null`/`false` = no open question.
  const [exitConfirm, setExitConfirm] = useState(null)

  /**
   * SHUTTING DOWN THE BACKGROUND REVIEW — every exit path goes through this.
   *
   * WHY KILL AND NOT DETACH (the reasoning behind the decision): `claude -p`
   * WRITES into the hunk session. A detached review would keep writing into a
   * session after the TUI exits that nobody reviews anymore — the findings
   * would surface at the next TUI start IN THE CONTEXT OF A DIFFERENT PR, and
   * the `f` upload would submit them under OUR attribution. This is exactly the
   * lying provenance the feature avoids everywhere else (see the attribution's
   * PR-match check). The zombie is separately forbidden too: the project already
   * paid for that once with the merge-tree metric.
   *
   * `reason` IS THE #904 FIX: the old, reasonless abort routed EVERY exit path
   * (exit / `x` / unmount) to the same lying "aborted" text. Now the reason
   * PROPAGATES down to the core, and the caller states its OWN final state.
   */
  const stopAiReview = useCallback((reason = 'exit') => {
    aiHandle.current?.abort(reason)
    aiHandle.current = null
  }, [])

  // EVERY blocking action goes THROUGH this. The `finally` resets TWO things
  // (the lock AND busy), so getting stuck is impossible on any branch — the
  // earlier bug was precisely that this pair lived in two places (and two
  // paths).
  //
  // `release` IS THE HANDLE FOR THE PARALLEL MODEL: the caller can release the
  // UI EARLY while its own work (the background review) keeps running. Without
  // this, the "runs in the background" promise would be a lie: `busy` would
  // stay set for claude's entire duration, the user could not navigate or close
  // the panel — exactly the stuck state this package eliminates, just now on
  // purpose.
  //
  // THE LOCK IS FREE AGAIN AFTER `release`: a second `r` can start at that
  // point. This is INTENTIONAL — the hunk session is repo-scoped, so two
  // parallel reviews would write into the same session, and the set-diff gate
  // could not (correctly) separate them. That's why `doAiReview` guards with
  // ITS OWN handle: while `aiHandle.current` is not null, no new review starts
  // (see the guard there).
  /**
   * @param {Function} fn the body of the action
   * @param {string} [key] (wf31/23) THE KEY OF THE RUNNING ACTION (`'a'`, `'m'`,
   *   `'f'`) — we mark it in the LEGEND (`a: approve (running…)`), not in a
   *   global status line. WHY A PARAMETER, AND NOT SET BY THE ACTION ITSELF:
   *   this way the signal's SETTING and CLEARING live in the same
   *   `try/finally` as `busy` — a setter on the action's side would get STUCK
   *   on error paths (throw, early return), and the legend would show the
   *   "(running…)" signal forever.
   */
  const runExclusive = useCallback(async (fn, key, prNumber = null) => {
    if (actionLock.current) return false
    actionLock.current = true
    setBusy(true)
    // (wf31/72) THE PENDING ROW. `null` if the action isn't bound to a PR (e.g.
    // `R`) — in that case the list marks nothing, which is correct: there is no
    // "left behind" row.
    setPendingPr(Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null)
    // THE PENDING KEY is set TOGETHER with `busy` and disappears TOGETHER with it
    // (see `release`) — the two describe the same state, so they can't drift apart.
    setPendingKey(typeof key === 'string' && key !== '' ? key : null)
    let released = false
    const release = () => {
      if (released) return
      released = true
      actionLock.current = false
      setBusy(false)
      setPendingKey(null)
      setPendingPr(null)
    }
    try {
      // (wf31/15) FLUSHING THE PENDING SIGNAL — HERE, IN ONE PLACE, FOR EVERY ACTION.
      //
      // THE USER'S FINDING, verbatim: "there should be pending states in the app.
      // For example there wasn't one when uploading the review either. Right
      // after issuing a command there should be immediate feedback."
      //
      // THE MEASURED REASON why `setBusy(true)` was NOT VISIBLE until now: the
      // action bodies (`doUpload`, `doApprove`, `doMerge`) are `async` functions,
      // but their blocking calls are SPAWNSYNCS — without `await`. An `async`
      // function runs SYNCHRONOUSLY up to its very first `await`, so
      // `setBusy(true)` and `setBusy(false)` happened WITHIN THE SAME sync
      // block: React never got to a render flush, "working…" never appeared,
      // and the UI stood SILENT for 1-3 seconds. This exact bug class was
      // already described by the `askAiReview` and `openReview` comments — just
      // fixed there PER ACTION (`await new Promise(r => setTimeout(r, 0))`
      // before the spawns), in three copies.
      //
      // WHY IN `runExclusive`, AND NOT PER ACTION: this is the SHARED entry
      // point for EVERY spending action. Fixed per action, the flush can be
      // FORGOTTEN when a NEW action is written — and the bug is SILENT (the UI
      // works, it just doesn't signal), so nobody notices. Fixed here once, it
      // is structurally guaranteed.
      //
      // THE COST IS ONE MACROTASK TICK (~0 ms): `setTimeout(0)`, together with
      // the already-set `busy` state, lets the render tree run. This does NOT
      // noticeably slow the action, but the feedback appears on the FIRST frame
      // after the keypress.
      // (wf31/42) INK'S OWN FLUSH, NOT `setTimeout(0)`.
      //
      // `setTimeout(0)` only got us onto the macrotask queue — it did not
      // guarantee that React had COMMITTED and Ink had WRITTEN OUT the frame.
      // `waitUntilRenderFlush` calls `reconciler.flushSyncWork()`, waits for the
      // macrotask, and in concurrent mode for the next render commit too: the
      // pending signal is thus CERTAINLY on screen when the blocking work
      // starts. The user's request ("with flushSync … render the pending UI
      // before the process starts") wants exactly this.
      //
      // FAIL-SOFT: the flush can throw (during unmount), and a throw HERE would
      // take down the ACTION for the sake of a bit of feedback.
      try {
        await waitUntilRenderFlush()
      } catch { /* a failure in the flush must not block the action */ }
      await fn(release)
      return true
    } finally {
      // ORDER MATTERS HERE TOO: releasing the lock comes AFTER busy — so there is
      // no moment where the lock is already free but the UI still looks blocked
      // and an incoming keypress dies on the `busy` guard.
      // IDEMPOTENT: if the caller already released, this is a no-op (not "releases twice").
      release()
    }
    // (wf31/42) `waitUntilRenderFlush` IN THE DEPS: `useApp()`'s context value is
    // stable on Ink's side (`render()` sets it once), but the CORRECT dependency
    // list would be a lie without it — and a future Ink version that recreates
    // it would silently produce a stuck closure.
  }, [waitUntilRenderFlush])

  // OPENING THE HUNK — AND LOADING CACHED ANSWER FINDINGS (hybrid (c)).
  //
  // BOTH `d` AND the panel's r-offer (opening a finished review) go through THIS
  // path: when opening the hunk, if the PR has a NOT-YET-LOADED answer finding,
  // it gets loaded via batch-apply once the session appears (the hunk daemon is
  // the broker: a comment written from another process into the running TUI
  // appears once MEASURED). The load is IDEMPOTENT: the `applied` flag (cache)
  // records it, so a repeated open does not duplicate.
  //
  // The pending-free path is DELIBERATELY byte-identical to the old one: no
  // session probe, no waiting is added — `d`'s existing contract (and spawn log)
  // grows only when there is actually something to load.
  const openReview = useCallback(async (row, { agentNotes = false } = {}) => {
    // (SESS-1, blocker) OPENING IS BLOCKED WHILE A SESSION-ALIVE REVIEW IS RUNNING.
    //
    // The agent writes into the SINGLETON hunk session (session-alive prompt),
    // while `d` / panel-`d` / the done-lifecycle `r` would ALL, through this
    // chokepoint, reload the session's content against a different diff — the
    // agent's remaining `comment add`s would then land against the WRONG PR's
    // diff, and the completion-time set-diff would book them as the result of
    // the reviewed PR (false anchor + false attribution). During an
    // answer-only review (sessionAlive=false), switching the session hurts no
    // one — there `d` stays free.
    if (aiHandle.current && aiLive.current?.sessionAlive === true) {
      setNotice(`#${aiLive.current.pr}: a running AI review is using the hunk session — `
        + 'opening is blocked until the review ends (x: abort)')
      return
    }
    // (wf24/4) IMMEDIATE SIGNAL ON THE FIRST FRAME AFTER THE KEYPRESS — the
    // user's finding: "pressing »r« on a finished review is still not
    // responsive, and there's no pending signal saying »loading…«". THE SAME
    // BUG CLASS we already fixed for askAiReview (6): the blocking spawnSyncs
    // (repo root, session id, hunk launch) ran BEFORE the UI flush, so the UI
    // stood silent for a couple of seconds.
    //
    // THE SIGNAL GOES OUT ONLY ON THE REVIEW-OPEN PATH (the PR has its own
    // review state): plain `d` (raw diff) stays BYTE-IDENTICAL to the old
    // path — there is nothing to "load" there, and a false signal would break
    // `d`'s contract.
    const signalsOpening = aiReview !== null && aiReview.pr === row.number
      && (aiReview.status === 'done' || aiReview.status === 'done-answer')
    const openingPrev = signalsOpening ? aiReview : null
    if (signalsOpening) setAiReview({ pr: row.number, status: 'opening' })
    // (wf31/42) THE PENDING SIGNAL FOR EVERY `d`, AND GUARANTEED ON SCREEN.
    //
    // The user's request: "since the hunk takes 1-2 sec to appear, there should
    // be pending UI here too, with flushSync (if there is such a thing in a
    // TUI), i.e. render the pending UI before the process starts".
    //
    // TWO CHANGES FROM THE OLD SHAPE:
    //
    // (1) THE SIGNAL GOES OUT FOR EVERY `d`, not just the finished-review path.
    //     The earlier comment justified that plain `d` has "nothing to load",
    //     so the signal would be false — BUT the user's finding is precisely
    //     that the hunk's APPEARANCE takes 1-2 seconds, regardless of review.
    //     So after pressing `d` there is ALWAYS a silent stretch that needs
    //     signaling. We write it via `pendingKey` INTO THE LEGEND (`d: diff
    //     (running…)`), which is the contextual spot — not a global status
    //     line (removed in wf31/23).
    //
    // (2) THE FLUSH IS `waitUntilRenderFlush`, NOT `setTimeout(0)`. The old
    //     shape only got us onto the macrotask queue — it did not guarantee
    //     that React had committed AND Ink had written out the frame. Ink's
    //     `waitUntilRenderFlush` calls `reconciler.flushSyncWork()`, waits for
    //     the macrotask, and in concurrent mode for the next render commit too
    //     — meaning the signal is CERTAINLY on screen when the blocking
    //     `spawnSync`s (repo root, session id, `script`+hunk launch) start.
    setBusy(true)
    setPendingKey('d')
    try {
      await waitUntilRenderFlush()
    } catch { /* fail-soft: a failure in the flush must not block the open */ }
    // `runExclusive` also sets ITS OWN `busy`/`pendingKey` pair (to these same
    // values), and releases it in its `finally` — so the manual setting above
    // does NOT get stuck. WHY IS IT STILL NEEDED BY HAND: `runExclusive`'s flush
    // runs BEFORE `fn`, but the `d` path ALREADY does blocking work before that
    // (measuring `signalsOpening` and the `fetchRepoRoot` below), so the signal
    // needs to go out earlier than where `runExclusive` places it.
    await runExclusive(async (release) => {
      // THE SIGNAL MUST NOT GET STUCK: `opening` is a transient state, and on
      // EVERY outcome of the open (success, error, throw) it must revert to
      // the real final state. `patch` carries the load's result (offer:false +
      // loaded) if it happened — the old `setAiReview((cur) => …)` update would
      // not find these fields on the `opening` state.
      let openingPatch = null
      try {
        const pending = cacheAiFindings(cache.current, row.number)
        // THE GUARD IS BOUND TO SESSION IDENTITY, not just the PR (the user's
        // 5/3 finding): the hunk's `q` also takes the SESSION with it, and the
        // `applied` flag would lie "done" about a DEAD session — reopening
        // would get a NEW, EMPTY session, with no load ("the agent note
        // disappeared"). So besides `applied` we also measure whether the
        // load's target session is STILL alive; if the same one is alive, we
        // do NOT duplicate (the old invariant is unchanged).
        //
        // (wf24/4) THE SESSION MEASUREMENT IS LAZY: `hunkLiveSessionId` runs
        // ONLY alongside applied pending. For not-applied (first load),
        // `answerFindingsNeedApply` doesn't even look at liveSid (always YES),
        // so the measurement was pure latency on the open path — the
        // short-circuit was already there in the expression, but the
        // `fetchRepoRoot()` argument evaluation used to run BEFORE it on every
        // call. The memoized root removes this too.
        const hasPending = pending !== null && Array.isArray(pending.findings) && pending.findings.length > 0
        const liveSid = hasPending && pending.applied === true ? hunkLiveSessionId(fetchRepoRoot()) : null
        const needApply = answerFindingsNeedApply(pending, liveSid)
        // THE --agent-notes DECISION: opening a review (`r` in the done state)
        // brings the EXPLICIT flag; on the `d` path it applies when there is
        // something TO load (needApply) — there, showing the AI comments is
        // the point of the load. The pending-free `d` runs without the flag:
        // byte-identical to the old path, the hunk's default.
        const wantNotes = agentNotes === true || needApply
        if (!needApply) {
          await openHunkView(row, { wantView: true, agentNotes: wantNotes })
        } else {
          // THE VIEW is not awaited (the suspend blocks for the hunk's entire
          // lifetime) — the load runs after the session APPEARS, ALONGSIDE the
          // open hunk.
          const root = fetchRepoRoot()
          const viewPromise = openHunkView(row, { wantView: true, agentNotes: wantNotes })
          viewPromise.catch(() => { /* awaited at the end — this only suppresses the early unhandled signal */ })
          const appeared = await waitForHunkSession(
            root,
            sessionWaitMs === undefined ? {} : { timeoutMs: sessionWaitMs },
          )
          if (appeared === true) {
            const n = applyAnswerFindings(root, pending.findings)
            // The TARGET SESSION's id is ALSO recorded: the next open decides
            // from this whether the notes are still there (session-identity guard).
            cacheMarkAiFindingsLoaded(cache.current, row.number, hunkLiveSessionId(root))
            bumpCache()
            // The offer is FULFILLED: the panel's review section no longer advertises it.
            openingPatch = { offer: false, loaded: n }
            setAiReview((cur) => (cur && cur.pr === row.number ? { ...cur, offer: false, loaded: n } : cur))
          } else if (appeared === null) {
            // (lying-timeout-1) UNKNOWABLE ≠ TIMEOUT. The core's contract
            // (waitForHunkSession) states: `null` is a daemon error / missing
            // binary / schema change — waiting makes no sense here, and
            // "didn't appear in time … retrying" would promise the same thing
            // forever on a permanent error. We give the raw diagnosis, in a
            // form the user can act on.
            showError(row,
              'the hunk-session state cannot be measured (daemon error, missing hunk binary, or a changed '
              + '`session list` schema), so loading the answer findings was skipped — they REMAIN in the cache. '
              + 'This is not a timing issue: fix the hunk install/daemon first (`hunk session list --json`).')
          } else {
            // FAIL-CLOSED, but NOT a loss: the findings stay in the cache, the
            // offer stays valid — the next open will retry.
            showError(row,
              // (wf31/6) THE OPENING KEY IS `d` (`r` no longer opens) — the
              // referenced key must match what the footer advertises.
              'the hunk-session did not appear in time, so loading the answer findings was skipped — '
              + 'they REMAIN in the cache, the next open (`d`) will retry.')
          }
          await viewPromise
        }
        setNotice(`#${row.number}: the review session ended`)
      } catch (error) {
        showError(row, `the diff review could not run: ${error.message}`)
      } finally {
        // (wf24/4) CLEARING THE `opening` SIGNAL — in the `finally`, so on the
        // THROW path too: a stuck "loading…" would give back exactly the
        // silent, unresponsive experience this was built against.
        // THE RESET IS BOUND TO IDENTITY: if the state has meanwhile switched
        // to SOMETHING ELSE (a different PR, a new review started), we do NOT
        // write the old one back.
        if (openingPrev !== null) {
          const patch = openingPatch
          setAiReview((cur) => (
            cur !== null && cur.pr === row.number && cur.status === 'opening'
              ? (patch === null ? openingPrev : { ...openingPrev, ...patch })
              : cur
          ))
        }
        // (5/2) THE UI FREES UP IMMEDIATELY: after releasing the lock/busy, the
        // soft reload runs in the BACKGROUND (async children, not spawnSync) —
        // this eliminates the "working for a couple of seconds" after closing
        // the hunk (measured at ~2.5 s: queue ~1.9 s + rev-parse + gh pr list ~0.55 s).
        release()
        await reloadAsync()
      }
    // (wf31/43) THE `'d'` KEY PASSED IN — A MEASURED BUG, FROM OUR OWN wf31/42 ROUND.
    //
    // The user's finding: "the pending ui just flashes, the status line snaps
    // right back to the original before it switches to the hunk".
    //
    // THE CAUSE: `runExclusive` sets `pendingKey` from its SECOND argument, and
    // called without a key it writes `setPendingKey(null)` — meaning it
    // IMMEDIATELY EXTINGUISHED the `'d'` set by hand above. The manual setting
    // + flush drew the signal, and `runExclusive` erased it, before the hunk
    // even started: hence the flash.
    //
    // THE MANUAL SETTING ABOVE IS STILL NEEDED (not redundant): `runExclusive`'s
    // flush runs BEFORE `fn`, but the `d` path ALREADY does blocking work
    // before that. The two now set the SAME value, so they can't drift apart —
    // and `runExclusive`'s `finally` is the only place that releases it.
    }, 'd', row?.number)
    // `aiReview` IS IN THE DEPS: the wf24/4 immediate signal decides from the
    // CURRENT review state (whether this PR has a finished review), so a
    // stuck closure would silently drop the signal.
  }, [aiReview, bumpCache, openHunkView, reloadAsync, runExclusive, sessionWaitMs, showError, waitUntilRenderFlush])

  // Uploading the findings: ONE review, event=COMMENT. This is NOT approve.
  //
  // TWO SOURCES, IN A FIXED ORDER: the hunk session's agent comments come
  // FIRST, the cached review findings are the FALLBACK. The user's decision,
  // verbatim: "if there's hunk material, that should be uploaded, otherwise
  // fall back to the json. The
  // review is just a helper, not an audit gate. It's a convenience tool." The
  // detailed reasoning (why hunk goes first, and when we fall back) lives at
  // the source-selection site.
  //
  // THE SOURCE OF ATTRIBUTION is the MEASUREMENT of the most recent AI review,
  // if it ran on THE SAME PR — then the body writes `tool: "claude-p"`, the
  // MEASURED model, the spend, and the generated/kept ratio. If no AI review
  // ran (or it ran on a different PR), the old hunk attribution goes,
  // unchanged. The PR-match check is load-bearing: a "claude-p" signal
  // migrated over from a different PR would be lying provenance. On the path
  // uploaded FROM CACHE, a THIRD branch carries AI provenance without the
  // MEASURED fields — see there.
  const doUpload = useCallback((row) => runExclusive(async () => {
    try {
      // THE ROOT MEASUREMENT on the SHARED path (fetchRepoRoot): there used to
      // be a COPIED `git rev-parse --show-toplevel` here, and precisely
      // because of that copy it was missing from the `d` path (which had no
      // cwd either) — this duplication is what spawned the session drift.
      const repoRoot = fetchRepoRoot()
      // THE SOURCE SELECTION: HUNK FIRST, CACHE SECOND.
      //
      // THE USER'S DECISION, verbatim: "if there's hunk material, that should
      // be uploaded, otherwise fall back to the json. The review is just a
      // helper, not an audit gate. It's a convenience tool."
      //
      // WHAT THE BUG WAS (a measured finding, the user's #904 case): `f` read
      // EXCLUSIVELY from the hunk session, and without a live session it
      // claimed "NOTHING TO UPLOAD" — while TWO findings sat in the cache
      // (restored from the disk cache). The message was FALSE, and pointed in
      // the wrong direction: the findings weren't missing, they just hadn't
      // made it into the hunk.
      //
      // WHY THE HUNK STAYS FIRST (the order is load-bearing, not accidental):
      // if there IS a live session, the user has ALREADY worked in it —
      // deleted (`comment rm`), edited, written their own. That list is the
      // FRESHER and NARROWER intent; placing the cache's raw set above it
      // would throw away the user's work and bring back findings they had
      // ALREADY DISCARDED. The cache is thus a FALLBACK, not an alternative.
      //
      // `context: 'upload'` selects the ERROR TEXT, if the fallback ALSO can't
      // help (no session AND no cache) — the same RECOGNITION
      // (isNoActiveSession), different TEXT.
      let comments = []
      let fromCache = false
      try {
        comments = hunkComments(repoRoot, { context: 'upload' })
      } catch (hunkError) {
        // ONLY THE "NO SESSION" CLASS FALLS BACK, every other error is
        // RETHROWN. WHY: a missing `hunk` binary, a daemon crash, or a parse
        // error is a DIFFERENT problem — sliding to the cache there would HIDE
        // the real cause, and the user would think a findings shortage is
        // actually an install error. `isNoActiveSession`'s fail-closed
        // recognition (not a literal match) exists exactly for this split.
        //
        // THE RECOGNITION RUNS ON THE TEXT, because `hunkComments` has ALREADY
        // translated the error into a message (`noActiveSessionMessage`) — the
        // structured `res` object doesn't reach here. The anchor is OUR OWN,
        // constant sentence opener, not hunk's text that shifts with version changes.
        if (!/nincs élő hunk-session/.test(String(hunkError.message ?? ''))) throw hunkError
        const cached = cacheAiFindings(cache.current, row.number)
        if (!cached || !Array.isArray(cached.findings) || cached.findings.length === 0) {
          // NEITHER SOURCE EXISTS: the ORIGINAL, actionable message propagates
          // on — here "nothing to upload" is a TRUE statement.
          throw hunkError
        }
        // THE CACHED FINDINGS' POSITION SCHEMA DIFFERS FROM THE HUNK PATH'S,
        // and `toGithubComments` normalizes this (not here, because it is the
        // SHARED consumer):
        //   · hunk path:   `{ side: 'new'|'old', line: N }`
        //   · answer path: `{ newLine: N }` / `{ oldLine: N }`  ← the store stores this
        //
        // THIS WAS A MEASURED, LIVE BUG (the user's 422): `toGithubComments`
        // only knew the first schema, `line` came out `undefined` on a cached
        // finding, and falling to the file-level branch made the ENTIRE
        // (atomic) review fail — even though the findings DID have a position,
        // just under a different field name. The earlier comment here claimed
        // the two shapes were identical; they are not.
        comments = cached.findings
        fromCache = true
      }
      // THE EMPTY (but LIVE) SESSION ALSO FALLS BACK. WHY THIS SECOND BRANCH IS
      // NEEDED: a session can exist WITHOUT the findings having made it in —
      // exactly this state arises if the user opened the hunk WITHOUT LOADING
      // the cached review (or opened it for a different PR). The catch branch
      // above does NOT run in that case (`hunkComments` succeeds, just returns
      // an empty list), so without this fallback the lying "nothing to
      // upload" would come up again here.
      //
      // EMPTINESS IS NOT A SIGNAL OF INTENT: if the user had deleted
      // EVERYTHING (`comment rm`), that would be a deliberate discard — but
      // that is expressed by DISCARDING the review findings (double-`x`),
      // which also deletes them from the cache. A cache that SURVIVES next to
      // an empty session thus means the findings never made it in, not that
      // they were discarded.
      if (comments.length === 0 && !fromCache) {
        const cached = cacheAiFindings(cache.current, row.number)
        if (cached && Array.isArray(cached.findings) && cached.findings.length > 0) {
          comments = cached.findings
          fromCache = true
        }
      }
      if (comments.length === 0) {
        setNotice('no inline comments in the hunk session — not uploading an empty review')
        return
      }
      // The user login must not be swallowed silently either: with an empty
      // `verifiedBy`, the body would write "@ verified", which defeats the
      // point of attestation.
      const userRes = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' })
      const userSpawnErr = spawnFailure(userRes, 'gh')
      if (userSpawnErr) throw new Error(`could not fetch the gh user login: ${userSpawnErr}`)
      if (userRes.status !== 0) {
        throw new Error(`could not fetch the gh user login: ${(userRes.stderr || '').trim() || `gh exit ${userRes.status}`}`)
      }
      const user = userRes.stdout.trim()
      if (!user) throw new Error('the gh user login came back empty — not uploading without attribution')

      const ai = aiRun && aiRun.row.number === row.number ? aiRun : null
      // ATTRIBUTION IS AI ATTRIBUTION ON THE PATH UPLOADED FROM CACHE TOO — but
      // the part without a MEASUREMENT cannot be guessed.
      //
      // WHY THIS BRANCH IS NEEDED: the `aiRun` state is a measurement of THE
      // CURRENT session, which is `null` after a RESTART — while the findings
      // ARE there, from the disk cache. A plain `ai` check would thus, on the
      // fallback path, have sent the body down the "plain hunk attribution"
      // branch: the AI provenance (`tool: claude-p`) would have SILENTLY
      // vanished from the PR, even though the findings were certainly
      // generated by the AI review (the cache gets findings ONLY from there).
      //
      // WHAT WE DO NOT WRITE: `costUsd`, `sessionId`, `skill`, `aiGenerated`.
      // These are measurements of THE RUN, and NEVER made it to disk — a
      // fabricated or omitted value here would be lying audit data in the PR
      // body. The absence of `aiGenerated` specifically means the "N/M kept"
      // ratio is skipped: we don't know the generated count, so we don't state it.
      //
      // THE SUMMARY, HOWEVER, IS AVAILABLE: the store persists it, and
      // `restoredReviews` carries it — the verdict is just as useful to a
      // reader of the PR as it is in the TUI.
      const restoredMeta = restoredReviews[row.number]
      uploadFindings(row.number, comments, ai
        ? {
            model: ai.model ?? MODEL,
            user,
            tool: 'claude-p',
            // THE CHOSEN review path: `agent-review` (bit-identical to CI) and
            // `/code-review high` review under DIFFERENT rules, so a reader of
            // the PR needs to know which one they're looking at. Without this
            // the MEASURED path would silently vanish from the body.
            skill: ai.skill ?? undefined,
            aiGenerated: ai.generated,
            costUsd: ai.costUsd ?? undefined,
            sessionId: ai.sessionId ?? undefined,
            // (wf24/2) THE AI SUMMARY GOES INTO THE REVIEW BODY TOO: the
            // verdict is just as useful to a reader of the PR as it is in the
            // TUI — until now it appeared NOWHERE. It's only included if the
            // agent actually gave one.
            aiSummary: ai.aiSummary ?? undefined,
          }
        : fromCache
        ? {
            // The MODEL can't be known retroactively either (not persisted),
            // so the default goes — the same one the non-AI path uses.
            model: MODEL,
            user,
            tool: 'claude-p',
            aiSummary: restoredMeta?.summary ?? undefined,
          }
        : { model: MODEL, user })
      // THE REVIEW TRACE is also recorded on upload: the hunk session's
      // comments made it onto the PR, so the review DID HAPPEN and is visible
      // from OUTSIDE too.
      //
      // WHY NOT the 'd' (diff review) marking a trace: per the user's stated
      // principle, a `d` look-over does NOT leave a trace (opening a diff is
      // not a review), and a trace set on 'd' would teach exactly the
      // proxy-performance the friction model is meant to avoid. The trace
      // states a FACT, not an intent.
      markReviewTrace(cache.current, row.number, 'hunk')
      bumpCache()
      // THE SOURCE IS STATED, if the fallback ran: the user learns that the
      // uploaded set was the CACHE's raw list, not what was reviewed in the
      // hunk — so `comment rm` filtering did NOT apply to it. A silent
      // fallback here would be worse: the user might think their own
      // filtering had been uploaded.
      setNotice(
        `#${row.number}: ${comments.length} finding(s) uploaded (COMMENT — this is not approve)`
        + (fromCache ? ' · from the cached review (no material in the hunk session)' : '')
        + (ai ? ` · attribution: claude-p, ${ai.generated} generated / ${comments.length} kept` : ''),
      )
    } catch (error) {
      showError(row, `uploading the findings failed: ${error.message}`)
    }
    // `restoredReviews` IS IN THE DEPS: the fallback path's attribution (the
    // summary) comes from it, so a stuck closure would silently drop the
    // verdict from the PR body.
    //
    // (wf31/15) THE PENDING TEXT: uploading makes 2-4 blocking `gh` calls
    // (user login, repo name, the review's POST), so this was the longest
    // silent stretch — the user reported exactly this.
  }, 'f', row?.number), [aiRun, restoredReviews, runExclusive, showError])

  // The AI review: `claude -p` with the RUNNER's token, on the selected PR.
  //
  // (2) `r` NO LONGER OPENS THE HUNK. The user's request, verbatim: the review
  // runs in the background, progress shows in the TUI (in the PR panel), and
  // when it's DONE, the panel offers to open it ("N findings — r: open in the
  // hunk"). The hunk opens when there's SOMETHING TO SEE.
  //
  // THE HYBRID MODEL (1) — double bookkeeping:
  //   - if there IS a LIVE session: switch it to the PR IN THE BACKGROUND
  //     (`session reload` — does not take over the terminal), the agent writes
  //     into the hunk, AND its response also returns the findings;
  //   - if there is NO live session: the agent gets an answer-only prompt (a
  //     request to write to the hunk would go nowhere), the findings come from
  //     the ANSWER JSON, the cache stores them keyed by PR, and they load WHEN
  //     THE HUNK IS OPENED (openReview / the panel's r-offer, batch-apply,
  //     idempotently).
  // THIS WAY A SESSION DEATH DOES NOT KILL THE REVIEW: the user PAID FOR THIS
  // ONCE (the review ran, the session died in the meantime, everything was
  // lost) — a "review has ALREADY RUN… run it again" type message is therefore
  // FORBIDDEN when there is an answer JSON.
  //
  // THE GATE IS STILL NOT CLAUDE'S EXIT CODE (a measured trap: exit 0 +
  // subtype:"success" also comes for a review that never ran): alongside a
  // live session, the hunk ID set-diff (`aiReviewGateByIds`) is the primary
  // evidence; without a session, the answer JSON's structured findings array
  // is the measurable fact.
  //
  // (3) EVERY SIGNAL GOES INTO THE PR PANEL (`aiReview` state): progress, the
  // final states AND errors too — the global error overlay is no longer used
  // on the AI review path.
  const doAiReview = useCallback((row, maxBudgetUsd, reviewPath, model) => runExclusive(async (release) => {
    let handle = null
    // THE REFERENCE TO THE MEASUREMENT STATE BEFORE the try: `finally` closes
    // it out BY IDENTITY (`aiLive.current === live`) — see the old #904
    // finally reasoning.
    let live = null
    try {
      // ONLY ONE BACKGROUND REVIEW CAN RUN AT A TIME (the hunk session is
      // repo-scoped, the set-diff could not separate the findings of two
      // parallel runs).
      if (aiHandle.current) {
        setNotice('an AI review is already running in the background — wait for it, or abort it (x)')
        // (wf28/1) NOTHING TO CLEAN UP: this branch returns BEFORE the
        // 'starting' write (its own `setAiReview` is a few lines below), so it
        // did not touch the running review's state. The old
        // `restoreAiPrevDone()` call used to sit here because the MENU-OPEN
        // path had already written a 'starting' that this branch inherited —
        // that write was removed in wf28/1.
        return
      }
      // (6) IMMEDIATE FEEDBACK: the panel's review section shows "AI review
      // starting…" already BEFORE the blocking I/O (session probe, git fetch).
      // setTimeout(0) lets the React flush happen before the spawnSyncs block.
      setAiReview({ pr: row.number, status: 'starting' })
      // (wf31/42) Ink flush instead of `setTimeout(0)` — see `runExclusive`'s
      // reasoning: the former GUARANTEES the written-out frame, the latter only hoped for it.
      try {
        await waitUntilRenderFlush()
      } catch { /* fail-soft: see there */ }

      const root = fetchRepoRoot()
      // MEASURING SESSION STATE. THREE outcomes:
      //   true  — live session: background reload onto the PR + `before` id set;
      //   false — none (or orphaned): answer-only mode, WITHOUT a hunk step;
      //   null  — unknowable (daemon error / no binary): answer-only mode —
      //           fail-soft, because the answer-JSON path gives a full-value
      //           review even without a session, and the token isn't spent for nothing.
      const alive = probeHunkSession(root)
      let sessionAlive = alive === true
      // THE REF FETCH IS NEEDED BY BOTH MODES: for a live session it's the
      // reload target, and in answer-only mode it's the prompt's file-read
      // path (`git show <headRef>:<path>`) — without it the agent is forced
      // onto the gh api contents + pipe detour, which the permission layer
      // denies on principle (a MEASURED bug class, from two live runs).
      // FAIL-SOFT: if the fetch fails, headRef=null — the prompt skips that
      // path, the review still runs regardless.
      let prBase = null
      let prHead = null
      // (lying-label-1) THE FAIL-SOFT STAYS, but the REASON must not
      // disappear: fetchPrRefs's error (git fetch exit≠0, gh auth/rate-limit,
      // ENOENT) goes into a variable — alongside a live session, the
      // degradation (answer-only mode) is stated in the final state as a
      // caveat + an honest header, instead of a silent empty catch.
      let refsError = null
      try {
        ;[prBase, prHead] = fetchPrRefs(row.number)
      } catch (error) {
        refsError = error?.message ?? String(error)
        prBase = null
        prHead = null
      }
      if (sessionAlive) {
        // THE SINGLETON: we SWITCH the existing session (reload) — no new hunk
        // TUI starts, the terminal remains ours. If the reload finds the
        // session orphaned (false), we fall to answer-only mode. No ref, no reload.
        sessionAlive = prHead !== null && reloadHunkSession(root, prBase, prHead) === true
      }
      // The `before` ID SET is measurable AND meaningful ONLY alongside a live session.
      const before = sessionAlive ? hunkAgentNoteIds(root, { context: 'review' }) : new Set()

      const timeoutMs = aiTimeoutMs ?? AI_REVIEW_TIMEOUT_MS
      handle = startAgentReview({
        headRef: prHead,
        pr: row.number,
        repoRoot: root,
        reviewPath,
        maxBudgetUsd,
        // The model CHOSEN on the confirmation panel (with an env starting
        // value) — the core's command builder defaults fail-closed (opus) if empty.
        model,
        cwd: root,
        timeoutMs,
        // THE PROMPT ADAPTS TO SESSION STATE: alongside a live session, hunk
        // writes + answer JSON (double bookkeeping); without a session,
        // EXCLUSIVELY answer JSON.
        sessionAlive,
        // THE STREAM SIGNAL: we write into a ref (not state) — Ink would
        // discard the render during suspend (the project's learned trap), and
        // the ticker reads it.
        onProgress: (ev) => {
          if (!aiLive.current) return
          if (ev.tool) aiLive.current.tool = ev.tool
        },
      })
      aiHandle.current = handle
      live = {
        pr: row.number,
        startedAt: Date.now(),
        findings: 0,
        tool: null,
        repoRoot: root,
        before,
        sessionAlive,
      }
      aiLive.current = live
      // PROGRESS IN THE PANEL: the `running` state's row shows the elapsed
      // time, the finding count, and the tool signal (aiReviewPanelLines), the
      // refresh is driven by the ticker's `aiTick`.
      setAiReview({ pr: row.number, status: 'running', startedAt: live.startedAt })
      // RELEASING THE UI: from here claude works in the background, the TUI
      // STAYS USABLE (navigation, panel, exit question).
      release()

      const outcome = await handle.done
      // AN ABORTED REVIEW HAS NO FACT TO REPORT — but the REASON is separated out (#904).
      if (outcome.aborted) {
        const kind = outcome.reason === 'timeout'
          ? 'timeout'
          : outcome.reason === 'exit'
          ? 'killed-by-exit'
          : 'aborted'
        setAiReview({
          pr: row.number,
          status: kind,
          message: aiReviewOutcome({ kind, pr: row.number, timeoutMs: outcome.timeoutMs ?? timeoutMs }).message,
        })
        return
      }

      // THE OTHER HALF OF THE DOUBLE BOOKKEEPING: the answer JSON. A parse
      // error is NOT swallowed, but it doesn't kill the hunk branch either —
      // we only state it when the hunk path ALSO gave no finding (otherwise
      // the findings written into the hunk are authoritative).
      // (wf24/2) THE PARSE NOW RETURNS `{ summary, findings }`: `answer` is
      // the findings array (the old contract, unchanged for every caller),
      // `answerSummary` is the HUMAN-READABLE summary — this is what the user
      // was missing ("I can't find a summary anywhere"). The summary's
      // absence (old/degraded agent shape) is `null`, and fails nothing.
      let answer = null
      let answerSummary = null
      let answerError = null
      try {
        const parsed = parseAnswerFindings(outcome.envelope.result)
        answer = parsed === null ? null : parsed.findings
        answerSummary = parsed === null ? null : parsed.summary
      } catch (error) {
        answerError = error.message
      }

      // (lying-failed-1) THE PRIMARY EVIDENCE IS MEASURED BEFORE THE GATE
      // JUDGES. Per the file's own design principle, alongside a live session
      // the hunk ID set-diff is the primary evidence — so the denial gate must
      // not cut off processing before this has been measured: alongside the
      // agent's (paid-for) findings written into the hunk, "review FAILED"
      // would be a false verdict, leading to discard/restart (double spend).
      //
      // THE AFTER MEASUREMENT IS GUARDED (the user PAID FOR THIS BUG): the
      // session can also die DURING the review (they themselves exited the
      // hunk to see the progress), and in that case `hunkAgentNoteIds` THROWS.
      // The throw must NOT discard the ALREADY PARSED answer JSON — that is
      // the other half of the double bookkeeping, exactly for this case. If
      // there is an answer finding, we fall to the (c) answer-only path below
      // (store + done-answer + offer); a "run it again" type message is
      // FORBIDDEN, because the spend happened and the findings are AT HAND. If
      // there is NO answer, the error stays loud (below).
      let after = null
      let afterError = null
      if (live.sessionAlive) {
        try {
          after = hunkAgentNoteIds(root, { context: 'after' })
        } catch (error) {
          afterError = error
        }
      }
      const addedIds = after === null ? [] : aiReviewAgentAdditions({ before, after })

      // DEGRADED REVIEW: the denial is data, not a verdict (the core's parse
      // no longer throws on it). With findings (answer JSON OR hunk-written,
      // measured by set-diff): normal processing continues, but the caveat is
      // recorded, and the final state states that the review is NOT complete.
      // Without findings: the old loud error — there really is nothing to show there.
      const denied = outcome.envelope.deniedCommands ?? []
      const deniedCaveat = denied.length > 0
        ? `the review is NOT complete: the permission layer denied ${denied.length} call(s)`
          + ` (${denied.slice(0, 2).join(' · ')}${denied.length > 2 ? ` · and ${denied.length - 2} more` : ''})`
        : null
      if (denied.length > 0 && !(answer && answer.length > 0) && addedIds.length === 0) {
        // exitCode:0 returns the OLD, measured final-state text in the catch
        // ("the AI review FAILED (exit 0): …") — the denial message's contract
        // (command name + WHAT YOU CAN DO) is unchanged, only the throw site
        // moved from the parse to here, where the findings question is already settled.
        throw Object.assign(
          new Error(`${denialMessage(outcome.envelope.denials)} So the findings can't be complete either.`),
          { exitCode: 0, costUsd: outcome.envelope.costUsd },
        )
      }
      // A measurement error without answer findings stays LOUD (the old
      // contract: throwing is forbidden only when the answer JSON is at hand).
      if (afterError !== null && !(answer && answer.length > 0)) throw afterError

      if (live.sessionAlive) {
        // (b) LIVE SESSION: the hunk ID set-diff is authoritative — everything
        // stays as before, plus the answer copy gets stored as a duplicate (applied).
        if (addedIds.length > 0) {
          const gate = aiReviewGateByIds({ before, after })
          const res = {
            ...gate,
            reviewPath: outcome.reviewPath,
            model: outcome.envelope.model,
            costUsd: outcome.envelope.costUsd,
            sessionId: outcome.envelope.sessionId,
            durationMs: outcome.envelope.durationMs,
            result: outcome.envelope.result,
          }
          if (answer && answer.length > 0) {
            // The findings are ALREADY in the hunk: the answer copy is just a
            // DUPLICATE, so it's immediately `applied` — loading on open won't
            // duplicate. TOGETHER with the target session's id
            // (session-identity guard): if the user takes the session with
            // them when closing the hunk, the next open reloads FROM THE
            // COPY — the paid-for findings don't "disappear" (the (b)-branch
            // counterpart of the user's 5/3 finding).
            cacheStoreAiFindings(cache.current, row.number, answer)
            cacheMarkAiFindingsLoaded(cache.current, row.number, hunkLiveSessionId(root))
            // (1d) TO DISK TOO: when the review finishes. The `applied` flag
            // does NOT go out (the store drops it) — the hunk session doesn't
            // outlive the process, so the next start needs the load again.
            persistReview(row, answer, answerSummary)
          }
          // The SUMMARY ALSO goes into aiRun: the `f` (upload) path takes the
          // review body's AI summary from here (wf24/2).
          setAiRun({ row, ...res, generated: res.added, skill: res.reviewPath, aiSummary: answerSummary })
          markReviewTrace(cache.current, row.number, 'ai')
          bumpCache()
          // (2) THE OFFER: the hunk does NOT open on its own — the panel asks.
          setAiReview({
            pr: row.number,
            status: 'done',
            caveat: deniedCaveat,
            added: res.added,
            summary: answerSummary,
            findings: answer ?? [],
            offer: true,
            message: aiReviewOutcome({
              kind: 'done', pr: row.number, added: res.added,
              reviewPath: res.reviewPath, model: res.model, costUsd: res.costUsd,
            }).message,
          })
          return
        }
      }

      if (answer && answer.length > 0) {
        // (c) THE HUNK WASN'T LIVE (or the agent didn't write into it): the
        // findings come FROM THE ANSWER. Stored, loaded WHEN THE HUNK OPENS (Enter/`d`).
        cacheStoreAiFindings(cache.current, row.number, answer)
        // (1d) TO DISK TOO — this branch is the MORE IMPORTANT of the two:
        // here the findings exist ONLY in the answer copy (not in the hunk),
        // so until now a restart carried off the paid-for review WITHOUT A TRACE.
        persistReview(row, answer, answerSummary)
        // (lying-label-1) LIVE SESSION + FAILED REF FETCH → the degradation IS
        // STATED: the session was alive, only git/gh failed, which is why
        // answer-only mode ran — the default "the hunk session wasn't alive
        // during the run" header would be a false statement here, and the
        // reason would be lost without a trace.
        const refsDegraded = alive === true && refsError !== null
        const refsCaveat = refsDegraded
          ? `the hunk session WAS ALIVE, but fetching the PR refs failed (${refsError}) — the review degraded to answer-only mode`
          : null
        // (double-load-1) A TRANSIENT AFTER-MEASUREMENT ERROR ALONGSIDE A LIVE
        // SESSION: the agent DID write (also) into the hunk (session-alive
        // prompt), only the measurement failed — storing the answer copy with
        // applied=false would load the SAME findings a SECOND TIME into the
        // still-live session on the next open. Of the two error directions,
        // duplication is the worse one (the core's answerFindingsNeedApply
        // doctrine), so if the session is STILL ALIVE, the copy is recorded as
        // applied IMMEDIATELY, with the session id — the probe's `null`
        // (unknowable) counts as LIVE here, under the same fail-safe
        // principle. For a truly dead session, the plain (c) path remains
        // (applied=false, the open loads it — there the load does NOT
        // duplicate, the session is empty).
        let dupGuardNote = null
        if (live.sessionAlive && afterError !== null && probeHunkSession(root) !== false) {
          cacheMarkAiFindingsLoaded(cache.current, row.number, hunkLiveSessionId(root))
          dupGuardNote = `✓ ${answer.length} AI finding(s) STORED from the review's answer — measuring the hunk write failed, `
            + `the load isn't repeated due to duplication protection (reason: ${afterError.message})`
        }
        const headNote = dupGuardNote ?? (refsDegraded
          ? `✓ ${answer.length} AI finding(s) STORED from the review's answer — the hunk session was alive, but answer-only mode ran due to a ref-fetch error`
          : undefined)
        setAiRun({
          row,
          added: answer.length,
          reviewPath: outcome.reviewPath,
          model: outcome.envelope.model,
          costUsd: outcome.envelope.costUsd,
          sessionId: outcome.envelope.sessionId,
          generated: answer.length,
          skill: outcome.reviewPath,
          aiSummary: answerSummary,
        })
        markReviewTrace(cache.current, row.number, 'ai')
        bumpCache()
        setAiReview({
          pr: row.number,
          status: 'done-answer',
          caveat: [deniedCaveat, refsCaveat].filter((c) => c !== null).join(' · ') || null,
          headNote,
          added: answer.length,
          summary: answerSummary,
          findings: answer,
          offer: true,
          message: aiReviewOutcome({
            kind: 'done-answer', pr: row.number, added: answer.length,
            reviewPath: outcome.reviewPath, model: outcome.envelope.model, costUsd: outcome.envelope.costUsd,
          }).message,
        })
        return
      }

      if (answerError) {
        // There is a block, but it's damaged — AND the hunk path also gave nothing:
        // the review is not verifiable. LOUD, but IN THE PANEL (per point 3).
        setAiReview({
          pr: row.number,
          status: 'failed',
          message: `#${row.number}: the review's answer findings could not be parsed (${answerError}), `
            + 'and no finding reached the hunk session either — the review is not verifiable.',
        })
        return
      }
      // NEITHER HUNK-FINDING NOR ANSWER-FINDING: an honest "ran, but 0" signal.
      setAiReview({
        pr: row.number,
        status: 'no-findings',
        message: aiReviewOutcome({
          kind: 'no-findings', pr: row.number, before: before.size, after: before.size,
        }).message,
      })
    } catch (error) {
      // (3) THE ERROR IS ALSO IN THE PANEL: the `failed` section states the
      // exit code, the stderr's first line, and the spend — instead of the
      // global error overlay.
      const message = error.exitCode !== undefined
        ? aiReviewOutcome({
            kind: 'failed',
            pr: row.number,
            exitCode: error.exitCode,
            signal: error.signal,
            stderr: String(error.stderrText ?? '').trim() !== '' ? error.stderrText : error.message,
            costUsd: error.costUsd,
          }).message
        : `AI review error: ${error.message}`
      setAiReview({ pr: row.number, status: 'failed', message })
    } finally {
      // THE CLOSE-OUT IS IDENTITY-BASED (see the #904 scenario): a run thrown
      // out EARLY (`live === null`) must not clear ANOTHER run's state.
      const mine = live !== null && aiLive.current === live
      if (mine) aiLive.current = null
      if (aiHandle.current === handle) aiHandle.current = null
    }
    // Restoring `busy`/lock is `runExclusive`'s RESPONSIBILITY.
  }), [aiTimeoutMs, bumpCache, runExclusive])

  // PREPARING the AI-review confirmation screen: fetching the PR's size, the
  // scope, and the excluded generated files. This is I/O too (gh), but it's
  // FREE — unlike the claude call, which the user pays for. That's why it runs
  // BEFORE confirmation: the decision needs to see the measurements, not a guess.
  /**
   * (wf31/6) DOES THIS PR HAVE AN AI FINDING — whether NOT-YET-LOADED or ALREADY LOADED?
   *
   * `d` (opening) uses THIS to decide whether to open the hunk with
   * `--agent-notes`. ONE source: the session cache.
   *
   * WHY IT DOESN'T COUNT ONLY THE NOT-YET-LOADED ONES (a measured bug on my
   * own first shape, caught on a live render): the `applied` flag means the
   * findings are ALREADY IN the hunk session — meaning that is exactly the
   * case where there IS something for `--agent-notes` to show. On the LIVE
   * SESSION path, the answer findings are stored as `applied: true`
   * IMMEDIATELY, so the "only not-yet-loaded" filter dropped the flag in
   * precisely the case with the MOST AI comments in the session — the user
   * got a diff WITHOUT NOTES right after a review had just run. (The live
   * render test: "opening a finished review with `d` also runs with
   * --agent-notes even on a LIVE session".)
   *
   * SO THE QUESTION OF `--agent-notes` IS NOT "does it need loading?", BUT
   * "is there something to show?" — the load itself is a separate contract
   * (the opening path's idempotent batch-apply, guarded by the `applied` flag).
   *
   * THE PENDING-FREE, REVIEW-FREE PATH IS UNCHANGED: if a review has NEVER run
   * on this PR, there is no entry, hence `false` — plain `d` stays
   * byte-identical to the old, flag-free spawn (bound by a test too).
   */
  const hasAnyFindings = useCallback((pr) => {
    if (pr === null || pr === undefined) return false
    const entry = cacheAiFindings(cache.current, pr)
    return Boolean(entry && Array.isArray(entry.findings) && entry.findings.length > 0)
  }, [])

  /**
   * (wf31/6) IS THERE A NOT-YET-LOADED (paid-for, but not yet written into the
   * hunk) FINDING?
   *
   * WHY SEPARATE FROM `hasAnyFindings`, AND WHY NOT ONE PREDICATE FOR BOTH: the
   * two questions serve DIFFERENT decisions, and they differ precisely on the
   * `applied` flag — a merged predicate would be SILENTLY wrong at one of the
   * call sites.
   *   · `hasAnyFindings` → "IS THERE SOMETHING TO SHOW?" (the `d`'s
   *     `--agent-notes`): findings that are ALREADY loaded are also visible,
   *     so those also answer YES;
   *   · `hasUnloadedFindings` → "IS THERE UNFINISHED WORK?" (the `r`
   *     start-block and the exit warning): the user may have already reviewed
   *     the already-loaded ones, so those do not block restarting.
   * The `aiReviewLifecycle`'s `done` branch uses THIS SAME `applied !== true`
   * condition — so `r`'s behavior and the footer label spring from ONE root.
   */
  const hasUnloadedFindings = useCallback((pr) => {
    if (pr === null || pr === undefined) return false
    const entry = cacheAiFindings(cache.current, pr)
    return Boolean(entry && entry.applied !== true
      && Array.isArray(entry.findings) && entry.findings.length > 0)
  }, [])

  // (wf31/2) THE `release` PARAMETER IS LOAD-BEARING: right AFTER opening the
  // menu, we release both the lock AND `busy`. THE USER'S FINDING, verbatim:
  // "Then pressing 'r' again shows »working...«, then it reverts to the
  // »aborted« label."
  //
  // THE MEASURED REASON: `runExclusive` sets `setBusy(true)` at the START of
  // the call, and releases it in `finally` — but `askAiReview`, AFTER opening
  // the menu, also waits out a BLOCKING `fetchPrFiles` (~1 second of `gh` on a
  // live PR). That one second showed up in the status line as "working…".
  //
  // AND THIS IS NOT JUST COSMETIC: while `busy`, `useInput`'s VERY FIRST guard
  // (`if (actionLock.current || busy) return`) kills EVERY key — so the
  // freshly opened menu's OWN keys (`tab`/`m`/`b`/`y`/`Esc`) died SILENTLY for
  // a full second. The menu appeared, but didn't react; the user's
  // "inconsistent" finding is exactly this.
  //
  // WHY IT IS SAFE TO RELEASE HERE: the role of `busy`/lock is serializing
  // SPENDING, IRREVERSIBLE actions (approve/merge/upload/starting an AI
  // review). Opening the menu is NONE of those: a static UI switch, and the
  // measurement DELIBERATELY runs in the background (the UI stays usable —
  // this module's stated principle). The `aiHandle` guard (above) and the
  // `y` branch's dwell gate are UNCHANGED, so the token-spending path stays
  // protected — the lock was never ITS gate.
  const askAiReview = useCallback((row) => runExclusive(async (release) => {
    try {
      // NO NEW DIALOG WHILE A REVIEW IS RUNNING. The guard used to live in
      // `doAiReview` (running AFTER `y`), so `r` would open the confirmation,
      // and the immediate-feedback write below OVERWROTE the running review's
      // panel state — and `N`, by clearing 'starting', MADE THE PROGRESS
      // DISAPPEAR, while the review kept running in the background (the
      // user's measured bug path). So the guard must stand BEFORE EVERY state write.
      if (aiHandle.current) {
        setNotice('an AI review is already running in the background — wait for it, or abort it (x)')
        return
      }
      // (wf28/1-2) OPENING THE MENU DOES NOT WRITE `aiReview` STATE. THIS IS
      // THE CORE OF THE FIX, and it resolves TWO of the user's observations AT
      // ONCE — because BOTH came from the SAME ONE line (the old
      // `setAiReview({ status: 'starting' })`):
      //
      //   (1) a "⏳ AI review starting…" line appeared IN THE PANEL
      //       (`aiReviewPanelLines`'s 'starting' branch), which PUSHED DOWN
      //       the menu row. The user, verbatim: "breaks the positional anchor
      //       feeling that exists for the user on the menu";
      //   (2) in the FOOTER, the `r` segment switched to "review running…",
      //       because `aiReviewLifecycle` counts 'starting' as `running`. The
      //       user: "This should be a fully static UI path, this kind of
      //       transient legend state shouldn't even exist."
      //
      // THE DECISION (between the two options): the 'starting' status does NOT
      // GO AWAY, but it is simply never BORN on this path. WHY NOT the "stays
      // in state, we just don't render it" variant: 'starting' has THREE
      // consumers (MEASURED) — the panel line, the lifecycle→footer, AND the
      // `spinningPr` row spinner — so merely silencing the render would leave
      // the other two active (the footer would still write "review
      // running…": observation (2) would NOT be resolved), while holding a
      // state that means nothing. 'starting' REMAINS on the REAL start path
      // (`doAiReview`, AFTER `y`), where real feedback is needed before the
      // blocking session probe and git fetch — there all three consumers
      // state the TRUTH, because the review really is starting there.
      //
      // Opening the menu, however, is a STATIC UI SWITCH, not a process: there
      // is nothing to "start", so there is nothing to signal either.
      //
      // (state-machine-2) THE `aiPrevDone` SET-ASIDE HAS ALSO DISAPPEARED FROM
      // THIS PATH, and this isn't an omission but a CONSEQUENCE: the
      // save-and-restore was only needed because this line UNCONDITIONALLY
      // overwrote the single-slot state — including ANOTHER PR's finished
      // (done/done-answer) review, which had to be given back after a
      // dismissed confirmation (otherwise `r` there would have been a
      // RESTART, and a new paid review could have started WITHOUT the
      // friction of an explicit dismissal). If we don't write, there's
      // nothing to overwrite: the other PR's done state STAYS PUT, so the
      // invariant we're protecting is now met STRUCTURALLY, not by a
      // save-and-restore round trip — and since the ref thus has NO WRITER
      // LEFT, the whole mechanism (ref + restorer + its four call sites) was
      // ALSO REMOVED: see the removal rationale after the `useState` block. A
      // kept, eternally no-op restorer would have zeroed out a LIVE review's
      // state during `doAiReview`'s REAL 'starting' phase — the #904
      // "progress disappeared" bug class.
      //
      // THE PANEL, HOWEVER, DOES OPEN (this is `r`'s STATIC UI switch), and
      // `setTimeout(0)` lets the React flush happen BEFORE the blocking
      // `fetchPrFiles`: the MENU thus shows up IMMEDIATELY even on a live PR,
      // not after gh's 1 second.
      setPanel((cur) => (cur && cur.row?.number === row.number ? cur : panelOpen({ row })))
      // (wf28/1) THE MENU OPENS BEFORE THE MEASUREMENT, WITHOUT A SIZE. `size`
      // is needed for the SECOND stage's warning, which we compute AT THE
      // MOMENT of `y` (`reviewMenuWarning`) — so the measurement's result can
      // also arrive LATER into the menu. The dwell anchor (`armedAt`) is ALSO
      // born HERE: the dwell measures how long the decision has been IN FRONT
      // OF THE EYES, and the menu became visible HERE. (The old order took the
      // anchor AFTER the measurement, because the menu also only opened then —
      // now that the menu shows up earlier, the anchor needs to come earlier
      // too, otherwise gh's 1 second would COUNT TOWARD the dwell, and the
      // typeahead protection would be a silent no-op.)
      //
      // THERE'S DELIBERATELY NO `setAiReview` HERE — see the (wf28/1-2) block's
      // rationale above. An `{ status: 'starting' }` write returning here would
      // SIMULTANEOUSLY fail three tests: `wf28/1` (panel row), `6` (a signal
      // staying stuck), AND `state-machine-2` (losing ANOTHER PR's done state,
      // token risk) — because the `aiPrevDone` save-and-restore was retired AS A
      // CONSEQUENCE of this write. The two are ONE decision: if this line comes
      // back, the protection has to come back with it.
      const opened = {
        ...reviewMenuOpen({
          armedAt: Date.now(),
          modelEnv: process.env.TUIPR_AI_REVIEW_MODEL,
          budgetEnv: process.env.TUIPR_AI_REVIEW_BUDGET_USD,
        }),
        pr: row.number,
        // THE MEASUREMENT HAS NOT RUN YET — and we STATE that (`size: null`),
        // instead of lying with zeros. A `{ fileCount: 0, large: false }`
        // starting value would SILENTLY claim the PR is small, so `y` would
        // SKIP the SECOND stage (the large-PR warning) if the user presses it
        // BEFORE the measurement comes in — precisely the silent
        // friction-drain the dwell gate also forbids. The `y` branch handles
        // it fail-closed (see there).
        size: null,
      }
      setReviewMenu(opened)
      // (wf31/2) THE LOCK/`busy` RELEASE IS HERE — the menu is VISIBLE, so its
      // keys are ALIVE. From here only the MEASUREMENT runs (the blocking
      // `fetchPrFiles`), which deliberately doesn't block the UI: `size`
      // arrives LATER into the already-open menu (see the identity-checked
      // update below).
      //
      // `runExclusive`'s `release` is IDEMPOTENT, so the second call in
      // `finally` is a no-op — it doesn't "release twice".
      release()
      // (wf31/42) An Ink flush instead of `setTimeout(0)` — see `runExclusive`'s doc head.
      try {
        await waitUntilRenderFlush()
      } catch { /* fail-soft: see there */ }
      const files = fetchPrFiles(row.number)
      // THE CEILING IS OFF BY DEFAULT: the env only gives a STARTING VALUE. If
      // there's no env, `budget.usd` is undefined, so `--max-budget-usd` isn't
      // even SENT on the call path (see the core's budgetArgs). The old
      // formula scaled to PR size is retired: that flag is for API spend, but
      // the user is consuming a subscription limit, where there's nothing to
      // cut in dollars — the scaling was tuned on a NON-EXISTENT axis.
      //
      // (2) READING THE ENV MOVED into `reviewMenuOpen` (`budgetEnv`): the menu
      // also NORMALIZES it to its own four-way cycle (off → 3 → 5 → 10), which a
      // separate `aiReviewBudgetState` call here couldn't do — a $1 value from
      // env would fall outside the cycle, and the first press of `b` would land
      // somewhere unpredictable.
      //
      // WE DELIBERATELY DON'T pass the ceiling into the SUMMARY, even if the
      // env turned it on: the ceiling's ONLY display is the menu's `b:` segment.
      //
      // WE CALL SUMMARY FOR THE SIZE (fileCount / additions / deletions /
      // large) — the `lines` PROSE was content of the RETIRED dialog, nobody
      // renders that anymore. The THRESHOLD DECISION (`large`), though, still
      // lives in the core: the second stage's warning follows from it, and two
      // threshold sources is exactly the drift the project forbids.
      const summary = aiReviewSummary({ pr: row.number, files })
      // (2) BLOCKERS get decided BEFORE the confirmation, and if there are any,
      // the MENU DOESN'T EVEN OPEN — they go to the ERROR OVERLAY.
      //
      // WHY THIS WAY, AND WHY NOT IN THE MENU: the old modal had a "denied"
      // branch (the blockers list in red, `y` inactive). The menu is ONE ROW —
      // a multi-paragraph blocker explanation (`claude` isn't on PATH, install
      // it, or add it to PATH…) doesn't fit there on ANY terminal, and a
      // truncated blocker message is USELESS: it's exactly WHAT TO DO that the
      // user wouldn't find out. The error overlay, though, wraps and gives the
      // full text — that's its place. THE GATE'S VALUE IS UNCHANGED: with a
      // blocker present, the token-spending path does NOT start, only the
      // signal's location became the right one.
      const blockers = aiReviewBlockers({ claudePath: claudePath(), scope: summary.scope })
      if (blockers.length > 0) {
        // (wf28/1) THE MENU IS ALREADY OPEN (it opened before the measurement),
        // so the blocker now CLOSES it — in the old code there was nothing yet
        // to close here. THE GATE'S VALUE IS UNCHANGED: with a blocker present,
        // the token-spending path doesn't start, and `y` isn't even reachable,
        // because the menu disappears under the error overlay.
        //
        // THE CLOSE IS IDENTITY-CHECKED (`cur?.pr === row.number`): if the user
        // already closed the menu during the measurement's ~1 second and opened
        // a new one on ANOTHER PR, this late blocker must not close THAT one —
        // a stranger's menu vanishing silently is exactly the "did it break?"
        // uncertainty.
        setReviewMenu((cur) => (cur && cur.pr === row.number ? null : cur))
        showError(row, `AI review cannot start:\n${blockers.map((b) => `· ${b}`).join('\n')}`)
        return
      }
      // (wf28/1) THE MEASURED SIZE ARRIVES LATER into the ALREADY OPEN menu.
      // The menu opened BEFORE the measurement (so a real PR doesn't require
      // waiting out gh's 1 second without feedback), so here we no longer
      // OPEN, we UPDATE — and ONLY the `size` field: the user may have changed
      // the `tab`/`m`/`b` toggles meanwhile, and a full overwrite
      // (re-calling `reviewMenuOpen`) would SILENTLY reset the defaults.
      // `armedAt` is PROTECTED the same way: the anchor was born AT OPENING
      // TIME (the dwell has been ticking since), a fresh arm here would
      // restart the gate.
      //
      // THE IDENTITY CHECK IS HERE TOO: a late measurement must not write into
      // ANOTHER PR's menu — that user would get the large-PR warning sized for
      // a STRANGER PR (or not get it at all). We also don't touch `stage`: if
      // the user already pressed `y` during the measurement, they may be on the
      // second stage.
      //
      // THE `warning` TEXT ISN'T DECIDED HERE: the SECOND STAGE asks at the
      // MOMENT of `y` (see the useInput menu branch), from THIS measured size.
      // So the state doesn't carry stale warning text.
      const size = {
        fileCount: summary.fileCount,
        additions: summary.additions,
        deletions: summary.deletions,
        large: summary.large,
      }
      setReviewMenu((cur) => (cur && cur.pr === row.number ? { ...cur, size } : cur))
    } catch (error) {
      // (wf28/1) A FAILED PREPARATION CLOSES THE ALREADY OPEN MENU (filtered by
      // identity, like the blocker branch). The old `restoreAiPrevDone()` call
      // DROPPED OUT: this path no longer writes `aiReview` state, so there's
      // nothing to restore — the other PR's done state stayed untouched.
      setReviewMenu((cur) => (cur && cur.pr === row.number ? null : cur))
      showError(row, `AI review cannot start: ${error.message}`)
    }
    // (2) `openModal` DROPPED OUT of the deps: the AI-review path no longer
    // opens a modal, it calls the `setReviewMenu` state setter (which is
    // stable, so it doesn't need to be in the list either). The other three
    // confirmations (approve/merge/upload) UNCHANGED, still use `openModal` on
    // their own branches.
  }), [runExclusive, showError])

  /**
   * (wf31/6) `r`'S PATH — NO-OP with a DONE review, otherwise starts one.
   *
   * THE GUARD IS LOAD-BEARING, AND STAYS: in the `done` state, `r` must NOT
   * start a new one, because a restart would OVERWRITE the PAID-FOR, unloaded
   * findings (in the in-memory cache AND on disk — `persistReview` writes to
   * the same PR key). The precondition for a new start remains an explicit
   * dismissal (double `x`).
   *
   * (wf31/12) THE SIGNAL, THOUGH, WAS RETIRED — the user's request, verbatim:
   * "This text is completely unnecessary, no need to spell out that we
   * brought a cached review into the app. This status line is unnecessary,
   * take it out."
   *
   * WHY IT STILL DOESN'T STAY A "SILENT BUTTON" (the wf31/6 rationale here is
   * OUTDATED): back then, `r` was an ADVERTISED key even in the `done` state
   * (the footer showed it as `r: dismiss (x)`), and an advertised-but-silent
   * button really is the worst outcome — the user can't tell whether the
   * button is broken or the UI froze. AS OF NOW the footer advertises `x:
   * dismiss review`, so `r` is NOT an advertised key in this state: its silent
   * death is the same as any other non-advertised button's. So the bug class
   * doesn't return — its precondition is gone.
   *
   * THE NEXT STEP ISN'T LOST EITHER: `d` (open) and `x` (dismiss) both live in
   * the panel's FOOTER, so the user sees them right in front of their eyes —
   * not in a status line that flashes on a keypress and disappears with the
   * next action anyway.
   */
  const rKeyAction = useCallback((row) => {
    if (!row) return
    // PROTECTING THE PAID-FOR, UNLOADED FINDINGS: silent return. The footer
    // advertises the dismiss (`x`) and open (`d`) keys.
    if (hasUnloadedFindings(row.number)) return
    askAiReview(row)
  }, [askAiReview, hasUnloadedFindings])

  // Approve calls the EXISTING non-interactive path — BUT WITH AN EXPLICIT `--body`.
  //
  // WHY NOT BASH'S DEFAULT (this is the feature's most expensive assertion):
  // without `--body`, `cmd_approve` posts the text
  //     "Reviewed in next queue session <date> — next @ <sha>"
  // This STATES that a review happened. Without a review trace, this is a LIE
  // in the PR's AUDIT TRAIL — and this is exactly the core of the user's
  // principle 1: friction is NOT a hard gate precisely because the
  // ATTESTATION must tell the truth, not because the gate must force a proxy
  // trace. (A hard gate would teach us to spend tokens for a fake attestation trace.)
  //
  // THE TRACE comes from the session cache (markReviewTrace): whether an
  // AI review ran in this session, or a hunk finding got uploaded, for THIS
  // PR. We do NOT ask GitHub again: `d` (diff review) reading is DELIBERATELY
  // trace-free (opening a diff isn't a review), so the trace states a FACT,
  // not an intent.
  //
  // `runExclusive` HERE TOO: the earlier shape set `setBusy(true)`, then ran
  // through WITHOUT try/finally. If anything threw (spawnSync, `showError`,
  // `approveBody`), `busy` stayed stuck FOREVER: "working…" forever, and not a
  // single key was alive (dies at `useInput`'s `if (busy) return`). This is
  // the user-reported stuck state's SECOND, independent branch — separate from `d`'s.
  const doApprove = useCallback((row) => runExclusive(async () => {
    const traces = reviewTraceSources(cache.current, row.number)
    const body = approveBody({
      hasTrace: traces.length > 0,
      traceSources: traces,
      date: new Date().toISOString().slice(0, 10),
      // The bash path would also write `next`'s SHA; we do NOT re-measure it
      // here (a second `git rev-parse` on approve's critical path would pay
      // for something the body doesn't even use for a decision). The tag is
      // SKIPPED, not included as `undefined`
      // — false precision is worse than absence (see approveBody).
      nextSha: null,
    })
    const res = spawnSync(
      'bash',
      [new URL('tuipr.sh', import.meta.url).pathname, 'approve', String(row.number), '--body', body, '--yes'],
      { encoding: 'utf8' },
    )
    // We check ENOENT SEPARATELY: on a spawn error `status` is null and stderr
    // is EMPTY, so `status === 0` is false, but the error text would also be
    // empty — the user would get a content-free "approve error:" line.
    // `res.error` tells us that bash/the script itself never started (this is
    // a DIFFERENT diagnosis than a refused approve).
    if (res.error) showError(row, `approve could not start (${res.error.code ?? 'spawn error'}): ${res.error.message}`)
    else if (res.status !== 0) showError(row, `approve error: ${(res.stderr || res.stdout || '').trim() || `exit ${res.status}`}`)
    else {
      setNotice(`#${row.number}: approved`)
      // (wf31/25) OPTIMISTIC MARKING: the list mark switches to `✔ approved`
      // IMMEDIATELY — otherwise, due to index lag, the reload would still give
      // back the old `reviewDecision`.
      setOptimistic((cur) => ({ ...cur, [row.number]: 'approved' }))
    }
    reload()
  }, 'a', row?.number), [reload, runExclusive, showError])

  // Closing out a running measurement: KILL + release the handle. EVERY exit
  // path (Esc, panel close, unmount) goes through this — so a zombie
  // merge-tree probe can never be left behind in the background.
  const stopDiagnosis = useCallback(() => {
    diagHandle.current?.abort()
    diagHandle.current = null
  }, [])

  // Opening the info panel: the fast part (queue model + CI signals) shows
  // IMMEDIATELY, and NO MEASUREMENT starts.
  //
  // (wf31/10) OPENING NO LONGER MEASURES — the `c` key (`measureConflict`) does.
  // The full rationale lives at the measurement-launching branch; the short
  // form: the cumulative truth is already given by the next-graph
  // (`pedestal_prs`) and the CI labels, without measuring — and even MORE
  // STRONGLY (the CI does a cumulative rebase, the local probe simulates a
  // merge). So the on-open measurement was wasted work on most PRs.
  //
  // THE CACHE-HIT BRANCH STAYS UNCHANGED HERE: if there is a FRESH measured
  // diagnosis, the panel displays it. That's not MEASURING, it's showing an
  // ALREADY PAID-FOR result — and staying silent about it would be exactly the
  // silence the cache-hit branch's rationale below forbids.
  //
  // STALE PROTECTION HAS TWO LAYERS:
  //   1) the core reducer drops events with a MISMATCHED PR number (progressReducer),
  //   2) applyProgressToInfo checks that the state is STILL the row the
  //      measurement was started for. The two are not redundant: (1) excludes
  //      a wrong PR on the measuring side, (2) excludes the case where the
  //      user meanwhile opened the panel on ANOTHER row, and the old
  //      measurement's callback would write into the new panel's state.
  // BOTH updaters go through the helper — the decision lives in a PURE
  // function so it's unit-testable (it used to be inline, and stayed green
  // even after being pulled out).
  const openInfo = useCallback((row) => {
    stopDiagnosis()
    // (wf31/30) THE CAVEAT RESTORE DROPPED OUT: there's no longer an open/closed
    // state that would need restoring on row switch (there are two states: has
    // a measurement / doesn't). The rationale for retiring the `caveatOpen`
    // state lives at its declaration.
    const infoModel = buildInfoModel({ row, progress: null })
    if (!infoModel.measurable) {
      // Nothing to measure (stacked row): the panel only gives the fast part,
      // NO measurement starts — a probe run against the pedestal would show
      // the pedestal's conflicts as if they were the stacked PR's own.
      setPanel(panelOpen({ row, progress: null }))
      return
    }
    // THE CACHE HIT: if there is a MEASURED diagnosis, and the anchor (PR
    // updatedAt + origin/main SHA) has NOT moved, the measurement does NOT
    // restart — the panel gets the cached result. This is the user's point 4:
    // reopening `i` used to re-run the merge-tree probes every time, and they
    // called that disruptive.
    //
    // THE CACHE HIT ALSO CANNOT BE SILENT: we ALSO put the measured result INTO
    // the panel. If we only skipped the measurement, the second opening would
    // give an EMPTY measured strip — that's worse than re-measuring (the user
    // would read the empty strip as "no conflict").
    const anchor = cacheAnchor({ row, mainSha })
    const entry = cacheGet(cache.current, row.number, 'diagnosis')
    if (cacheEntryState(entry, anchor) === 'fresh') {
      // The `progress` state is RECONSTRUCTED from the measured diagnosis,
      // through the SAME reducer the live stream uses — so the panel knows a
      // single shape, and the cached picture can't diverge from a freshly
      // measured one.
      const restored = progressReducer(
        { ...progressInit(row.number), total: entry.value?.probed ?? 0, done: entry.value?.probed ?? 0 },
        { event: 'result', pr: row.number, diagnosis: entry.value },
      )
      setPanel(panelOpen({ row, progress: restored }))
      setNotice(`#${row.number}: diagnosis from cache (did not re-measure) — R: refresh`)
      return
    }
    // (wf31/10) OPENING THE PANEL NO LONGER MEASURES. The user's decision: the
    // conflict measurement should start on a SEPARATE UI command (`c`);
    // opening the panel should never trigger it.
    //
    // WHY: the measurement was WASTED work on most PRs. The cumulative truth is
    // already known, without measuring, from TWO sources:
    //   (1) `pedestal_prs` reads which PRs ACTUALLY got merged
    //       (`merge: next <- #N`) from the next branch's first-parent merge
    //       commits — this feeds the queue view's `queue` state;
    //   (2) CI LABELS the PRs that drop out (`next-conflict` / `next-blocked`).
    // The rebuild is ITSELF cumulative (`git rebase next "pr/N"` on top of
    // next), so for anything that's in the chain, CI has already measured that
    // it merges in — and that is a STRONGER fact than what the local probe can
    // give, because it reflects CI's ACTUAL operation. The local pairwise
    // merge-tree, by contrast, SIMULATES a merge (its own caveat says so),
    // so it gave a LESS CERTAIN answer to the same question — `k-1` probes per
    // PR, O(N²) in total.
    //
    // WHAT'S LEFT FOR MEASUREMENT: naming the culprit ("WHO am I conflicting
    // with, WHO can I stack on"). Neither the graph nor the label says that —
    // `next-conflict` only says you dropped out. But that's a RARE question,
    // and per the user's decision it deserves an EXPLICIT gesture, not an
    // automatic run.
    //
    // THE MAIN AXIS ALSO MOVED BEHIND `c`, even though it's O(1) and measures
    // something DIFFERENT (a conflict with main blocks landing, which the
    // labels don't reveal). The user's mandate was clear — "even on a
    // next-conflict, only run the investigation on a separate UI command" —
    // and a kept automatic main-probe would bring back exactly what the
    // decision eliminates: opening the panel spawning a child. The axis is
    // NOT lost: `c` measures it, and the measured result stays cached.
    setPanel(panelOpen({ row, progress: null }))
    // (wf31/49) THE HEADER NOTICE RETIRED — TWO MEASURED FINDINGS, ONE ROOT.
    //
    // The user's findings: (1) "this label flips from dim to white exactly when
    // an info panel opens, and the header dims"; (2) "this label doesn't react
    // to whether the measurement happened or has happened".
    //
    // THE ROOT IS THE SAME FOR BOTH: we put STATE information on an EPHEMERAL
    // channel. `notice` is the header's right-edge one-shot feedback (wf31/23)
    // — the next action overwrites it, and it does NOT re-render from the
    // measurement's result, so the "did not run" sentence was still there
    // AFTER the measurement too (finding 2). Meanwhile the rest of the header
    // dims via `dimColor: frame ? true : undefined` under the open panel, while
    // the notice stays unchanged — this inverted contrast reads as "turned
    // white" (finding 1). So the notice stands out exactly where the header is
    // deliberately meant to recede.
    //
    // AND IT ISN'T EVEN NEEDED: the panel ITSELF already states the same thing
    // (the `mt-hint` key, "· main: not measured — c: measure (…)"), in the
    // body — rendered FROM STATE, so it switches to the measured result on its
    // own after measuring, and moves together with the open panel's dimming.
    // The header instance was pure duplication, on the worse channel.
    //
    // THIS IS THE wf31/23 PRINCIPLE APPLIED: the hint belongs at the
    // TRIGGERING SITE (where the decision is made), not in a global strip.
  }, [bumpCache, mainSha, stopDiagnosis])

  /**
   * (wf31/10) THE EXPLICIT LAUNCH OF THE CONFLICT MEASUREMENT — the `c` key.
   *
   * WHY A SEPARATE CALLBACK, AND NOT A BRANCH OF `openInfo`: the two gestures
   * are DIFFERENT — opening the panel is FREE (queue model + cache), while the
   * measurement spawns a child process and runs a merge-tree probe against
   * EVERY PR ahead of it in the queue. So the split isn't just for
   * convenience: the expensive path is placed behind an EXPLICIT gesture,
   * the same principle that also holds for the `d`/`r` (free vs. token) pair.
   *
   * THE CACHE IS RESPECTED HERE TOO: if there is a FRESH measured entry, `c`
   * does NOT re-measure, it just puts it into the panel. So repeated presses
   * of `c` don't spend needlessly — the re-measurement path is `R` (full
   * cache invalidation).
   */
  const measureConflict = useCallback((row) => {
    if (row === null || row === undefined) return
    const infoModel = buildInfoModel({ row, progress: null })
    if (!infoModel.measurable) {
      // STACKED PR: nothing to measure (its fate is decided by its pedestal) —
      // the probe would show the pedestal's conflicts as if they were the
      // stacked PR's own.
      setNotice(`#${row.number}: stacked PR — nothing to measure, diagnose the pedestal`)
      return
    }
    const anchor = cacheAnchor({ row, mainSha })
    const entry = cacheGet(cache.current, row.number, 'diagnosis')
    if (cacheEntryState(entry, anchor) === 'fresh') {
      // ALREADY THERE, FRESH: we put it into the panel, but do NOT re-measure.
      // The reconstruction goes through the SAME reducer the live stream
      // uses — so the panel knows a single shape.
      const restored = progressReducer(
        { ...progressInit(row.number), total: entry.value?.probed ?? 0, done: entry.value?.probed ?? 0 },
        { event: 'result', pr: row.number, diagnosis: entry.value },
      )
      setPanel((cur) => (cur === null ? cur : { ...cur, progress: restored }))
      setNotice(`#${row.number}: diagnosis from cache (did not re-measure) — R: refresh`)
      return
    }
    // ONLY ONE MEASUREMENT RUNS AT A TIME: `stopDiagnosis` closes the old one,
    // otherwise two blocking probe series would race for the same cache entry.
    stopDiagnosis()
    // The `measuring` mark goes in IMMEDIATELY, so the `⋯` already shows on the
    // list while the measurement is running — "measurement running" is its own
    // state.
    cacheMarkMeasuring(cache.current, row.number, 'diagnosis', { anchor })
    bumpCache()
    setPanel((cur) => (cur === null ? cur : { ...cur, progress: progressInit(row.number) }))
    // (allapotgep-1) THE HANDLE CLOSES OUT BY IDENTITY — the `aiHandle` pattern.
    //
    // The child's close event is ASYNCHRONOUS: on panel navigation,
    // stopDiagnosis + starting the new measurement run SYNCHRONOUSLY, so the
    // OLD measurement's onExit always arrives AFTER the NEW handle is written.
    // An unconditional `diagHandle.current = null` here would drop the NEW
    // measurement's handle: the measurement becomes unabortable (Esc/q/R
    // become no-ops), the child becomes a zombie merge-tree probe that
    // outlives the TUI too, and its result gets written to the cache for a
    // question that's already closed.
    const handle = startProgressDiagnosis(row.number, {
      onEvent(ev) {
        setPanel((cur) => applyProgressToPanel(cur, row.number, ev))
        // The MEASURED DIAGNOSIS also goes into the cache — with the ANCHOR the
        // measurement STARTED with (not the current one): if main has since
        // moved, the entry immediately counts as stale, which is TRUE — the
        // probe measured against the old main.
        if (ev.event === 'result' && ev.diagnosis && typeof ev.diagnosis === 'object') {
          // SECOND LINE OF DEFENSE, but its BOUNDARY IS MEASURED — don't rely on
          // it alone.
          //
          // The FIRST line of defense against an abort (and the one that
          // ACTUALLY closes the race) is AT THE SOURCE:
          // `startProgressDiagnosis` doesn't emit any further event after an
          // abort. WHY this guard alone isn't enough: per measurement, the late
          // `data:result` PRECEDES `onExit`
          // (`data:start -> data:result -> close(onExit)`), so at that moment
          // the entry is STILL `measuring: true` — this guard wouldn't catch it
          // there. What it DOES cover: states without `measuring` (an
          // already-closed error/aborted entry, or a late `result` arriving
          // after an `R` invalidation) — the late value must not mark those as
          // "done" either.
          //
          // The guard is HERE too because the cache write is the most expensive
          // assertion: the user lands based on the list's `✓`.
          const cur = cacheGet(cache.current, row.number, 'diagnosis')
          if (cur?.measuring !== true) return
          cachePut(cache.current, row.number, 'diagnosis', { value: ev.diagnosis, anchor })
          bumpCache()
        }
      },
      onExit(res) {
        // We only release OUR OWN handle (identity guard): a stale run closing
        // out must not null out a NEWER measurement's handle. `close` is
        // asynchronous, so the `handle` const here is always already filled in.
        if (diagHandle.current === handle) diagHandle.current = null
        // THE ERROR IS LOUD: we inject the `close`/`error` branch's error as an
        // state machine, so the panel doesn't stay stuck at "measuring…"
        // forever. An aborted measurement, though, is NOT an error — there the
        // user made the decision.
        if (!res?.error) {
          // The `measuring` mark must be closed out on EVERY outcome, including
          // the success path: if the `result` event never arrived (abort,
          // truncated output), the row would sit on the list marked "measuring…"
          // forever — a false state the user would wait on in vain.
          const cur = cacheGet(cache.current, row.number, 'diagnosis')
          if (cur?.measuring === true) {
            cachePut(cache.current, row.number, 'diagnosis', { aborted: true, anchor })
            bumpCache()
          }
          return
        }
        // ON ERROR the entry closes out with `error`: there's no "done" check
        // mark (no measured result), and the row can be re-measured.
        cachePut(cache.current, row.number, 'diagnosis', { error: res.error, anchor })
        bumpCache()
        setPanel((cur) =>
          applyProgressToPanel(cur, row.number, { event: 'error', pr: row.number, message: res.error }),
        )
      },
    })
    diagHandle.current = handle
  }, [bumpCache, mainSha, stopDiagnosis])

  // If the component unmounts (exit) while a measurement is running, the child
  // must be killed there too: otherwise a running merge-tree probe series
  // would be left behind after `q`.
  useEffect(() => stopDiagnosis, [stopDiagnosis])

  // THE SAME FOR THE BACKGROUND REVIEW. `q` (exit) aborts it in `useInput`, BUT
  // the unmount can also happen via OTHER paths (Ctrl+C, the parent
  // unmounting, an error) — and a detached `claude -p` would write into a hunk
  // session nobody is looking at anymore. The two paths together rule out the
  // zombie.
  useEffect(() => stopAiReview, [stopAiReview])

  // --- THE BACKGROUND POLL'S TICK --------------------------------------------
  //
  // The TICK reads the GATES from fresh `ref`s, NOT from the hook's dependency
  // list.
  //
  // WHY (this is the substantive design decision): if the `overlayOpen`/
  // `measuring` states were on the `useEffect` dependency list, EVERY panel
  // open and close would STOP and RESTART the interval — the due-time counter
  // would reset, and on an actively-paneling user's machine the poll would
  // NEVER run. So the gates are read INSIDE the tick, while the interval
  // itself is created ONCE in the component's lifetime.
  const gateRef = React.useRef({ overlayOpen: false, measuring: false })
  gateRef.current = {
    // `busy` also counts as an overlay: an action is running, the UI is
    // blocked. BOTH panel modes (inline info AND modal confirmation) count as
    // gates: per the poll section's (a) gate rationale, when a dialog is open
    // the focus is on the decision/reading, and the poll must not interrupt.
    overlayOpen: errorState !== null || panel !== null || busy,
    // The MEASUREMENT is "running" when the panel's progress state is
    // running. `diagHandle` isn't enough: the child's kill is asynchronous, so
    // the handle can still be there for an already-finished measurement.
    measuring: panel?.progress?.running === true,
  }

  useEffect(() => {
    const tickMs = pollIntervalMs ?? POLL_INTERVAL_MS
    const timer = setInterval(() => {
      // TWO PROBES NEVER RUN AT ONCE: `fetchStalenessProbe` is spawnSync-based
      // (blocking), and an overlapping launch would freeze the UI twice as
      // long.
      if (probing.current) return
      const t = now()
      const gates = gateRef.current
      if (!pollDue(poll.current, { ...gates, now: t })) return
      probing.current = true
      try {
        // THE PROBE. NEVER THROWS (gives a structured `{ ok, error }`) — the
        // poll is a background process, a throw here would end up as an
        // unhandled rejection and take the TUI down with it.
        const res = fetchStalenessProbe()
        if (!res.ok) {
          // SILENT RETRY (backoff). The raw error text goes into the state
          // (for diagnostics), NOT into the UI — neither an overlay nor a
          // status line: a background operation's error can't ask the user
          // for an acknowledgment.
          poll.current = pollFailure(poll.current, { now: t, message: res.error })
        } else {
          const changed = stalenessChanged(poll.current.signature, res.signature)
          poll.current = pollProbeResult(poll.current, { changed, signature: res.signature, now: t })
        }
        // ONLY a change in the VISIBLE signal triggers a render. `setPollLabel`
        // only writes when the text is ACTUALLY different — without this,
        // every tick would re-render the list (relying on React's bail-out
        // here is risky: the state is a no-op for an identical string, but we
        // state the intent explicitly, because this is the guarantee behind
        // the poll's UI cost).
        const label = pollStatusLabel(poll.current)
        setPollLabel((prev) => (prev === label ? prev : label))
      } finally {
        // FINALLY: an unexpected throw must not leave the sentinel raised,
        // otherwise the poll would stop FOREVER (and silently — exactly the
        // forbidden branch).
        probing.current = false
      }
    }, tickMs)
    return () => clearInterval(timer)
    // THE DEPENDENCY LIST IS DELIBERATELY MINIMAL: the interval is created
    // once in the component's lifetime. The gates and state come in via ref
    // (see the rationale above), so they aren't needed here either.
  }, [pollIntervalMs, now])

  // --- THE BACKGROUND REVIEW'S PROGRESS TICK (#904) --------------------------
  //
  // THE USER'S REPORT: "even after 5 minutes I see no feedback anywhere, the
  // app still shows the message from above". The old code wrote a static
  // status line ONCE. This ticker is what keeps the status line MOVING.
  //
  // THE THREE TIMERS TOGETHER (the requirement explicitly asked for this):
  //
  //   1. THE BACKGROUND POLL (`pollIntervalMs`, 100 s in production) — measures
  //      the queue's staleness. its OWN interval, with its own `probing.current`
  //      sentinel and the `gateRef` gates. THIS TICKER DOESN'T TOUCH IT, and
  //      doesn't collide with it either: the review's `setAiTick` is a
  //      DIFFERENT state, and the poll's `setPollLabel` already today only
  //      writes on CHANGE.
  //   2. THE PROGRESSIVE MEASUREMENT (`diagHandle`) — event-driven (NDJSON from
  //      the child), has no interval. Independent.
  //   3. THIS TICKER — only does work when `aiLive.current !== null`, so
  //      without a review its cost is ZERO (an `if` per tick).
  //
  // THE TICK'S COST IS MEASURED, NOT GUESSED (25-PR-row list + ticker line, ink
  // 7.1.1 / node 24.18.0, 20 render warmup skipped, 60 measured renders): 12.2
  // ms CPU/render, which is ~1.2% on one core at a 1 s tick. Control run with a
  // real 1 s tick: `cpu_pct_of_wall: 1.97` (including startup cost). Negligible.
  //
  // THE FINDING POLL IS RARER, BECAUSE IT'S MORE EXPENSIVE: `hunk session
  // comment list`'s measured cost is 0.42 s/call with a live hunk TUI (cold:
  // 0.62 s). At a 5 s cadence that's a ~8% duty cycle; at 1 s it would be 42% —
  // too much. That's why the TWO cadences are SEPARATE props.
  useEffect(() => {
    const tickMs = aiTickMs ?? 1000
    const findingMs = aiFindingPollMs ?? 5000
    let lastFindingAt = 0
    // THE COUNTER STEPS when the ticker is SET UP — the cleanup decrements it.
    // Without this the leak only showed up as process noise (MEASURED: the
    // runner gave `✖`, then GOT STUCK, with no summary line, SIGKILL after
    // 120 s). See the head of `activeTickers()`.
    tickerCount += 1
    const timer = setInterval(() => {
      const live = aiLive.current
      // NO RUNNING REVIEW → NO WORK. The ticker's cost is then just an `if`.
      if (!live) return
      const elapsedMs = Date.now() - live.startedAt
      // THE FINDING COUNTER IS RARER: the hunk call is blocking I/O
      // (spawnSync), so calling it on every tick would freeze the UI every
      // 0.42 s. ONLY WITH A LIVE SESSION: in answer-only mode there's nothing
      // to count from (the findings come at the END of the review, from the
      // answer).
      if (live.sessionAlive && elapsedMs - lastFindingAt >= findingMs) {
        lastFindingAt = elapsedMs
        try {
          // A SET DIFF, not a plain count: the user sits in the diff and can
          // WRITE at the same time, so an increase in the count is not the
          // AGENT's progress. Same argument as at the final gate.
          const nowIds = hunkAgentNoteIds(live.repoRoot, { context: 'after' })
          live.findings = [...nowIds].filter((id) => !live.before.has(id)).length
        } catch {
          // THE POLL'S ERROR IS SILENT — AND THIS IS A DELIBERATE, NARROW
          // EXCEPTION HERE.
          //
          // WHY NOT LOUD (the project forbids silently swallowing errors, so
          // this needs justifying): this call ONLY refreshes the progress
          // COUNTER. The REAL gate runs at the END of the review, over the same
          // hunk path, and there the error IS loud. A background signal's error
          // can't ask the user for an acknowledgment, and can't decide a
          // running review — the same contract as the background poll's silent
          // backoff.
          //
          // WHAT DOESN'T HAPPEN: the old `findings` value STAYS (we don't zero
          // it), so the signal doesn't "fall back" on a transient hunk error.
        }
      }
      // ONE TICK, TWO CONSUMERS (point 4's stipulation — no separate timer): the
      // `aiTick` advances both the PANEL's elapsed-time line (aiReviewPanelLines
      // with a fresh `Date.now()`) AND the list row's Braille spinner (frame
      // index). The render cost is the same as the old label-diff path's: ~1
      // render/s, ONLY while a review is running (without one, the `if (!live)`
      // above exits early).
      setAiTick((t) => t + 1)
    }, tickMs)
    // THE `unref()`: THE LEAK'S CONSEQUENCE DISAPPEARS, NOT THE LEAK ITSELF.
    //
    // MEASURED RATIONALE (adversarial mutation, MUT8'): with the cleanup
    // knocked out, the test runner gave `✖` for the leak test, BUT THEN GOT
    // STUCK — the summary line (`ℹ tests/pass/fail`) never got written, SIGKILL
    // was needed after 120 s. In CI this shows up as a JOB TIMEOUT, not a
    // failed test, and the hang takes down the OTHER tests' results with it.
    //
    // An unref'd `setInterval` does NOT keep the Node event loop alive, so a
    // timer left behind can no longer cause process noise — neither in CI nor
    // at the TUI's `q`. For the TUI this is NOT a loss of function: Ink's
    // render loop is kept alive by raw-mode stdin, not by this ticker.
    //
    // `unref` DOES NOT REPLACE THE CLEANUP: that is still NEEDED (otherwise the
    // ticker would call an unmounted component's `setAiTick`, and `tickerCount`
    // wouldn't reset either). The two solve DIFFERENT problems: `unref` solves
    // the NOISE, the cleanup + the counter solve the LEAK ITSELF (measurably,
    // via assertion).
    //
    // The `?.` is for injectable/non-Node timer implementations (it exists on
    // Node's `Timeout` object, not on a plain number).
    timer?.unref?.()
    return () => {
      clearInterval(timer)
      tickerCount -= 1
    }
    // THE DEPENDENCY LIST IS MINIMAL (like the poll's): the interval is
    // created once in the component's lifetime, the state comes in via `ref`.
    // A list containing `aiLive` would restart the ticker on every review start.
  }, [aiTickMs, aiFindingPollMs])

  // (wf31/53) STACKING CAN NOW BE STARTED FROM HERE TOO — BUT ONLY UNDER A
  // MEASURED CONDITION.
  //
  // The user's request: "stacking should be offered in the info panel's status
  // in this state (with pending UI)". The measurement (`conflictAdvice`)
  // ALREADY decides whether there is a stack target — until now only the
  // COMMAND was printed out, and the user had to retype it by hand.
  //
  // THE EARLIER DECISION ("WHY THERE'S NO doStack") WAS NOT WRONG, AND ITS
  // REASON STILL LIVES HERE: `publish --stack-on` operates on the CURRENT
  // LOCAL branch (cmd_publish: `${1:-$(current_branch)}` + need_next_work_branch),
  // while the TUI's selected row is an ALREADY PUBLISHED, REMOTE PR — the two
  // are typically NOT the same. Running it blindly would publish whatever
  // branch the user happens to be standing on: wrong branch, with a stack
  // target referencing someone else's PR.
  //
  // WHAT CHANGED: the condition is now MEASURABLE. The model gives us
  // `headRefName`, git tells us the local HEAD — if the two MATCH, the
  // operation runs on exactly the branch the PR is about, and the old
  // objection no longer applies. If they DON'T match, we DON'T run it: the
  // error STATES which branch to switch to.
  //
  // `spawnSync` + output capture follows `doMerge`'s PATTERN (not
  // `suspendTerminal`): publish isn't an interactive TUI, it only writes.
  // HOWEVER it runs `git rebase`, which CAN hit a CONFLICT — and then the
  // worktree is left in a half-finished rebase. This error branch states that
  // EXPLICITLY, because a silent "didn't work" here is the most expensive
  // outcome: the user would sit in the TUI while their repo sits in a
  // conflicted state.
  const doStack = useCallback((row, stackOn) => runExclusive(async () => {
    const want = typeof row?.headRefName === 'string' ? row.headRefName.trim() : ''
    if (want === '') {
      showError(row, 'the PR head branch name is unknown (missing data in the model), so stacking will not start — '
        + 'the panel prints the command, run it from your own branch.')
      return
    }
    const head = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' })
    const at = head.status === 0 ? String(head.stdout ?? '').trim() : ''
    if (at === '') {
      showError(row, 'the local branch could not be read (git rev-parse), so stacking will not start.')
      return
    }
    // FAIL-CLOSED ON BRANCH MISMATCH: not "try it and see" — publish WOULD
    // modify whatever branch the user is standing on.
    if (at !== want) {
      showError(row, `stacking runs on the PR's own branch, but you're standing on '${at}' `
        + `(#${row.number}'s branch is: '${want}'). Switch to it, then start again from here — `
        + 'or run the command printed in the panel.')
      return
    }
    const res = spawnSync(
      'bash',
      [new URL('tuipr.sh', import.meta.url).pathname, 'publish', want, '--stack-on', String(stackOn)],
      { encoding: 'utf8' },
    )
    if (res.error) {
      showError(row, `stacking could not start (${res.error.code ?? 'spawn error'}): ${res.error.message}`)
      return
    }
    if (res.status !== 0) {
      // THE BASH MESSAGE IS THE DIAGNOSIS (not our guess): `classify_conflict`
      // and the `die`s are informative. The LAST lines are the substance — we
      // drop the header.
      const err = String(res.stderr ?? '').trim() || String(res.stdout ?? '').trim()
      const tail = err.split('\n').slice(-3).join(' · ')
      showError(row, `stacking did not finish: ${tail || `exit ${res.status}`} `
        + '— IF THERE WAS A REBASE CONFLICT, the worktree is left in a half-finished rebase: resolve it in the shell '
        + '(`git status`, then `tuipr publish --finish`) before moving on.')
      return
    }
    setNotice(`#${row.number}: stacked on top of #${stackOn}`)
    await reloadAsync()
    // THE `'s'` KEY FOR THE PENDING SIGNAL: this is how the legend/footer knows
    // which button is working (the user's request: "with pending UI").
  }, 's', row?.number), [reloadAsync, runExclusive, showError])

  // (wf31/73) AI-ASSISTED CONFLICT RESOLUTION FROM THE TUI — `v`.
  //
  // The user's request: "Not just analyze should go into the TUI, but the
  // resolution too, with pending UI. […] It should be possible to navigate the
  // app during resolve. There should be a confirmation before resolve."
  //
  // EXECUTION GOES THROUGH THE EXISTING BASH PATH (`tuipr resolve <PR>
  // --stack-on N --apply`), not a parallel JS implementation. That's where the
  // invariants that give it safety live — and a second chain would guaranteed
  // drift from them:
  //   · the DISPOSABLE WORKTREE (the rebase NEVER runs on the user's working tree),
  //   · RE-MEASURING the culprit (a stale diagnosis would resolve against the wrong PR),
  //   · the MARKER CHECK at the end (a measured fact, not the AI's claim).
  //
  // NAVIGABLE PENDING: `runExclusive`'s THIRD argument is the PR number, so the
  // running resolution shows up ON THE ROW, and the cursor can move elsewhere
  // meanwhile (the wf31/72 pattern). Resolution takes 1-3 minutes — this is
  // exactly the case navigable pending was built for.
  //
  // OUTPUT GOES TO THE NOTICE AND THE PANEL: bash writes the full analysis to
  // stdout (the functional relationship, the nature of the resolution,
  // per-file to-dos). We do NOT re-parse it here — the user reads the details
  // in the shell; the TUI signals the FACT (did it succeed, is a marker left),
  // because the panel isn't a log view.
  const doResolve = useCallback((row, stackOn) => runExclusive(async () => {
    const res = spawnSync(
      'bash',
      [
        new URL('tuipr.sh', import.meta.url).pathname,
        'resolve', String(row.number),
        '--stack-on', String(stackOn),
        '--apply',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    if (res.error) {
      showError(row, `resolution could not start (${res.error.code ?? 'spawn error'}): ${res.error.message}`)
      return
    }
    const out = `${String(res.stdout ?? '')}\n${String(res.stderr ?? '')}`
    if (res.status !== 0) {
      // THE BASH MESSAGE IS THE DIAGNOSIS (not our guess): the `die`s are informative.
      const tail = out.trim().split('\n').filter((l) => l.trim() !== '').slice(-3).join(' · ')
      showError(row, `resolution did not finish: ${tail || `exit ${res.status}`}`)
      return
    }
    // THE FACT OF A LEFTOVER MARKER COMES FROM BASH'S OUTPUT: it was MEASURED
    // there (grep), so the TUI doesn't re-measure, just reports. The
    // `needs-decision` case is the user's to handle.
    const leftover = /MARADT konfliktus-marker/.test(out)
    const clean = /TISZTÁN rebase-elhető/.test(out)
    setNotice(clean
      ? `#${row.number}: cleanly rebasable on top of #${stackOn} — nothing to resolve`
      : leftover
        ? `#${row.number}: resolution needs a HUMAN DECISION (marker left) — details in the shell`
        : `#${row.number}: resolved against culprit #${stackOn} (code is in the worktree; review it in the shell)`)
    // THE `'v'` KEY + THE ROW: the pending shows on the row, the cursor stays free meanwhile.
  }, 'v', row.number), [runExclusive, showError])

  // Merge calls the EXISTING non-interactive path (`tuipr merge <PR> --yes`).
  //
  // WHY NOT `gh pr merge` DIRECTLY (that was the earlier approach, and it was a bug):
  // landing has three steps that live ONLY in the bash cmd_merge —
  //   1) deriving the method from the branch prefix (non-conventional name → refusal),
  //   2) fresh verification of the REPO PERMISSION (allow_*_merge; gh's error message isn't verbose),
  //   3) the status gate (CONFLICTING / BEHIND rebase-gate / BLOCKED blocklist),
  //      plus the `--delete-branch` prefix convention.
  // Landing via a direct gh call from the TUI did something DIFFERENT than from the CLI: the
  // gate was bypassed, and deleting/keeping the ticket branch became random.
  // The `--yes` here is legitimate: the dwell-gated confirm overlay ALREADY confirmed it.
  // `runExclusive` here too (see doApprove): without try/finally, a throw
  // would PERMANENTLY stick `busy`.
  const doMerge = useCallback((row) => runExclusive(async () => {
    const res = spawnSync(
      'bash',
      [new URL('tuipr.sh', import.meta.url).pathname, 'merge', String(row.number), '--yes'],
      { encoding: 'utf8' },
    )
    // ENOENT separately (see doApprove): the bash/script being unlaunchable is a DIFFERENT
    // diagnosis than a merge refused by a gate.
    if (res.error) showError(row, `merge could not start (${res.error.code ?? 'spawn error'}): ${res.error.message}`)
    else if (res.status !== 0) showError(row, `merge error: ${(res.stderr || res.stdout || '').trim() || `exit ${res.status}`}`)
    else {
      setNotice(`#${row.number}: merged (${row.mergeMethod})`)
      // (wf31/25) OPTIMISTIC MARKING: the row switches to `✔ merged` IMMEDIATELY and dims,
      // we don't wait for GitHub's async indexing (see the `optimistic` state's doc head).
      setOptimistic((cur) => ({ ...cur, [row.number]: 'merged' }))
    }
    reload()
  }, 'm', row?.number), [reload, runExclusive, showError])

  useInput((input, key) => {
    // THE USER-INPUT CLOCK (the poll (c) gate) restarts on EVERY keypress —
    // EVEN BEFORE the `busy` early return.
    //
    // WHY HERE, ON THE VERY FIRST LINE: a key pressed during `busy` is ALSO USER PRESENCE.
    // If the clock only restarted on processed keypresses, then on the machine of an
    // impatient user mashing keys during a long action (merge), the poll could fall
    // idle — while the user is SITTING there. The gate measures PRESENCE, not
    // useful keypresses.
    //
    // WRITING A REF DOES NOT RENDER: stepping the clock is not a UI event, so it can't
    // cause a render either (otherwise every keypress would render twice).
    poll.current = pollNoteInput(poll.current, { now: now() })

    // (wf31/56) INPUT SNAPS THE FADE TO ITS END STATE — the user's requirement:
    // "on input, put animations into their end state".
    //
    // WHY AT THE VERY START, BEFORE THE `busy` GUARD: this isn't an action, it's the
    // CLOSING of the animation. A key pressed during `busy` also means the user is
    // LOOKING at the screen right now — leaving the fade halfway would flash the
    // transition color there.
    //
    // WHY THIS IS NEEDED AT ALL: the fade and the cursor movement write to the SAME
    // surface. If a `j` arrives mid-fade, two states race on the same row — the
    // "unpredictable" experience MEASURED at hunk-switching came from exactly this kind
    // of race (wf31/46-51). Snapping to the end state STRUCTURALLY rules this out:
    // at the moment of input, the animation no longer exists.
    //
    // THE CALL IS IDEMPOTENT (the setter is a no-op if already at the end state), so
    // it doesn't render needlessly on every keypress.
    finishFade()

    // UNDOING THE DOUBLE-`x` ARMING: ANY OTHER key (navigation too)
    // disarms it — the armed state can't get stuck. The functional setter is a no-op
    // if there's no arm (doesn't render needlessly).
    if (input !== 'x') setXArm((cur) => (cur === null ? cur : null))

    // THE SHARED HANDLER FOR DOUBLE-`x` — both the panel branch AND the list branch
    // call this, so the arming rule (first x: arms, second: executes, matched by kind)
    // doesn't live in two copies. RUNNING review: abort; DONE review: discard (deletes
    // the cached findings — the review TRACE remains, see the core
    // cacheDiscardAiFindings doc head); otherwise the old "nothing to abort".
    const xKey = (r) => {
      const pr = r ? r.number : null
      if (aiHandle.current) {
        if (xArm?.kind === 'abort') {
          setXArm(null)
          // The `'user'` value: THE ONLY PATH that produces the `aborted` end state
          // (exit produces `'exit'`, the watchdog produces `'timeout'`).
          stopAiReview('user')
          return
        }
        setXArm({ pr, kind: 'abort' })
        setNotice('x: confirm abort — one more x aborts the running AI review')
        return
      }
      const pending = pr === null ? null : cacheAiFindings(cache.current, pr)
      const lc = pr === null ? 'idle' : aiReviewLifecycle({ review: aiReview, pr, pending })
      if (lc === 'done') {
        if (xArm?.kind === 'discard' && xArm.pr === pr) {
          setXArm(null)
          cacheDiscardAiFindings(cache.current, pr)
          // (1d) FROM DISK TOO: the discard is the user's EXPLICIT decision (double `x`),
          // and a precondition for restarting via `r`. If it stayed on disk, the
          // findings would come back on the next start — the intentional
          // friction (against accidental double-spend) would silently drain away.
          forgetReview(pr)
          bumpCache()
          // After a discard, `r` again means STARTING — the state is cleared too.
          setAiReview((cur) => (cur && cur.pr === pr ? null : cur))
          // THE FACT + THE NEXT STEP, without internal concepts. The "review trace
          // remained" explained the cache's bookkeeping (the user doesn't work from that),
          // while `r` is REAL information: the review can be started again from here.
          setNotice(`#${pr}: review discarded — r: start a new review`)
          return
        }
        // Arming is BOUND TO THE PR: another row's arm doesn't execute here, but
        // re-arms for this row.
        setXArm({ pr, kind: 'discard' })
        // (wf31/12) THE TEXT WITHOUT REFERENCING THE CACHE. The user's finding was about
        // the exposed status line: the cache is an implementation detail that doesn't
        // need spelling out. What matters to the user: WHAT HAPPENS on the second `x`.
        setNotice(`#${pr}: one more x discards the review`)
        return
      }
      // NO RUNNING REVIEW AND NO DISCARDABLE RESULT: `x` isn't a dead key,
      // it SAYS OUT LOUD that there's nothing to abort (the old contract).
      setXArm(null)
      setNotice('no running AI review to abort')
    }

    // THE TWO GUARDS TOGETHER, and BOTH are needed:
    //
    //   `actionLock.current` — the SYNCHRONOUS, RENDER-INDEPENDENT truth. This is what
    //     stays valid EVEN DURING SUSPEND: Ink DROPS renders at that point
    //     (ink.js `onRender`: early return on `isSuspended`), so the `busy` below
    //     in the closure carries the value from BEFORE SUSPEND. Without this, an
    //     `r`/`d` pressed during `d` RAN, the second `suspendTerminal` THREW
    //     ("The terminal is already suspended"), and `busy` got stuck.
    //   `busy` — the DISPLAYED state. We keep it: there's a tick between releasing the
    //     lock and the busy render, and in that gap `busy` is the correct
    //     answer (the UI still looks blocked).
    // (wf31/72) NAVIGATION PASSES THROUGH THE PENDING GUARD — the user's request.
    //
    // WHY THIS IS SAFE, EVEN THOUGH THE GUARD WAS BORN FROM A MEASURED BUG: the original reason
    // was to prevent a SECOND ACTION from starting alongside the running one (`suspendTerminal`
    // threw, `busy` got stuck). Cursor movement, however, is NOT an action: it doesn't start a
    // process, doesn't touch github, doesn't use the terminal — it only steps
    // `selectable`'s index. The dangerous set stays closed, unchanged.
    //
    // ESC ALSO PASSES THROUGH: closing the panel is likewise a state change, not an action.
    const navKeyOnly = input === 'j' || input === 'k'
      || key.downArrow || key.upArrow || key.escape
    if ((actionLock.current || busy) && !navKeyOnly) return

    // Confirmation mode: only y/n make sense.
    //
    // 'y' goes through confirmAccepts's TYPEAHEAD GATE, not directly. Reason: a 'y'
    // pressed during askAiReview's blocking gh call (~1s) sits in Ink's raw-mode
    // buffer, and lands AFTER the confirm screen mounts — i.e. it would launch the
    // token-spending `claude -p` WITHOUT the confirmation screen being READ. The
    // `busy` guard structurally cannot catch this (setBusy(true/false)
    // runs in the same synchronous block, so it never renders a busy state).
    // Closing the ERROR OVERLAY comes BEFORE ANYTHING ELSE. Reason: while an error is on
    // screen, other keys ('y' too!) must not be live — otherwise a buffered/blindly
    // pressed key would start a DIFFERENT action on the PR whose operation just
    // failed. ANY key closes it (Esc/q too): acknowledging it is free, and
    // an "I don't know which key gets me out" state is worse than closing
    // early. The error text stays on the status line.
    if (errorState) {
      setErrorState(null)
      return
    }

    // === THE PANEL'S MODAL MODE: A PENDING DECISION ===============================
    //
    // The user's 2nd principle: in a modal, up/down step the SELECTION, NOT the list. Here
    // `d`/`r`/`a`/`m` are DELIBERATELY not live (panelKeys says so): a
    // buffered or mistyped key over the decision would start a DIFFERENT irreversible
    // action on the same PR.
    if (modal) {
      const confirm = modal
      // Switching the REVIEW PATH (Tab) is NEITHER a confirmation NOR an abort: the screen
      // stays open, and we do NOT zero out armedAt either — the dwell measures how long
      // the screen has been in front of the user's eyes, and switching the path is
      // exactly what proves the user is reading it. (Re-arming here would make the gate
      // bypassable in the opposite direction by mashing Tab: every switch would restart the 250 ms.)
      // The user's request: switch paths with the ARROW, not Tab. Tab STAYS
      // as an alternative (for muscle memory), but the footer advertises the arrow.
      //
      // All three keys live on ONE branch, deliberately: on separate branches the wrap
      // rule and the armedAt handling could drift apart (one arms, the other doesn't — and
      // the dwell gate is exactly what would become bypassable this way). The stepping goes
      // through the TESTED stepIndex, not an inline module.
      //
      // 'b' (ceiling on/off) is on this SAME branch, for the same reason: this too is not
      // a confirmation and not an abort, so it must NOT touch armedAt. If it armed,
      // pressing the ceiling toggle would restart the 250 ms gate indefinitely
      // — the protection would become bypassable via the very path we just added.
      if (confirm.kind === 'ai-review' && input === 'b' && confirm.budget) {
        patchModal({ budget: budgetToggle(confirm.budget) })
        return
      }
      // (5b) `m` IS THE MODEL SWITCHER — WHY `m`, AND WHY CYCLIC:
      //   - in confirmation mode `m` is a FREE key: merge's `m` lives on the LIST
      //     and on the INLINE panel, it never reaches here (per panelKeys) — and the
      //     mnemonic (model) fits exactly;
      //   - direct keys (`o`/`s`/`f`) were rejected: `f` is the advertised
      //     key for upload (two meanings on one letter confuses), and burning three keys
      //     on a three-item choice is disproportionate — a Tab-style
      //     cyclic switcher (like the review path) solves it with one key;
      //   - `armedAt` is NOT touched (same argument as the 'b'/Tab
      //     branch: the switcher must not re-arm the dwell gate).
      if (confirm.kind === 'ai-review' && input === 'm' && confirm.model) {
        patchModal({ model: modelStep(confirm.model, +1) })
        return
      }
      // (5) SWITCHING THE REVIEW PATH WITHOUT ARROWS (user: "it bothers me that I have to
      // use left/right arrows"; `R` can't be used — that's refresh):
      //   - Tab: CYCLIC switcher. Why Tab: it already worked (muscle memory),
      //     a single key, and doesn't collide with the modal's up/down choice list;
      //   - 1..N: DIRECT, deterministic selection (advertised by the legend).
      // The ARROW stays for the BUDGET step, when the ceiling is turned on — this way
      // neither feature silently shares a key with the other. With the ceiling off, the
      // arrow does NOT close the modal (that would be a decision discarded by a random
      // gesture), but instead states the new path out loud.
      // NEITHER branch touches `armedAt`: the switcher must not re-arm the
      // dwell gate (existing invariant, guarded by a test).
      if (confirm.kind === 'ai-review' && (key.leftArrow || key.rightArrow)) {
        if (confirm.budget?.enabled === true) {
          patchModal({ budget: budgetStep(confirm.budget, key.leftArrow ? -1 : +1) })
          return
        }
        setNotice('the review path is chosen by Tab (switch) or 1/2 (direct) — not the arrow')
        return
      }
      if (confirm.kind === 'ai-review' && key.tab && Array.isArray(confirm.paths)) {
        patchModal({ pathIndex: stepIndex(confirm.pathIndex, confirm.paths.length, +1) })
        return
      }
      if (confirm.kind === 'ai-review' && Array.isArray(confirm.paths) && /^[1-9]$/.test(input)) {
        const idx = Number(input) - 1
        if (idx < confirm.paths.length) {
          patchModal({ pathIndex: idx })
          return
        }
        // A number out of range does NOT close the modal (not an abort intent).
        setNotice(`only ${confirm.paths.length} review path(s) — 1..${confirm.paths.length}`)
        return
      }
      // STEPPING THE ARROW-BASED CHOICE (the user's 2nd principle). Up/down here NEVER
      // moves the list: moving the cursor is a weapon under a pending, irreversible
      // decision (the same risk why the background poll doesn't reload
      // on its own either).
      //
      // We do NOT touch `armedAt`: stepping is not a confirmation and not an
      // abort, so it doesn't restart the dwell gate (same argument as the
      // 'b'/Tab branch — re-arming via arrow-mashing would make it bypassable).
      // `modalHasChoices` is the SHARED source with the footer and the body: where
      // there's no list, the arrow does NOT steal a key (and we don't advertise it — it
      // would be a dead key).
      // (wf31/69) LEFT/RIGHT ALSO STEP — the user's request, and the display
      // direction calls for it (`▸ No   Yes` on one line). Up/down STAYS: we don't
      // break the earlier muscle memory, only the advertisement switches to horizontal.
      // THE STEP DIRECTION matches the picture: right/down = forward, left/up = back.
      if ((key.downArrow || key.upArrow || key.leftArrow || key.rightArrow)
        && modalHasChoices(confirm.kind)) {
        setChoiceIndex((i) => modalChoiceStep(i, key.downArrow || key.rightArrow ? +1 : -1))
        return
      }
      // ENTER executes the SELECTED branch — BUT NOT ON ITS OWN PATH.
      //
      // It closes on 'NO' (no effect), and that's the OPENING state: an Enter pressed
      // blindly NEVER starts anything. On 'YES' we NORMALIZE it to `y`, and from
      // there the EXISTING 'y' path runs.
      //
      // WHY NORMALIZE AND WHY NOT A SEPARATE BRANCH: a standalone Enter branch would
      // BYPASS the dwell gate if the `confirmAccepts` call were ever missing from it — i.e.
      // introducing arrow-based choice would open a BYPASS to the most expensive
      // (token-spending, or GitHub-posting) actions. This way the gate call and the
      // "too early" signal also live in ONE place, and the source-invariant tests
      // (verify-silent) see a single accepting point.
      let effective = input
      if (key.return) {
        if (MODAL_CHOICES[choiceIndex]?.id !== 'yes') {
          // (wf28/1) The old `restoreAiPrevDone()` call was REMOVED. It was doubly
          // dead: the `kind === 'ai-review'` modal NO LONGER OPENS (see
          // the launcher branch's doc head below), and the save-restore mechanism
          // itself was also discontinued (opening the menu no longer writes `aiReview` state).
          setPanel(panelToInline)
          setNotice('cancelled')
          return
        }
        effective = 'y'
      }
      if (confirmAccepts(confirm, effective) && confirm.blockers.length === 0) {
        const { kind } = confirm
        const row = panel.row
        // BACK TO THE PANEL, not the list: the measured diagnosis stays there, so after
        // the action the user sees the same picture they decided from.
        setPanel(panelToInline)
        if (kind === 'approve') doApprove(row)
        if (kind === 'merge') doMerge(row)
        // (wf31/73) STARTING CONFLICT RESOLUTION — ONLY FROM HERE, after confirmation.
        //
        // THE TARGET COMES FROM THE MODAL (`resolveModalProps` put it there), NOT from a
        // `stackOffer` computed at render time: between opening the modal and pressing `y`
        // the user could have navigated, and the measurement could have completed — a
        // target re-read at render time could start the resolution on a DIFFERENT PR than
        // the one the question named. The value locked into the modal structurally rules
        // this out.
        if (kind === 'resolve' && Number.isInteger(confirm.stackOn)) doResolve(row, confirm.stackOn)
        // The upload that POSTS to GitHub also starts ONLY from here (see the 'f' branch).
        if (kind === 'upload') doUpload(row)
        // (2) THE `ai-review` BRANCH REMOVED FROM HERE. The token-spending path now
        // starts on the REVIEW-CASCADE MENU's `y` branch (see useInput's menu branch), with
        // its own dwell-gate call — the verbose confirmation modal was discontinued, so this
        // branch was DEAD CODE (the `kind === 'ai-review'` modal no longer opens).
        //
        // WHY I DELETED IT, AND DIDN'T LEAVE IT THERE "just in case": an unreachable
        // launcher branch for the most expensive action is exactly the place where a later
        // change can SILENTLY open a bypass — and the source-invariant tests also
        // counted this branch as the proof of "one accepting point". THE OBLIGATION
        // REMAINS, it just moved to ONE place: every action has EXACTLY ONE
        // dwell-gate-protected launch path.
        return
      }
      // A too-early 'y' is NOT treated as an abort: the screen stays open, and
      // a SHORT line signals to press it again. If we closed it here, the user would
      // think it aborted, and would start the whole thing over again.
      //
      // WHY THERE'S NO LONGER EXPLANATION HERE: the mechanism's rationale (Ink
      // raw-mode buffer, typeahead) is of interest to the developer, not the user — that
      // lives in the code comments (above + core/confirmAccepts). The user's complaint
      // was exactly that this prose was incomprehensible in the UI.
      // `effective` (not the raw `input`): the NORMALIZED Enter-yes also falls
      // here if the dwell hasn't elapsed yet — without this the Enter path would fall
      // through to the "any other key" branch, i.e. it would SILENTLY CLOSE the modal, and
      // the user would think it aborted. This is exactly the reverse of the rationale
      // above, on the same signal.
      if (effective === 'y') {
        setNotice('too early — press again')
        return
      }
      // ANY OTHER KEY (Esc and q too): the MODAL closes, the TUI does NOT exit.
      // Aborting is never delayed (see the dwell's asymmetry): it's free,
      // so a buffered keypress can also perform it — that's the fail-closed direction.
      // 'q'/Esc here is deliberately NOT exit: with an overlay open the exit branch is
      // unreachable (this is guarded by a branch-order test).
      //
      // CLOSING GOES BACK TO THE PANEL (`panelToInline`), not the list — this is the
      // essence of the consolidation: the "look → act → change my mind →
      // look again" loop closes WITHIN the panel, and the measured diagnosis isn't lost
      // over a change-my-mind gesture.
      // (wf28/1) The old `restoreAiPrevDone()` call was REMOVED — same two reasons
      // as on the Enter-normalization branch: the `ai-review` modal no longer opens, and
      // the save-restore mechanism was discontinued.
      setPanel(panelToInline)
      setNotice('cancelled')
      return
    }

    // === THE PANEL'S INLINE MODE: info + measurement + THE NEXT STEPS ===========
    //
    // THIS IS THE ESSENCE OF THE CONSOLIDATION. In the old code, `d`/`r`/`a`/`m` here fell
    // through to the "any other key" branch: it SILENTLY closed the panel, and started
    // nothing — the user had to step out to be able to act ("look → step back →
    // act" loop). Now the four actions live WITHIN the panel, with the same
    // gates and confirmations as from the list.
    //
    // Esc/q ABORTS a RUNNING measurement and closes; the partial result is signaled by the
    // status line ("measurement aborted at 3/7 candidates"). j/k also NAVIGATES within
    // the panel — switches to the neighboring row and restarts the measurement there. This is
    // the concrete shape of the "don't block the UI" requirement: you can still move
    // during a measurement, and the old measurement's result doesn't leak through (the
    // stale protection binds the answer to the row number).
    // === (2) THE REVIEW-CASCADE MENU: `r`'s SUB-OPTIONS ==========================
    //
    // THE MENU BRANCH STANDS BEFORE THE PANEL BRANCH, and this is load-bearing: the menu lives
    // in the panel's INLINE mode, so `panel` is true — if the panel branch ran first, the
    // menu's keys (`tab`/`m`/`b`/`y`) would fall onto the panel's own branches. Concretely: `m`
    // would open the MERGE CONFIRMATION instead of the model switch, and `y` would fall
    // through to the "any other key" branch and SILENTLY CLOSE the panel. The precedence is
    // therefore not style: it's the menu's being OPEN that takes over the key set.
    //
    // THE OTHER THREE CONFIRMATIONS (approve/merge/upload) ARE UNAFFECTED: those run on the
    // `modal` branch, which comes EVEN EARLIER (`modal` comes from `panel.mode`).
    // The menu and the modal can never be open at the same time: only the inline panel's `r`
    // opens the menu, and the modal-opening branches (`a`/`m`/`f`) don't live under the menu.
    if (reviewMenu) {
      const menu = reviewMenu
      // THE PR BOUND TO THE MENU'S ROW. If the panel meanwhile landed on a DIFFERENT row
      // (poll, reload, a race), the menu is STALE: we close it, and start NOTHING.
      // FAIL-CLOSED, the same principle as the measurement callbacks' `row.number !== pr`
      // guard — a menu not bound to a row would spend tokens on a DIFFERENT PR.
      const mrow = panel && panel.row?.number === menu.pr ? panel.row : null
      if (mrow === null) {
        setReviewMenu(null)
        setNotice('the review menu\'s row moved — the menu closed, press `r` again')
        return
      }
      // `esc`: CLOSES on the FIRST step, STEPS BACK on the SECOND (the user: "Esc: back").
      // `q` ALSO closes — with the menu open the exit branch is unreachable, the same
      // contract as the modal (`q` doesn't exit the TUI there either).
      if (key.escape || input === 'q') {
        const back = reviewMenuBack(menu)
        setReviewMenu(back === null ? null : { ...menu, ...back })
        // (wf31/2) THE "cancelled" STATUS SIGNAL REMOVED. THE USER'S FINDING, verbatim:
        // "I'm poking r and esc back and forth in the info box, and
        // »cancelled« is at the bottom of the screen. Then 'r' again, then
        // »working...«, then it goes back to »cancelled«. Pretty
        // inconsistent."
        //
        // THE BUG CLASS: "cancelled" ASSERTS that a RUNNING PIECE OF WORK
        // was interrupted. But opening and dismissing the menu started NOTHING
        // (the token-spending path starts on the `y` branch) — there is nothing to abort.
        // This is the same LYING-SIGNAL class as the #904 collector-branch
        // "cancelled": the text states an event that didn't happen.
        //
        // AND THE HARM ISN'T JUST INACCURACY: the status line STICKS (it stays there
        // until the next real signal), so after a static UI switch the user
        // keeps seeing a false "cancelled" at the bottom of the screen the whole time — exactly the
        // inconsistency they reported.
        //
        // OPENING/CLOSING THE MENU IS THEREFORE SILENT: `Esc` simply steps back. The
        // gesture's result is visible ON THE SCREEN ITSELF (the menu disappears) — a
        // status line can't add anything, only confuse.
        //
        // WHAT'S UNCHANGED: REAL aborts STILL signal (the running
        // AI review's `x`, the measurement's Esc with the `measurement aborted at N/M candidates`
        // text) — there the signal is TRUE, because something actually ran.
        return
      }
      // THE CYCLIC SWITCHERS. NONE of them touch `armedAt` — `reviewMenuStep`
      // guards this mechanically (under test), so the dwell gate can't be re-armed here.
      if (key.tab) { setReviewMenu(reviewMenuStep(menu, 'path', +1)); return }
      if (input === 'm') { setReviewMenu(reviewMenuStep(menu, 'model', +1)); return }
      if (input === 'b') { setReviewMenu(reviewMenuStep(menu, 'budget', +1)); return }
      // `r` CLOSES THE MENU (toggle): the advertised key stays in place, so a
      // second press MUST produce a change — without this the user wouldn't know whether the
      // key doesn't work, or the UI froze.
      if (input === 'r') {
        // (wf28/1) THE TOGGLE-CLOSE ALSO DOESN'T CLEAN UP STATE: opening didn't write
        // `aiReview` state (the old `restoreAiPrevDone()` call was removed).
        setReviewMenu(reviewMenuToggle(menu))
        return
      }
      // `y`: THROUGH THE DWELL GATE. The gate is UNCHANGED, the core `confirmAccepts` —
      // we did NOT write a second accepting point for it, because the source-invariant tests
      // (verify-silent) see a single accepting point, and a standalone branch
      // could BYPASS the gate if the call were ever missing from it.
      //
      // THE GATE LIVES ON THE FIRST `y` (the user's obligation). The second step carries the
      // same `armedAt`, so there the gate has ALREADY PASSED — it doesn't ask for a new 250 ms.
      if (input === 'y') {
        if (!confirmAccepts({ armedAt: menu.armedAt }, 'y')) {
          // A too-early `y` is NOT an abort: the menu stays open, and a SHORT
          // line signals to press it again. If we closed it here, the user would think
          // it aborted, and would start the whole thing over again.
          setNotice('too early — press again')
          return
        }
        // (wf28/1) A SECOND LINE OF DEFENSE FOR THE MEASUREMENT THAT HASN'T ARRIVED YET — AND WHICH
        // IS THE FIRST LINE, MEASURED. The menu now opens BEFORE the blocking `fetchPrFiles`
        // (so on a live PR the gh call's ~1 second doesn't have to be waited out without
        // feedback), so `size` is `null` for a while.
        //
        // A MEASURED FACT THAT MUST NOT BE HUSHED UP: this branch CANNOT BE REACHED
        // via the keyboard EVEN BY EFFORT. `askAiReview` runs under `runExclusive`'s
        // LOCK, and doesn't release it until the measurement ENDS (no early `release`), while
        // `useInput`'s very first guard (`if (actionLock.current || busy)
        // return`) DROPS EVERY keypress. The `size: null` window therefore exactly
        // coincides with the time during which no key even reaches here. MEASURED: a
        // test written with a slowed-down gh (`slowPrFilesSec`) could NOT trigger the
        // signal — so there is NO test for it, and we STATE this here rather than let a
        // false-green test prove it.
        //
        // SO WHY IS IT HERE: because the harm it guards against is SILENT and EXPENSIVE. If the
        // lock guard ever loosens (early `release`, or the menu branch moving ahead of `busy`),
        // `reviewMenuWarning({})` would see `large:false`, produce a `null` warning,
        // and `reviewMenuAdvance` would go STRAIGHT to `run` — on a 45-file
        // PR the large-PR warning would SILENTLY BE SKIPPED, and token spending would
        // start WITHOUT the SECOND step's friction. The ABSENCE of the measurement must not
        // be allowed to mean "nothing to warn about"; this branch nails that down at the
        // TYPE level (`null` ≠ "small PR"), instead of relying on the
        // lock.
        if (menu.size === null || menu.size === undefined) {
          setNotice('measuring the PR size is still in progress — press y again')
          return
        }
        // THE WARNING comes from the MEASURED size, AT THE MOMENT of `y` — not from
        // (potentially stale) text stored in state. The threshold decision (`large`) came from the
        // core `aiReviewSummary`, the condensing from `reviewMenuWarning`.
        const warning = reviewMenuWarning(menu.size)
        const step = reviewMenuAdvance(menu, { warning })
        if (step.action === 'advance') {
          // SECOND STEP: the warning + `y`/`esc`. Nothing starts.
          setReviewMenu({ ...menu, ...step.state })
          return
        }
        if (step.action !== 'run') return
        // START. The menu CLOSES, and the parameters SEEN IN THE MENU carry over —
        // `reviewMenuSelection` from ONE source, so the displayed and the live
        // parameter can't drift apart (the measured finding that gave rise to the model
        // switcher: the user lost their entire budget on a Fable run).
        const sel = reviewMenuSelection(menu)
        setReviewMenu(null)
        doAiReview(mrow, sel.maxBudgetUsd, sel.reviewPath, sel.model)
        return
      }
      // ANY OTHER KEY: the MENU STAYS OPEN, and the status line states what's active.
      //
      // WHY IT DOESN'T CLOSE (unlike the panel's "any other key" branch): the menu is a
      // PENDING, token-spending decision, and `j`/`k`/`d`/`a`/`f` here are DELIBERATELY
      // not live — the same argument as why the modal's `panelKeys` didn't let them
      // through either: a buffered or mistyped key over the decision would start a
      // DIFFERENT action on the same PR. Silent closing, on the other hand, is exactly the
      // "did it abort?" uncertainty that we also rule out on the too-early-`y` branch.
      setNotice('in the review menu, tab/m/b switches, `y` starts, `esc` steps back')
      return
    }

    if (panel) {
      const prow = panel.row
      if (key.escape || input === 'q') {
        const wasRunning = panel.progress?.running === true
        stopDiagnosis()
        // We state the ABORTED measurement's PARTIAL result on the status line: a
        // silent close would give the impression that the measurement ran to completion.
        // THE TEXT comes from progressLabel, it isn't rebuilt here: from two sources the
        // panel and the status line could have drifted apart (the "at 0/0 candidates" lying
        // form would also have only been fixed in one place).
        if (wasRunning) setNotice(`#${prow.number}: ${progressLabel(progressAbort(panel.progress))}`)
        setPanel(panelClose)
        return
      }
      if (input === 'j' || key.downArrow || input === 'k' || key.upArrow) {
        const delta = (input === 'j' || key.downArrow) ? 1 : -1
        const next = Math.min(selectable.length - 1, Math.max(0, index + delta))
        if (next !== index) {
          setIndex(next)
          openInfo(selectable[next])
        }
        return
      }
      // THE FOUR ACTIONS WITHIN THE PANEL. They call the same helpers as
      // from the list — NOT copied branches: a duplicated gate (e.g. skipping
      // canApproveRow here) would SILENTLY let a forbidden approve through.
      //
      // STOPPING THE MEASUREMENT on the ACTION branches: `d` takes over the terminal (hunk), while
      // `r` and the modal perform blocking I/O. A merge-tree probe running in the background
      // under these would either be left behind as a zombie, or write into an already-replaced
      // panel state. `stopDiagnosis` rules out both.
      // (wf31/6) `d` IS ALSO THE OPENER FOR A COMPLETED REVIEW — INSTEAD OF `r`.
      //
      // THE USER'S FINDING, verbatim: "when a review has arrived, don't let 'r' open
      // the review, let 'd' do it. In the hunk you can hide the notes anyway,
      // so it makes a lot more sense."
      //
      // WHY IT'S BETTER, AND WHY NOTHING IS LOST: `d` ALWAYS opens the diff view —
      // the presence of findings doesn't CHANGE this, it only ENRICHES it
      // (`--agent-notes`). The "I just want the diff" need is also satisfied, because the
      // hunk itself can hide the notes. This gives `r` back its
      // SINGLE meaning: "I'm STARTING a review" — in the earlier form the same
      // key STARTED or OPENED depending on the lifecycle, which conflated two opposite
      // cost-profile operations (free vs. token-spending).
      if (input === 'd') {
        stopDiagnosis()
        void openReview(prow, { agentNotes: hasAnyFindings(prow.number) })
        return
      }
      // (wf31/72) NO COMMANDS ON THE PENDING ROW — the user's requirement: "the pending PR's
      // info panel should stay pending (accept no commands)".
      //
      // NAVIGATION (`j`/`k`) AND CLOSING (`Esc`/`⏎`) STAND ABOVE this branch,
      // so those work — only the ACTIONS drop out. The panel can still be paged
      // during a running approve, but nothing can be started on the row it's left behind on.
      //
      // THE CONDITION LOOKS AT THE ROW, NOT THE GLOBAL `busy`: standing on a DIFFERENT PR the
      // commands work (`runExclusive`'s lock only allows one action at a time anyway).
      if (pendingPr !== null && prow?.number === pendingPr) return
      // (wf31/10) `c` STARTS THE CONFLICT MEASUREMENT — opening the panel no longer measures.
      // `stopDiagnosis` is NOT needed here: `measureConflict` itself closes off the
      // running measurement (one measurement runs at a time), and also handles the cache hit.
      if (input === 'c') { measureConflict(prow); return }
      // `r` ONLY STARTS (or loudly signals why not) — see `rKeyAction`.
      if (input === 'r') { stopDiagnosis(); rKeyAction(prow); return }
      if (input === 'a') { openModal(prow, approveModalProps(prow)); return }
      if (input === 'm') { openModal(prow, mergeModalProps(prow)); return }
      if (input === 'f') { openModal(prow, { kind: 'upload', blockers: [] }); return }
      // (wf31/53) `s` IS STACKING — LIVE ONLY WHEN THE MEASUREMENT PRODUCED AN OFFER.
      //
      // The source is the SAME one the footer advertises from (`stackOffer`), so the key and the
      // label can't drift apart — this is the project's MEASURED bug class (advertised but
      // dead button). Without an offer the press does NOT fall through to the "any other key" branch
      // (that would close the panel), but is SILENTLY swallowed: `panelKeys` marks `s` as
      // live, so the panel considers it its own.
      if (input === 's') {
        if (stackOffer !== null) doStack(prow, stackOffer)
        return
      }
      // (wf31/73) `v` IS CONFLICT RESOLUTION — AFTER CONFIRMATION.
      //
      // The source is the SAME one the body advertises from (`stackOffer` → the measured, SOLE
      // culprit), so the advertisement and the key can't drift apart. Without an offer
      // the press is SILENTLY swallowed (`panelKeys` marks it live, so the panel considers it
      // its own — it doesn't fall through to the closing "any other key" branch).
      //
      // A MODAL, NOT A DIRECT LAUNCH: resolution calls AI (tokens) AND writes code —
      // the same gate as before approve/merge (the user's request: "before Resolve
      // there should be a confirmation").
      if (input === 'v') {
        if (stackOffer !== null) openModal(prow, resolveModalProps(prow, stackOffer))
        return
      }
      // `x` (abort / discard, via DOUBLE press) also lives on the OPEN PANEL
      // — the progress line (and with it the advertised `x`) lives in the panel, so
      // the key must work where we advertise it. Without this, `x` would fall through to
      // the "any other key" branch, and would close the panel instead of the review (measured).
      if (input === 'x') { xKey(prow); return }
      // (wf31/30) ENTER CLOSES THE PANEL — A TOGGLE. The user's request: "Info panel:
      // Enter should also close it (i.e. Enter alone should behave as a toggle).
      // Esc can still close it too, but Enter should also be in the info legend".
      //
      // WHY THIS IS RIGHT (the earlier "drill in" argument revisited): ON THE LIST, Enter
      // OPENS the panel, so the same key for CLOSING is the least learning
      // burden — one key, one concept ("details on/off"). The earlier form (Enter
      // = caveat toggle) required the user to keep TWO meanings in mind
      // for the same key, depending on where they were standing.
      //
      // THE KEY BECAME FREE precisely because the caveat toggle WAS DISCONTINUED: the
      // measurement details are now always visible (two states: has measurement / doesn't).
      //
      // THE BRANCH IS EXPLICIT, not left to the "any other key" below: `panelKeys`
      // advertises `'return'`, and an advertised key's handler should also be visible
      // — otherwise the next reader won't find what happens on Enter.
      if (key.return) {
        stopDiagnosis()
        setPanel(panelClose)
        return
      }
      // ANY OTHER key: closes. The running measurement is killed here too — without the
      // panel there's nowhere to insert the result.
      stopDiagnosis()
      setPanel(panelClose)
      return
    }

    // 'x' = ABORTING THE RUNNING BACKGROUND REVIEW (#904).
    //
    // WHY A VISIBLE ABORT PATH IS NEEDED: the user waited 5 minutes, and DIDN'T KNOW
    // whether they could stop it. `q` would indeed have killed it, but that also closes the TUI —
    // there was NO path for the "I just want to stop the review, I'll stay on the list" gesture.
    //
    // WHY `x` AND NOT Escape: today Escape on the list is EXIT (see below), and the
    // two meanings (abort vs. exit) would collapse onto the same key. `x` is
    // ADVERTISED AT THE END of the PANEL's progress line (aiReviewPanelLines), so the
    // user sees it exactly where the waiting happens.
    if (input === 'x') {
      // The shared double-press handler (xKey): abort on a running review, discard on a
      // completed review — the first `x` only ARMS on either path. The `'user'`
      // reason semantics (aborted vs. killed-by-exit vs. timeout) live in xKey.
      xKey(current ?? null)
      return
    }

    // EXITING closes BOTH background children: the merge-tree probe AND the
    // background review's claude. Without this, after `q` a running `claude -p` would write into
    // a hunk session that nobody is reviewing anymore.
    //
    // WARN AHEAD OF TIME (#904) — THE KILL IS UNAVOIDABLE, SO WE SAY SO.
    //
    // `claude -p` WRITES into the hunk session, so it CANNOT be detached (the lying-
    // provenance rationale is at `stopAiReview`'s doc head). Exiting therefore KILLS the
    // running review — and in the #904 user's case this was the most likely real
    // ending: the review had died hours earlier, and the user only saw the text in the
    // full redraw after resume. If the kill is unavoidable, then at least
    // ask AT THE MOMENT OF EXIT — telling them afterward is too late.
    // THE CONFIRMATION STATE DECIDES BEFORE any other key: while the
    // question is open, the list's keys are NOT live (otherwise a `j` would silently
    // swallow the question, and the user would think they'd exited).
    if (exitConfirm) {
      // ONLY 'y' (and capital 'Y') exits. The fail-closed direction is STAYING: a
      // buffered keypress shouldn't take the running review down with it.
      if (input === 'y' || input === 'Y') {
        stopDiagnosis()
        // The `'exit'` reason: the `killed-by-exit` end state comes from this. (The TUI does
        // tear down, so we no longer see the text here — but its PLACE is in the
        // state machine, and the core `reason` is a MEASURED fact.)
        stopAiReview('exit')
        exit()
        return
      }
      setExitConfirm(null)
      // (wf31/9) ONE REASON, ONE PIECE OF FEEDBACK: the question can now only
      // appear because of the running review (the pending branch was removed), so branching on
      // `kind` was also discontinued. A retained ternary here would be a DEAD BRANCH — and the next
      // reader would think the pending path still lives.
      setNotice('exit cancelled — the AI review keeps running')
      return
    }
    if (input === 'q' || key.escape) {
      if (aiHandle.current) {
        // (wf31/9) THE `kind` FIELD REMOVED: the question now has only ONE reason (a running
        // review), so a distinguishing field would be dead information — it would
        // suggest to the next reader that more than one branch is live. So the state is a plain
        // `true`: "is there an open exit question" is the ONLY fact it carries.
        setExitConfirm(true)
        return
      }
      // (wf31/9) NO EXIT QUESTION FOR UNLOADED FINDINGS.
      //
      // THE USER'S DECISION, verbatim: "This prompt is NOT needed. The cache should stay an
      // automatic default, the user doesn't need to be informed about this."
      //
      // WHY THIS IS RIGHT (and why the old question was wrong): the guard is left over from the
      // memory-only-cache era, when exiting ACTUALLY discarded
      // paid-for findings — there the question prevented real data loss. Since the
      // disk cache (review-store), the findings live in `/tmp`, and
      // startup reads them back. The guard therefore no longer prevented data loss,
      // it only informed about how the CACHE WORKS — an implementation
      // detail that isn't a decision for the user. A question whose answer is
      // practically always `y` isn't friction, it's just annoyance.
      //
      // WHAT REMAINS: the RUNNING review's exit guard (above, `kind: 'running'`).
      // That's a DIFFERENT bug class — there exiting interrupts an IN-PROGRESS,
      // token-spending run, so a real, irreversible loss is at stake.
      stopDiagnosis()
      stopAiReview('exit')
      exit()
      return
    }
    if (input === 'j' || key.downArrow) { setIndex((i) => Math.min(selectable.length - 1, i + 1)); return }
    if (input === 'k' || key.upArrow) { setIndex((i) => Math.max(0, i - 1)); return }
    // 'R' = GLOBAL REFRESH + FULL cache invalidation.
    //
    // CAPITAL 'R' is free because AI review moved to lowercase 'r'. THE TWO
    // FUNCTIONS SEPARATED: refresh updates the PICTURE (queue + main SHA +
    // cache drop), AI review spends tokens — the old lowercase-r/capital-R pair (hunk vs.
    // AI) was typographically too close for a typo not to cost
    // money.
    //
    // CAN THE REFRESH ALSO PRESERVE THE ROW SELECTION? We DON'T guarantee it: the queue's
    // contents may have changed (a PR landed), and a preserved index would point at a
    // DIFFERENT row than the one the user was looking at. Clamping the index (see below) is
    // the fail-safe; reordering the cursor is justified by the refresh itself being an
    // EXPLICIT user gesture — which is exactly why the background poll doesn't do this on
    // its own.
    if (input === 'R') {
      // The OPEN MEASUREMENT must be stopped: after the post-refresh cache drop, the
      // arriving result has nowhere to slot in (and its anchor is also stale).
      stopDiagnosis()
      setPanel(panelClose)
      // (wf31/26) `R` ALSO GETS A PENDING SIGNAL (`R: refresh (running…)`) — the user's
      // request: "Global »R: refresh« has no pending indicator, it should".
      //
      // WHY I DIDN'T PUT THIS INTO `runExclusive` (which provides `busy` and the signal
      // together): `reload` is NOT an exclusive action — it's called by the soft reload after
      // `d`, by the poll, and by the refresh after merge/approve. If `R` held the lock,
      // an `R` pressed during a background reload would SILENTLY die (`runExclusive`'s first
      // guard returns with `false`). So we set the signal DIRECTLY, without
      // the lock.
      //
      // `setTimeout(0)` IS LOAD-BEARING, the same bug class we already measured at
      // `runExclusive`'s doc head: `reload` runs SYNCHRONOUS spawnSyncs
      // (measured at ~2.5 s), so `setBusy(true)` and the `finally`'s
      // `setBusy(false)` would run in the SAME synchronous block — React would never
      // get to a render flush, and the signal would NEVER APPEAR. The tick lets the
      // tree render BEFORE the blocking calls start.
      //
      // `finally` IS AN OBLIGATION: if `reload` throws (non-git cwd, gh error), the signal
      // WOULD STICK — the legend would show `(running…)` forever for an action that isn't running.
      setBusy(true)
      setPendingKey('R')
      setTimeout(() => {
        try {
          reload({ hard: true })
        } finally {
          setBusy(false)
          setPendingKey(null)
        }
      }, 0)
      return
    }
    if (!current) return

    // 'd' = DIFF review: the local hunk diff, free. The mnemonic is 'd' (diff),
    // and this frees up lowercase 'r' for AI review — the earlier lowercase-'r' /
    // capital-'R' pair (hunk vs. AI) was typographically too close together.
    //
    // (wf31/6) `d` IS ALSO THE OPENER FOR A COMPLETED REVIEW — instead of `r`.
    if (input === 'd') { void openReview(current, { agentNotes: hasAnyFindings(current.number) }); return }
    // 'r' = AI-REVIEW LIFECYCLE KEY. A separate key from 'd', because it has a DIFFERENT
    // cost profile: 'd' is free (local diff), 'r' spends the developer's
    // Claude tokens. In the IDLE state this branch ONLY opens the confirmation
    // screen — we NEVER launch claude from here (see the confirm's y branch).
    //
    // (wf31/6) THE `done` BRANCH AS AN OPENER WAS DISCONTINUED: opening is `d`'s job.
    //
    // BUT `r` IN THE DONE STATE ALSO MUST NOT START A NEW ONE, AND THIS IS NOT
    // OPTIONAL: `askAiReview`'s guard ONLY excludes a RUNNING review
    // (`aiHandle`), NOT unloaded, PAID-FOR findings — an `askAiReview` let through
    // here would therefore silently open a SECOND paid review, and the
    // first one's findings would get overwritten by the next load. Starting a new one
    // still requires EXPLICIT discard (double `x`) as a precondition, which the
    // `done` label (`x: discard review`) also advertises.
    if (input === 'r') { rKeyAction(current); return }
    // (wf31/10) `c` ALSO LIVES ON THE LIST: opens the panel AND starts the measurement.
    //
    // WHY IT ALSO OPENS THE PANEL: the measurement's RESULT is displayed in the panel (the
    // measured bar), so a measurement without a panel would only give the `⋯` indicator on
    // the list, and the user wouldn't know where to look. `c` thus gives the intent in
    // ONE gesture: "show it, and measure it too".
    //
    // THE ORDER IS FIXED: `openInfo` FIRST (that sets up the panel state that
    // `measureConflict` writes progress into), the measurement AFTER. In reverse, the
    // `setPanel((cur) => …)` update would run against a panel that DOESN'T EXIST YET, and
    // the progress would be silently lost.
    if (input === 'c') { openInfo(current); measureConflict(current); return }
    // ENTER (+ silent alias 'i') = INFO/WHY — ONE panel in place of the earlier 'c' + 'i'.
    // The quick part is visible immediately, the merge-tree measurement loads
    // progressively in the background, and can be aborted with Esc. NO `busy`: the UI
    // deliberately stays usable.
    //
    // WHY ENTER IS PRIMARY (user request: "instead of the dropdown »i« it could be
    // Enter"): the panel is OPENING the selected row — and in a list the "open
    // this row" gesture is universally Enter. `i` was a letter mnemonic
    // ("info"), which after the panel's MERGER (info + measurement + steps) no longer even
    // covers the content.
    //
    // 'i' REMAINS a silent alias, but the legend does NOT advertise it. Two advertised
    // keys for the same function make noise in a tight footer; keeping it, however,
    // is free, and doesn't silently fail anyone whose hand already learned it.
    //
    // ENTER DOESN'T STEAL A KEY: the modal branch (`if (modal)`) runs FIRST, and
    // maps `key.return` there onto the OPENING "No" choice, then cuts it off with
    // `return` — so a panel is NEVER opened from here over a pending, irreversible
    // decision. The panel branch (`if (panel)`) also stands earlier: with the
    // panel open, Enter opens/closes the MEASUREMENT CAVEAT footnote (its own branch —
    // there Enter closes the panel) — so this line ONLY runs with the panel closed, and
    // there its job is opening the panel.
    //
    // THE SEMANTICS ARE ONE-DIRECTIONAL, AND THIS IS DELIBERATE: Enter ALWAYS means "open the
    // next level" (list → panel, panel → caveat footnote). The earlier
    // form CLOSED on the panel, so the same gesture pointed in two opposite
    // directions; closing is `Esc`/`q`'s job, which the footer also advertises.
    if (key.return || input === 'i') { openInfo(current); return }
    // 'f' = UPLOADING the REMAINING hunk findings to GitHub. Requires confirmation,
    // like 'r'/'a'/'m': this is an EXTERNALLY VISIBLE, irreversible action — a
    // review appears on the PR under your name, the author gets a notification. A
    // buffered or mistyped 'f' would have posted immediately (the key right next to
    // 'd'!). The gate is the same dwell gate (confirmAccepts), so a
    // buffered keypress can't slip through it either.
    //
    // We don't yet know the COUNT (doUpload reads that out of the hunk) — and
    // deliberately don't measure it here either: hunkComments is blocking I/O that can also
    // throw (position error), and a confirmation screen that itself fails is worse than
    // doUpload's loud error on the status line.
    if (input === 'f') { openModal(current, { kind: 'upload', blockers: [] }); return }
    // APPROVE/MERGE BLOCKERS FROM ONE source (approveModalProps/mergeModalProps).
    // The same branch runs from the list AND from the PANEL — a copied gate here would
    // SILENTLY let a forbidden approve through on the ONE path we forgot.
    if (input === 'a') { openModal(current, approveModalProps(current)); return }
    if (input === 'm') { openModal(current, mergeModalProps(current)) }
  })


  // THE OVERLAY STATE: confirm AND info are ONE concept from the render's perspective.
  // Order: confirm wins, because it is a PENDING DECISION (without confirmation the
  // token-spending/posting action doesn't start), while info is just reading.
  //
  // WHY NOT AN EARLY RETURN (this is the point of the refactor): the old code, in the
  // form `if (info) return h(...)` / `if (confirm) return h(...)`, replaced the WHOLE screen,
  // so when the dialog opened the user lost the list — they couldn't see WHICH
  // PR the question was about. Now the list stays DIMMED but rendered throughout, and the
  // overlay sits on top with its FRAME.
  //
  // THE ORDER: the error wins over EVERYTHING. Reason: the error is the fact that just
  // failed, and which the user must acknowledge; if an info panel left open beneath it
  // suppressed it, the error would be silently lost — exactly the silence this
  // point eliminates. (The error branches already closed the confirm anyway.)
  const overlayState = errorState
    ? { kind: 'error', row: errorState.row, message: errorState.message }
    : modal
    ? { ...modal, row: panel.row }
    : panel
    ? { kind: 'info', row: panel.row }
    : null
  // THE FRAME comes from the core's pure function: title, footer, frame color, and the widths
  // measured IN CELLS. The `width` never exceeds the terminal — the frame and padding
  // are included too — otherwise Ink would wrap the frame.
  // THE FRAME is built on `width`, which since wf31/33 is ALREADY the smallest of the three sources
  // (see there) — no separate clamp is needed.
  // (wf31/65) THE FLOATING PANEL — EXPERIMENTAL, BEHIND AN ENV FLAG.
  //
  //     TUIPR_NEXT_FLOAT=1 pnpm exec tuipr queue
  //
  // The user's request: the info panel should NOT push the rest of the list, but should float
  // ABOVE it — and from the left, not at the edge, but a bit further in.
  //
  // THE MECHANISM is Ink's `position: 'absolute'` (measured, ink 7.1.1): the
  // absolute node DROPS OUT of the flow (doesn't push its siblings), and `Output`
  // is a 2D cell buffer — a node written LATER overwrites an earlier one, so the "z-index"
  // is the tree order. The panel is therefore the root `Box`'s LAST child in float mode.
  //
  // (wf31/67) FLOAT IS THE DEFAULT — the user's decision after measuring ("This is
  // the right direction. From now on this is the default"). The switch's direction reversed: the OLD,
  // list-pushing behavior can be requested back:
  //
  //     TUIPR_NEXT_NOFLOAT=1 pnpm exec tuipr queue
  //
  // THE DECLARATION STANDS HERE, BEFORE `frame` — TDZ (measured, the user's crash:
  // "Cannot access 'PANEL_FLOAT' before initialization"): the computation of `frame`
  // already reads the flag, so the flag must be born FIRST. The same
  // error class also struck at `hasFooter` (wf31/49).
  const PANEL_FLOAT = !/^(1|true|yes)$/i.test(String(process.env.TUIPR_NEXT_NOFLOAT ?? '').trim())
  // (wf31/67) THE LEFT INDENT BEHIND THE PR-NUMBER COLUMN — the user's request: "the covered
  // rows' PR numbers should be visible". The start of the row has a MEASURED width: cursor (2) +
  // `#NNNNN ` (7) = 9 cells; from the 10th cell on, the number AND a hint of a gap
  // is visible. (The stacked rows' indented number may fall partly under cover — they
  // live under their pedestal, where the number is secondary.)
  const PANEL_FLOAT_LEFT = 10
  // (wf31/65) IN FLOAT MODE THE FRAME GETS A NARROWER MEASURE DUE TO THE INDENT: the left
  // inset + the frame TOGETHER must not overhang — an overhanging row would wrap, and the
  // wrap throws off Ink's clear-calculation (the root of the resize-flicker).
  //
  // (wf31/67) THE RIGHT EDGE BELONGS TO THE TABLE, NOT THE VIEWPORT — the user's request, and the same
  // principle the header's notice and the legend's pending already follow (wf31/46): the
  // `layout.width` is the table-edge computed FROM THE CONTENT, and the panel's right edge aligns to
  // it, not to the monitor's. On an empty list (layout.width 0) the viewport remains.
  // One source, not a subsequent cut.
  const frame = overlayFrame({
    state: overlayState,
    columns: PANEL_FLOAT
      ? Math.max(20, (layout.width > 0 ? layout.width : width) - PANEL_FLOAT_LEFT)
      : width,
  })

  // (wf31/56) THE DIMMING'S FADE — A FINITE TICKER, NOT A CONTINUOUS ANIMATION.
  //
  // The user's request: the dim shouldn't jump but fade; on input the animation should
  // IMMEDIATELY snap to the end state.
  //
  // WHY THE TICKER IS FINITE (and why not a `setInterval` that always runs): since
  // wf31/36 EVERY FRAME IS FULLSCREEN — Ink's `shouldClearTerminalForFrame`
  // writes `clearTerminal` together with the fresh output, so a fade frame is redrawing the
  // WHOLE screen (on the order of 15-20 KB on a 200×50 terminal), not
  // recoloring one row. A forever-running animation ticker would produce this every
  // second even when nothing is happening. The ticker therefore lives ONLY during the
  // transition, and stops at the end state.
  //
  // WHY THERE'S NO TEARING: Ink wraps every frame between `bsu`/`esu` (`\u001B[?2026h/l`,
  // synchronized output) when stdout is a TTY — the terminal therefore draws the
  // picture ATOMICALLY. The earlier flickers were NOT Ink frames, but raw
  // escape writes around suspend (wf31/46-51), and that's exactly the difference.
  // THE TIMING IS FINAL (the user tuned it in): 3 × 20 ms = 60 ms.
  //
  // (wf31/64) THE `SLOW` DIAGNOSTIC ENV REMOVED — the tuning phase concluded,
  // the mechanism approved ("OK, it's good now"). What remains is the DISABLE flag:
  //
  //     TUIPR_NEXT_NOANIM=1 pnpm exec tuipr queue
  //
  // — the fade turns off completely (immediate end state). This is a USER setting, not
  // diagnostics: someone who doesn't want animation (e.g. a screen reader, a slow SSH
  // connection, or a simple preference) gets the dimming in one step.
  const FADE_NOANIM = /^(1|true|yes)$/i.test(String(process.env.TUIPR_NEXT_NOANIM ?? '').trim())
  const FADE_STEPS = 3
  const FADE_MS = 20
  // THE STARTING COLOR: THE THEME'S TEXT COLOR — WITH A MEASURED VALUE, NOT A GUESS.
  //
  // (wf31/59) The user's request: "compute it from the theme down to dim, I don't want to
  // fiddle with color codes" — and their finding also supplies the measurement: "the letters
  // were WHITE". The TUI theme's text color is therefore white, so the fade's
  // starting point is `#ffffff`.
  //
  // WHY THIS WORKS, WHILE THE PREVIOUS TWO ATTEMPTS DIDN'T:
  //   · `#c8ccd4` (wf31/56) — LIGHTENED on the first frame, because it was darker than
  //     true white. The user saw this as a "brightening".
  //   · `#8a919e` (wf31/57) — started in the correct DIRECTION, but 60-78% of the transition
  //     happened in a non-animated JUMP (measured): the fade thus remained invisible.
  //   · `#ffffff` (NOW) — a start MATCHING the resting color: there's no jump AND no
  //     lightening, because the first frame is the same white that was already there.
  //
  // AND THE RESTING PICTURE IS UNTOUCHED: `Row` draws the non-dimmed rows without a color
  // (`undefined` = theme) — WE don't write the white, only the transition starts
  // from there. The wf31/58 `baseColor` (which also rewrote the resting picture) was removed.
  //
  // WHITE AS AN ASSUMPTION: if a theme's text color isn't white, the first frame jumps
  // a little — but `dim`-based TUIs practically all use a light-white fg
  // on a dark background, and the user's MEASURED case is exactly this.
  // (wf31/62) THE STARTING POINT IS THE MEASURED FOREGROUND COLOR, if the terminal told us — white
  // is only the fallback. The user's finding ("the header's top-right text flashes white")
  // was exactly the price of guessing.
  const FADE_FROM = themeColors?.fg ?? '#ffffff'

  const [fadeStep, setFadeStep] = useState(FADE_STEPS)
  // THE DIRECTION IS THE TARGET STATE: with the overlay open the list DIMS (toward `FADED_COLOR`),
  // closed it sharpens back up. `frame` is the trigger — the same signal that decides the `dimmed`
  // prop too, so the fade and the end state cannot drift apart.
  const fadeTarget = frame ? 1 : 0
  const fadeTargetRef = React.useRef(fadeTarget)
  // (wf31/60) THE DIRECTION-CHANGE RESET DURING RENDER, NOT IN useEffect — FIXING OUR OWN
  // MEASURED BUG.
  //
  // The user's finding: "it fades in the wrong direction, bottom to top" — and "still not
  // slow".
  //
  // THE CAUSE OF BOTH: the reset was in useEffect, which runs AFTER THE COMMIT. The
  // panel's opening FIRST DRAWN frame therefore went out with the old `fadeStep` —
  // which is the END STATE (closing sets it there) —, meaning the list jumped IMMEDIATELY
  // to full dim (hence "not slow"), then the effect reset to 0, the picture FLASHED
  // white, and started downward from there (hence "bottom to top").
  //
  // THE FIX is React's documented "adjust state during render" pattern: calling setState
  // during render (with a guard!) DISCARDS this render and immediately re-runs it — the
  // commit already happens WITH the fresh step, so the first drawn frame is the white
  // starting point, not the end state. useEffect STRUCTURALLY cannot be right here:
  // whatever it does, it's a frame late.
  //
  // THE FADE STARTS ON OPEN (step 0), ON CLOSE IT'S IMMEDIATELY THE END STATE — in the closing direction
  // there's nothing to animate (see why at the head of `fadeColor`), and setting it to 0 there
  // would only produce empty redraws.
  if (fadeTargetRef.current !== fadeTarget) {
    fadeTargetRef.current = fadeTarget
    // NOANIM: opening also jumps straight to the end state — the ticker doesn't even start
    // (the step never goes below FADE_STEPS), so there's no intermediate frame and no
    // unnecessary redraw either.
    setFadeStep(fadeTarget === 1 && !FADE_NOANIM ? 0 : FADE_STEPS)
  }
  useEffect(() => {
    if (fadeStep >= FADE_STEPS) return undefined
    const timer = setTimeout(() => setFadeStep((n) => n + 1), FADE_MS)
    // The `unref` follows the pattern of the other timers: a running fade should NOT keep the
    // process alive on exit (measured: a stuck ticker gave a silently freezing exit).
    timer?.unref?.()
    return () => clearTimeout(timer)
  }, [fadeStep])
  // INPUT JUMPS TO THE END STATE — the user's stipulation. The `useInput` branch calls this:
  // during a `j`/`k` or any key, the fade must NOT race with the cursor's
  // movement on the same surface (the "unpredictable" experience measured at hunk-switching
  // came from exactly this kind of race).
  const finishFade = useCallback(() => {
    setFadeStep((n) => (n >= FADE_STEPS ? n : FADE_STEPS))
  }, [])

  // THE FADE'S CURRENT COLOR — ONLY IN THE DIMMING DIRECTION.
  //
  // (wf31/57) THE FADE-OUT (sharpening) BRANCH REMOVED — MEASURED, IT WAS DEAD CODE: the
  // `Row`'s dimming is decided by the `dimmed: frame !== null` prop, so the moment the panel
  // closes, `faded` IMMEDIATELY becomes false, and the renderer DOESN'T EVEN LOOK AT
  // `fadeColor` (`seg.color ?? (faded ? fadeColor : …)`). The
  // "sharpening back up" therefore never appeared on screen — we animated a
  // transition that didn't exist.
  //
  // AND THIS IS CORRECT AS IS: closing the panel is a FOCUS RETURN, which is an immediate
  // event — the list is where it was. The dimming is what deserves gradation
  // (something ELSE steps forward), not the return.
  // THE DIMMING'S PROGRESS (0..1) — `Row` tweens from this per segment
  // (wf31/61). The header gets a finished color (there's no semantically-colored segment there).
  const fadeT = fadeProgress(fadeStep, FADE_STEPS).t
  const fadeColor = lerpHex(FADE_FROM, FADED_COLOR, fadeT)
  // (wf31/62) THE HEADER'S DIM SEGMENTS (poll indicator, notice) sit at rest with a `dim`
  // attribute — their picture is therefore NOT the fg, but roughly half of it (SGR 2). The
  // user's finding ("the header's top-right text flashes white") came from the fact that
  // these too got the `fadeColor` starting from fg: dim-gray → LIGHT fg →
  // back. The tween starts for them from the dim-approximation. The 0.5 is SGR 2's typical
  // rendering; an approximation, but the error is local and small — the flash was structural
  // in nature.
  const fadeColorDim = lerpHex(lerpHex(FADE_FROM, '#000000', 0.5), FADED_COLOR, fadeT)

  // (wf31/53) THE STACK OFFER'S SINGLE SOURCE — the open panel's MEASURED diagnosis.
  //
  // From here BOTH are decided: whether the footer advertises `s`, and whether pressing it
  // does anything. One source, so the two cannot drift apart (an advertised,
  // but dead button — the project's measured error class).
  //
  // `null` means "no offer": either there's no measurement, or per the measurement it's not
  // stackable (zero or multiple culprits — a PR head can point to only ONE base
  // at a time, see `conflictAdvice`'s multi-culprit branch).
  //
  // THE SOURCE IS `buildInfoModel`, NOT THE RAW `panel` STATE: `slow.advice` is
  // COMPUTED FROM THE MEASUREMENT (`panel.progress.diag`) (`conflictAdvice`), it's not
  // stored in state — the raw `panel.slow` DOESN'T EXIST. It's the same pure
  // function that `infoBody` also works from, so the footer and the body
  // talk about the SAME measurement.
  const stackOffer = (() => {
    if (!panel || panel.mode !== 'inline' || !panel.row) return null
    const adv = buildInfoModel({ row: panel.row, progress: panel.progress ?? null })?.slow?.advice ?? null
    if (!adv || adv.offerStack !== true) return null
    const on = Number(adv.stackOn)
    return Number.isInteger(on) && on > 0 ? on : null
  })()
  // (wf31/49) IS THERE A FOOTER AT ALL? — THE CONDITION FOR THE BOTTOM LINE.
  //
  // The user's finding: "when the info panel is open, the global bottom status row doesn't
  // appear. In that case the bottom separator is unjustified." Precisely: a separator
  // line with nothing beneath it to separate, just drawing a frame.
  //
  // THE THREE FOOTER SOURCES, in the same order the tree renders them below:
  //   · `exitConfirm` — the exit question precedes EVERYTHING (visible even under an overlay);
  //   · `loadedAt === null` — the loading caption (there the top line doesn't go out either);
  //   · `!frame` — the global legend, which is INTENTIONALLY omitted when an overlay is open (the
  //     open dialog's keys are DIFFERENT, see the legend's condition).
  //
  // THE TOP LINE'S CONDITION IS UNCHANGED (`visibleRows.length > 0`): it separates from the header,
  // which is ALWAYS there.
  const hasFooter = Boolean(exitConfirm) || loadedAt === null || !frame


  // --- THE DIALOG TYPOLOGY IN THE RENDER (AFTER 5a) ---------------------------
  //
  // CONFIRMATION LIVES IN THE PANEL TOO. The earlier model — confirmation IN THE LIST'S
  // PLACE — failed the user's live test (literally): "the review prompt
  // window is still 'modal', and it's separate from the info panel … in fact
  // _everything_ goes into the info panel. The info panel is the only dialog route for
  // PR actions." The RENDER is thus THE SAME on every frame: the panel sits
  // UNDER THE SELECTED ROW, and the list stays visible, dimmed.
  //
  // WHAT REMAINS FROM THE TYPOLOGY (because it protects the DECISION, not the picture): in
  // confirmation mode, up/down steps the SELECTION, d/r/a/m are inactive
  // (panelKeys), and the dwell-gate still guards the y unchanged. Hiding the list
  // wasn't needed for this — it's the key set that excludes cursor movement, not the
  // list's absence.
  const isInline = frame !== null

  // THE REVIEW TRACE on the CURRENT PR: the shared input of the friction bar and the attestation body
  // COMMON to both. It comes from the cache (session ledger) — see the head of `doApprove`
  // for why we don't ask GitHub back for it.
  const panelTrace = panel ? hasReviewTrace(cache.current, panel.row.number) : false

  // (wf31/17) IS THERE ANYTHING TO UPLOAD — the gate for the footer's `f` segment.
  //
  // The user's finding: "the »upload review« command isn't possible while there's no
  // review." Without a review, `f` was a DEAD KEY: the modal opened, and `doUpload`
  // failed loudly ("no live hunk session … THERE'S NOTHING TO
  // UPLOAD") — even though the action was, IN PRINCIPLE, never possible.
  //
  // THE TWO SIGNALS, AND WHY EXACTLY THESE TWO (mirroring `doUpload`'s TWO sources):
  //   · `hasAnyFindings` — there's a CACHED finding (the fallback source). This is
  //     readable FOR FREE on the render path (a pure Map lookup), and the `cacheVersion`
  //     dependency refreshes it;
  //   · `panelTrace` — a REVIEW has run on this PR in this session, so there's
  //     LIKELY material in the hunk session too (the primary source).
  //
  // WHY WE DON'T MEASURE THE HUNK SESSION DIRECTLY: `hunk session comment list`
  // is a spawnSync — it would run on EVERY frame on the render path. This is exactly the
  // error class the cache module's ZERO-I/O invariant mechanically forbids.
  //
  // THE APPROXIMATION'S DIRECTION IS DELIBERATE (fail-open): if EITHER signal says yes,
  // we advertise `f`. A falsely advertised `f` produces `doUpload`'s loud, actionable
  // error (there the hunk session IS measured) — a falsely HIDDEN
  // `f`, however, would mean the user can't upload their EXISTING
  // review, with no signal as to why. The missing option is the more expensive bug.
  const panelCanUpload = panel
    ? (hasAnyFindings(panel.row.number) || panelTrace)
    : false

  // `r`'S STATE-DEPENDENT FOOTER LABEL — the global KEYS and panelFooter get it from a COMMON
  // source (core `rKeyLabel`), computed for the lifecycle of the CURSOR's (or the open panel's)
  // row. `cacheVersion` is among the render inputs (the
  // cache read is a pure Map lookup), so this isn't I/O on the render path.
  const rLabelPr = panel ? panel.row?.number : current?.number
  const rLifecycle = rLabelPr === undefined || rLabelPr === null
    ? 'idle'
    : aiReviewLifecycle({
        review: aiReview,
        pr: rLabelPr,
        pending: cacheAiFindings(cache.current, rLabelPr),
      })
  const rLabel = rKeyLabel({
    lifecycle: rLifecycle,
    xArmed: xArm !== null && (
      (rLifecycle === 'running' && xArm.kind === 'abort')
      || (rLifecycle === 'done' && xArm.kind === 'discard' && xArm.pr === rLabelPr)
    ),
  })

  // THE CONTENT AS A LINE DESCRIPTOR: for an error the message, for a modal the decision data, for
  // inline the two bars + the action row. The order MATCHES `overlayState` —
  // if they drifted apart, modal content could appear inside an 'error' frame. The
  // innerWidth goes to ALL THREE bodies: the branch name is truncated to the frame's inner width,
  // and that measure is known only here.
  // THE INPUT TO THE AI-REVIEW PANEL SECTION. The running branch gets the `aiLive` ref's fresh
  // finding count/tool signal (the ref write is render-independent — the render is
  // driven by the ticker's `aiTick`), the rest of the state comes from state.
  // THE DOUBLE-`x` ARMING in the display is DERIVED: on the running branch it's the
  // abort-arm that counts, on the done branch the discard-arm bound to that specific PR — a
  // stale arm (a different kind / different PR) can't switch the label either.
  //
  // A REVIEW RESTORED FROM DISK ALSO APPEARS — THIS IS THE SECOND HALF OF THE USER'S
  // FINDING. WHAT THE BUG WAS: hydration ONLY wrote findings into the memory cache,
  // NOT the `aiReview` state. The `r: discard` footer label and the list glyph therefore
  // correctly showed that a review WAS done — but the PR panel's review section was
  // EMPTY, because it's built EXCLUSIVELY from the `aiReview` state. The user looks in the panel
  // for the review (that's where they read the findings and the verdict), so the
  // "not loaded in the TUI" finding would have stood EVEN AFTER the coreSha fix, without this one.
  //
  // WHY HERE (DERIVED), AND WHY HYDRATION DOESN'T WRITE `aiReview`:
  // `aiReview` is the CURRENT, ROW-BOUND review state (one PR's at a time), while
  // restoration affects MANY PRs AT ONCE. An `aiReview` written at hydration time would
  // therefore ARBITRARILY PICK one PR (the last one in the loop),
  // and the panel would silently stay empty on OTHER rows — the same error class, just
  // harder to notice. The DERIVATION responds to the open panel's ROW,
  // so it's correct on EVERY restored PR.
  //
  // THE PRECEDENCE: the LIVE `aiReview` ALWAYS wins. If a review ran (or is running)
  // on this PR in this session, we see that — the on-disk copy is STALE compared
  // to it, and an old summary over fresh findings would be a lying verdict.
  const restoredMeta = panel ? restoredReviews[panel.row?.number] : undefined
  const restoredPending = panel && restoredMeta !== undefined
    ? cacheAiFindings(cache.current, panel.row.number)
    : null
  const reviewForPanel = panel && aiReview && aiReview.pr === panel.row?.number
    ? (aiReview.status === 'running'
        ? {
            ...aiReview,
            findings: aiLive.current?.findings ?? 0,
            tool: aiLive.current?.tool ?? null,
            xArmed: xArm?.kind === 'abort',
          }
        : { ...aiReview, xArmed: xArm?.kind === 'discard' && xArm.pr === panel.row.number })
    // THE RESTORED REVIEW appears AS `done-answer`, and this is EXACT, not an
    // approximation: that state means "the findings exist, but they're not yet
    // loaded into the hunk" — for a hydrated review this is LITERALLY true,
    // since the hunk session didn't survive the previous process (which is also why the
    // `applied` flag isn't persisted either, see the head of review-store).
    //
    // THE FINDINGS come FROM THE MEMORY CACHE, not from the `restoredMeta` entry:
    // DISCARDING (double-`x`) deletes them from the cache, and if we drew the on-disk copy
    // here instead, a discarded review would RETURN to the panel. `restoredMeta` only carries
    // what the cache CANNOT know (summary + drift signal).
    : restoredPending !== null
      && Array.isArray(restoredPending.findings)
      && restoredPending.findings.length > 0
    ? {
        pr: panel.row.number,
        status: 'done-answer',
        added: restoredPending.findings.length,
        findings: restoredPending.findings,
        summary: restoredMeta.summary,
        // THE CAVEAT IS STATED EXPLICITLY (the store's `tool-drift` state): the findings
        // are about the diff, which still holds — but a DIFFERENT core version measured them. The `caveat`
        // channel is the EXISTING pattern for degraded review paths, for the same
        // concept: "it's shown, but the caveat isn't concealed".
        caveat: restoredMeta.toolDrift
          ? 'this review was measured by a DIFFERENT core version than the one running now — the findings are about the PR\'s '
            + 'unchanged diff, but a review run now might find other things too'
          : null,
        // THE LOAD OFFER comes from the `applied` flag: if the findings are already
        // in the hunk (we opened it in this session), we DON'T advertise the offer
        // again — the `d` path's `offer:false` update does the same thing.
        offer: restoredPending.applied !== true,
        xArmed: xArm?.kind === 'discard' && xArm.pr === panel.row.number,
      }
    : null
  const bodyLines = !frame
    ? []
    : errorState
    ? errorBody(errorState, frame.innerWidth)
    : modal
    ? confirmBody({ ...modal, row: panel.row }, frame.innerWidth, { hasTrace: panelTrace, choiceIndex })
    : infoBody(
        info,
        frame.innerWidth,
        reviewForPanel === null
          ? []
          : aiReviewPanelLines(reviewForPanel, { innerWidth: frame.innerWidth, now: Date.now() }),
        // THE CAVEAT FOOTNOTE's state (progressive disclosure). `bodyLines`
        // is DIRECTLY the input to `clipBodyLines`, so the opening/closing's
        // HEIGHT CHANGE also goes through the same measured path as every other
        // row — the viewport can't drift from reality (this is the
        // error class MEASURED at `estimatePanelRows`).
      )
  // THE BODY'S TOTAL HEIGHT (with wrapping!) + the frame's fixed cost = what the
  // panel WOULD REQUEST. The same `clipBodyLines` that will also cut later: `maxRows`
  // is intentionally practically unlimited here (Infinity is no good — the core uses Math.floor),
  // so `rows` is the MEASURED total height.
  // (2) THE REVIEW-CASCADE MENU's ROWS — IN THE FOOTER's PLACE (see panelNode).
  //
  // The menu appears ONLY if the OPEN PANEL's ROW matches the menu's
  // PR. WHY: the menu is a token-spending decision about a PR — if the panel
  // meanwhile moved to another row (poll, reload), the menu WOULD APPEAR under a DIFFERENT PR, and
  // the user would think it will start on that one. The same row-binding that
  // also applies to `reviewForPanel` and the measurement callbacks. (The KEY branch closes this same
  // guard fail-closed: it closes the menu on a stale row.)
  const menuLines = frame && !errorState && !modal && reviewMenu && panel?.row?.number === reviewMenu.pr
    ? reviewMenuLines(reviewMenu, { innerWidth: frame.innerWidth })
    : []
  // THE HEIGHT ESTIMATE ALSO COUNTS THE MENU. `PANEL_CHROME_ROWS` (6) counts on a ONE-row
  // footer; the menu is TWO rows (footer + menu row — the empty row was removed per the
  // wf28/3 observation), so the difference must be added — without this the
  // viewport would size the panel one row shorter than what it renders,
  // and the HEADER would slide off screen
  // (exactly the error class MEASURED at `estimatePanelRows`: the estimate and
  // reality drifting apart).
  const menuExtraRows = menuLines.length > 0 ? menuLines.length - 1 : 0
  const wantedPanelRows = frame
    ? clipBodyLines(bodyLines, { width: frame.innerWidth, maxRows: Number.MAX_SAFE_INTEGER }).rows
      + PANEL_CHROME_ROWS + menuExtraRows
    : 0
  // --- THE VIEWPORT: the panel + list must not overhang the HEIGHT --------------
  //
  // THE LIST ISN'T VIRTUALIZED: until now every row was rendered, and as long as the dialog
  // was fullscreen this wasn't visible (the list wasn't there). The INLINE panel,
  // however, ends up BELOW the list, so the list + panel + chrome together could exceed
  // the terminal. In that case Ink pushes the content UPWARD: FIRST the HEADER slides
  // off (the one that carries the load time and the staleness indicator), then the top
  // of the list — exactly what the header chapter was written to prevent.
  //
  // `useWindowSize().rows` is the measure; on non-TTY / during resize it may be 0/undefined,
  // so the core's `panelViewport` FAILS SOFT (falls back to 24).
  // (wf31/36) ROWS TOO COME FROM THREE SOURCES, THE SMALLEST WINS — following `width`'s pattern.
  //
  // WHY OUR OWN MEASUREMENT IS NEEDED: fullscreen mode gives the root `Box` a FIXED height,
  // and if that's BIGGER than the real terminal, the tree overhangs — the terminal scrolls, the
  // top of the list slides off (exactly what fullscreen is meant to prevent). In the
  // resize gap Ink's `useWindowSize` lags by one tick, while
  // `process.stdout.rows` comes FROM THE KERNEL.
  //
  // THE SMALLEST WINS, same as for width: an UNDER-measured height skips a few rows
  // (cosmetic), while an OVER-measured one causes SCROLLING — and scrolling scatters
  // frames into the scrollback, which is the error class to be fixed.
  const { rows: inkRows } = useWindowSize()
  // (wf31/38) THE HEIGHT's IMMEDIATE CAP — following width's pattern.
  //
  // WHY IT'S NEEDED: the root `Box` gets a FIXED height (fullscreen mode). If that's
  // BIGGER than the real terminal, the tree overhangs, the terminal SCROLLS, and the top of the list
  // slides off. On shrinking, the height too must therefore drop IMMEDIATELY — the
  // debounced value here would produce the same wrapping class of bug, just vertically.
  const capRows = process.stdout.rows || 0
  const rowCandidates = [measuredSize.rows, inkRows, process.stdout.rows]
    .filter((n) => typeof n === 'number' && n > 0)
  const termRows = rowCandidates.length > 0 ? Math.min(...rowCandidates) : 24
  // THE ACTUAL HEIGHT: the SMALLER of the IMMEDIATE cap (if measurable) and the debounced
  // value. BOTH get this — the root `Box`'s fixed size AND the
  // content window (`panelViewport`) — because the two MUST MATCH: a
  // bigger window's rows would fall beyond the `Box`, where Ink cuts them, so they'd
  // silently disappear.
  const boxRows = capRows > 0 ? Math.min(capRows, termRows) : termRows
  // THE CHROME's fixed cost: header (1) + empty (1) + status (1) + legend (1, only
  // if there's no overlay). With the overlay open the legend is omitted — the open dialog's
  // keys are DIFFERENT, and the two side by side would be a lying affordance.
  const chromeRows = frame ? 3 : 4
  const viewport = panelViewport({
    rowCount: rows.length,
    // THE CURSOR is the index into the DISPLAYED rows (not the selectable ones): the viewport
    // cuts on the rendered list, so the indented (non-selectable) stacked rows
    // count too. `current` comes from the selectable; here we find its position.
    cursor: current ? Math.max(0, rows.findIndex((r) => r.number === current.number)) : 0,
    // (wf31/38) THE VIEWPORT ALSO GETS `boxRows`: the content window can't be
    // BIGGER than the tree's fixed height, otherwise the bottom of the list falls beyond the `Box` —
    // Ink cuts there, so the rows would SILENTLY disappear (the viewport would think
    // it drew them, and `panelViewport`'s cursor-tracking would end up on a
    // row that isn't visible).
    height: boxRows,
    // THE PANEL's HEIGHT comes from the MEASURED body, NOT a hand-computed estimate.
    //
    // MEASURED BUG: the first version calculated with an `estimatePanelRows` heuristic
    // ("roughly this many rows" per bar), which didn't account for WRAPPING — a
    // long advice paragraph takes 3-4 rows, the estimate gave 1, and the frame
    // OVERHUNG (29 rows on a 12-row terminal, the header slid off). Now the same
    // `clipBodyLines` that will also cut later measures the height — ONE measure,
    // so the estimate and reality can't structurally drift apart.
    // (wf31/65) IN FLOAT MODE THE LIST GETS THE FULL SPACE: the panel doesn't sit
    // in the flow, so no space needs to be left for it either — that's exactly the point of float
    // (the list doesn't shift when the panel opens).
    panelHeight: isInline && !PANEL_FLOAT ? wantedPanelRows : 0,
    chrome: chromeRows,
  })
  // THE LIST RENDERS ON EVERY FRAME (5a): confirmation lives in the panel too,
  // so the list rows are ALWAYS visible per the viewport window. The old
  // "modal in the list's place" list-clearing was removed — protecting the decision lives
  // in the key set (panelKeys), not in swapping the picture.
  const visibleRows = rows.slice(viewport.first, viewport.first + viewport.visibleRows)
  // THE PANEL's INSERTION POINT: AFTER the SELECTED ROW, within the visible window.
  // If the cursor's row (for whatever reason) isn't in the window, the panel goes to the END
  // of the list — fail-soft: the panel is still visible, just not below the row. (The
  // viewport's contract guarantees this can't happen; this is the safety net.)
  const cursorAt = current ? visibleRows.findIndex((r) => r.number === current.number) : -1
  const insertAfter = cursorAt >= 0 ? cursorAt + 1 : visibleRows.length

  // THE PANEL (framed overlay). ONE place: the title, content, and footer all go out
  // from here, whether it sits inline or as a modal. `width` is explicit: without it Ink would
  // size the frame to the content, and one long inner row would overhang
  // the terminal (the wrapping error class reported four times). The inner rows conform to
  // `frame.innerWidth`, so they fit in cells too.
  //
  // THE TRUNCATION IS STATED EXPLICITLY: if the viewport sized the panel shorter than what
  // the content wants, ONE row signals it. Silently cutting is the same error class as
  // a silently swallowed error: the user doesn't know there's more.
  // CUTTING THE BODY to the height the viewport ALLOWS.
  //
  // `panelRows` also includes THE FRAME (the estimate counts with `PANEL_CHROME_ROWS`),
  // so the body gets whatever remains after the chrome. Since 5a
  // CONFIRMATION also sits inline (next to the list), so it gets the SAME viewport-given
  // space — the old "in a modal the whole terminal is ours" branch was removed.
  // (2) THE MENU's EXTRA ROWS are subtracted from the BODY's space, not the list's: per
  // the `PANEL_MIN_LIST_ROWS` chapter, on a narrow terminal the PANEL shrinks, NOT
  // the list that disappears — the list is the decision's CONTEXT. And the menu IS the decision,
  // so it can't be truncated (without `y`/`esc` the menu is unusable).
  // (wf31/65) IN FLOAT MODE THE PANEL's BUDGET IS THE FULL HEIGHT (the viewport doesn't
  // reserve space for it, so `viewport.panelRows` is 0 there — from that the body would be
  // empty). The clamp is to `boxRows`: the floating panel can't overhang the tree either.
  const panelRowsBudget = PANEL_FLOAT && isInline
    ? Math.min(wantedPanelRows, boxRows)
    : viewport.panelRows
  const bodyRoom = Math.max(0, panelRowsBudget - PANEL_CHROME_ROWS - menuExtraRows)
  const clipped = frame ? clipBodyLines(bodyLines, { width: frame.innerWidth, maxRows: bodyRoom }) : { kept: [], truncated: false }
  // (wf31/65) THE FLOATING PANEL's POSITION: BELOW the cursor's row, clamped to the bottom of the tree.
  //
  // THE FORMULA: header (1) + top separator (1) = the list starts at row 2; the
  // cursor's visible index is `cursorAt`; the panel starts from the NEXT row. If it doesn't fit
  // downward, the clamp pushes it UPWARD (it may even overlap the cursor's row — a deliberate
  // simplification for the first iteration; "flip above the cursor" comes when the
  // experiment proves out).
  const floatTop = PANEL_FLOAT && isInline
    ? Math.max(0, Math.min((cursorAt >= 0 ? cursorAt : 0) + 3, boxRows - panelRowsBudget))
    : 0
  const panelNode = frame
    ? h(
        Box,
        {
          key: 'panel',
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: frame.borderColor,
          paddingX: 1,
          width: frame.width,
          // (wf31/65) FLOAT: drops out of the flow, floats above the list. The `left` is the
          // user-requested indent — the list's left edge peeks out beside the panel.
          // (wf31/66) THE BACKGROUND IS EXPLICIT — THE PANEL IS OPAQUE. The user's finding: "the
          // floating panel's free area lets the table show through". Ink's cell buffer
          // only writes where there's a CHARACTER — the padding, the gap after short rows, and
          // empty rows' cells stay untouched, and the list shows through beneath them. The
          // `backgroundColor` paints the whole content rect (renderBackground:
          // space-rows inside the frame), so the panel covers.
          //
          // THE COLOR IS THE MEASURED THEME BACKGROUND (OSC 11) — this makes the fill invisible: the
          // panel's "background" is the same as the screen's, just now it's WRITTEN, not
          // left transparently empty. Fallback black: on a non-responding terminal,
          // this is the right direction for the vast majority of dark themes.
          ...(PANEL_FLOAT && isInline
            ? {
                position: 'absolute',
                top: floatTop,
                left: PANEL_FLOAT_LEFT,
                backgroundColor: themeColors?.bg ?? '#000000',
              }
            : {}),
        },
        h(Text, { bold: true, color: frame.borderColor }, frame.title),
        h(Text, null, ' '),
        ...renderLines(clipped.kept),
        // THE TRUNCATION IS STATED EXPLICITLY — and NOW IT ACTUALLY HAPPENS TOO.
        //
        // MEASURED BUG: the first version wrote this line out from `viewport.panelTruncated`,
        // BUT DIDN'T ACTUALLY CUT THE CONTENT. The frame grew to 29 rows on a 12-row terminal,
        // the HEADER slid off, and the UI claimed something that hadn't happened.
        // The signal's source is therefore NOW the actual cut's result (`clipped`), not
        // the intent — so the line and reality can't structurally drift apart.
        ...(clipped.truncated
          ? [h(Text, { dimColor: true }, '… panel truncated — more fits on a taller terminal')]
          : []),
        h(Text, null, ' '),
        // THE FOOTER — THE CONTROLS AT THE BOTTOM OF THE FRAME, DIMMED (the user's 3rd principle).
        //
        // The panel's keys come from the core's `panelFooter` (not `overlayFrame`'s):
        // in inline mode it advertises the FOUR ACTIONS (the consolidation's visible
        // result), and in modal mode `↑/↓` ALONGSIDE `y/N` — the arrow-key
        // selection is a new affordance that `overlayFrame`'s footer doesn't know. The
        // AI-review screen's OWN extra keys (review path, budget), however,
        // are stated there, so on that ONE branch the frame's footer is used.
        // (2) THE REVIEW-CASCADE MENU IN THE FOOTER's PLACE — when it's open.
        //
        // The user's specification: "all the legend's other options should disappear, the review
        // legend should keep its position (so a skip in place of d: diff),
        // and below it, with one row's gap, the review menu should appear."
        //
        // THE MENU THEREFORE REPLACES THE FOOTER, it doesn't come to the body: the footer sits
        // at the BOTTOM of the frame (the user's 3rd principle), and the menu takes its place — this way
        // the "keep the position" request is even meaningful at all. Had I put it at the
        // end of the body, the full normal footer would have stayed ABOVE the menu
        // (`d: diff · r: review · …`), so exactly the requested disappearance wouldn't happen.
        //
        // THE ROWS come from the core's pure function (reviewMenuLines), measured
        // in cells and degraded — the width decision is justified and tested there.
        ...(menuLines.length > 0
          ? renderLines(menuLines)
          : [(() => {
              if (errorState || modal?.blockers?.length > 0) {
                return h(Text, { key: 'lc', dimColor: true }, frame.footer)
              }
              // `r`'s label is STATE-DEPENDENT (rKeyLabel — running/done review announces a
              // different role), the other keys come from the core's panelFooter.
              // (wf31/17) `canUpload` is the measured fact of UPLOADABILITY: without it
              // the `f` segment falls out (the user's finding: "the »upload review«
              // command isn't possible while there's no review").
              //
              // (wf31/45) PENDING GOES TO THE RIGHT EDGE HERE TOO, WITH INVERSE HIGHLIGHT — following the
              // same pattern as the global legend. `f` (upload) and `d`
              // are also advertised in the PANEL's footer, so the signal must appear
              // there too, wherever you see the key.
              //
              // THE MEASURE is `frame.innerWidth` (the frame's INNER width), not the
              // terminal's `width`: the footer sits INSIDE the frame, and a
              // pending aligned to the terminal width would slide PAST the frame's `│` column
              // as well.
              const footerText = panelFooter(panel, frame.innerWidth, {
                rLabel,
                canUpload: panelCanUpload,
                // THE LABEL NAMES THE TARGET (`s: stack onto #904`), not just the
                // action: the DIRECTION of the stacking is the point, and the user can verify from the footer
                // that it's going to the PR the verdict says.
                stackLabel: stackOffer === null ? '' : `s: stack onto #${stackOffer}`,
              }).text
              const { left, gap, right } = legendWithPending(footerText, activePendingKey, frame.innerWidth)
              return h(
                Box,
                { key: 'lc' },
                h(Text, { key: 'lc-l', dimColor: true }, left),
                ...(gap !== '' ? [h(Text, { key: 'lc-g' }, gap)] : []),
                ...(right !== '' ? [h(Text, { key: 'lc-r', inverse: true }, right)] : []),
              )
            })()]),
      )
    : null

  return h(
    Box,
    {
      flexDirection: 'column',
      // (wf31/36) FULLSCREEN MODE — THE LIST ALWAYS AT THE TOP OF THE SCREEN, WITH A FIXED
      // HEIGHT. The user's request: "I think we should go »full screen« mode,
      // so the list is always at the top of the screen."
      //
      // AND THIS ISN'T JUST AESTHETICS — THIS ACTIVATES INK's WORKING CLEAR PATH.
      // `shouldClearTerminalForFrame` (ink 7.1.1) writes a `clearTerminal` together with
      // the fresh output when the frame's height reaches the viewport:
      //     const isFullscreen = nextOutputHeight >= viewportRows
      // In that case Ink does NOT use the line-count-based `eraseLines` (which UNDER-measures
      // with wrapped rows — this was the root of the whole glitch), but instead
      // does a full-screen clear + redraw.
      //
      // THE USER's MEASURED PATTERN that this eliminates: "when you resize narrower than the layout there's a
      // render, resizing to a wider window gives an empty screen". The explanation: on narrowing
      // Ink zeroes out `lastOutput` (so the diff lets the render through),
      // on widening it does NOT — there our own `2J` cleared, and there was nothing left to
      // redraw. With a fixed-height tree this DIFFERENCE DISAPPEARS: every frame
      // is fullscreen, so every frame gets a full redraw.
      //
      // THE HEIGHT IS THE TERMINAL's ROWS (fail-soft to 24, like `panelViewport`): the
      // `height` is the Yoga node's fixed size, so the tree is ALWAYS that many rows — the list's
      // window (`panelViewport`) cuts to this measure anyway, so the content
      // doesn't overhang, only the remaining space stays empty.
      height: boxRows,
    },
    // THE HEADER STATES WHEN WE LAST LOADED (user request) AND whether the picture
    // has SHIFTED SINCE (the background poll's signal). Without this, the list standing on screen
    // can't be distinguished from one 20 minutes older, and the decision (approve /
    // merge) would be made on a stale picture. LOCAL time in HH:MM:SS form: the date here is
    // noise (the session is today), but the second isn't — the EFFECT of the refresh (that it
    // really loaded just now) is visible only from that.
    //
    // THE ROW's ASSEMBLY comes from the core's PURE, CELL-MEASURING function: the
    // header carries four elements, and a naive concatenation would wrap
    // on a narrow terminal (the error class reported four times). The degradation order is
    // stated and unit-tested there across the full columns range.
    //
    // THE COLORING stays here (the core's pure function returns text, not an Ink tree): the
    // poll indicator sits at the END OF THE ROW, so we cut it into two Texts. The signal is NOT
    // yellow: per the user's 3rd principle, yellow is ONLY for genuine warnings
    // (cost, blockers) — staleness is a to-do, not a danger.
    h(
      Box,
      null,
      ...(() => {
        const line = headerLine({
          loadedAt: loadedAt ? loadedAt.toLocaleTimeString('hu-HU', { hour12: false }) : null,
          // (1a) THE LOADED CORE's SHA. The call sits in the render, but it's MEMOIZED
          // (fetchCoreSha) — the spawn runs ONCE in the session's lifetime, not
          // per frame. This is load-bearing: the header recomputes on every keystroke, every
          // poll tick, and every spinner frame.
          coreSha: fetchCoreSha(),
          pollLabel,
          // (wf31/44) THE REBUILD SIGNAL: the bash `Next rebuild: …` line stayed in the shell,
          // which got lost immediately in fullscreen mode — the user's question
          // ("shouldn't this appear in the fullscreen too?") was exactly this. The
          // `null` case (successful rebuild) means `headerLine` doesn't produce a segment.
          rebuild,
          // (wf31/27) THE HEADER ALSO reaches to the TABLE's EDGE: a right-aligned `notice`
          // would otherwise have ended up at the MONITOR's right edge, detached from the list.
          // `layout.width` comes from the content; during loading (empty list) it's 0, and there
          // we fall back to the terminal width — otherwise the header would disappear.
          // THE HEADER reaches to the TABLE's width (so the `notice` aligns to the list,
          // not the monitor's edge). `layout.width` derives from `width`, which
          // since wf31/33 is the smallest of the three sources — no separate clamp is needed.
          columns: layout.width > 0 ? layout.width : width,
          // (wf31/23) THE FEEDBACK ON THE HEADER's RIGHT EDGE (the user's clarification:
          // "Actually then put it in the header, aligned right.."). The removed global
          // status row's RESULT and INPUT messages moved here; pending did NOT
          // (that goes into the legend, next to the triggering key).
          notice,
        })
        // WE CUT THE SIGNALS OFF THE END OF THE ROW so they get their own (dimmed) Text
        // node. The order follows `headerLine`'s construction: `notice` sits
        // AT THE VERY END (right-aligned), `pollLabel` is the left block's last
        // segment. If degradation skipped one of them, `lastIndexOf`
        // returns `-1`, and that part simply doesn't get a separate Text.
        // (wf31/35) A HARD CEILING FOR THE HEADER TOO — THIS WAS THE CAUSE OF THE REMAINING GLITCH.
        //
        // The user's pasted screenshot gave the trace: the list rows were ALREADY narrow
        // (`Row`'s `clampCells` cuts them), but the header's `20 PRs in the queue` was stuck
        // in its OLD, wider position. In other words, the header was the ONLY row
        // that didn't go through a hard cut: it got `layout.width`, which is the TABLE's
        // size — and in the resize gap that can be bigger than the real terminal.
        //
        // RIGHT-ALIGNMENT AMPLIFIES THIS: `headerLine` pushes `notice`
        // to the end of the row with whitespace padding. If the measure is 20 cells bigger
        // than reality, the padding is 20 longer too — the text therefore ends up
        // PAST the terminal's RIGHT EDGE, the terminal wraps it, and the characters stay
        // there (Ink's line count checks out, so it doesn't clear it).
        //
        // THE CUT goes TO `width` (the smallest of the three measures), NOT to
        // `layout.width`: the table measure is about the CONTENT, the ceiling is about the
        // PHYSICAL limit. The two differ, and here the latter is decisive.
        // (wf31/38) THE HEADER TOO cuts to the IMMEDIATE cap (not the debounced
        // `width`): on narrowing, the right-aligned `notice` would otherwise end up
        // PAST the terminal's right edge, and the wrapped remainder would get stuck there.
        const hardLine = clampCells(line, capWidth > 0 ? Math.min(capWidth, width) : width)
        const nAt = notice !== '' ? hardLine.lastIndexOf(notice) : -1
        const beforeNotice = nAt >= 0 ? hardLine.slice(0, nAt) : hardLine
        const noticeText = nAt >= 0 ? hardLine.slice(nAt) : ''
        const at = pollLabel !== '' ? beforeNotice.lastIndexOf(pollLabel) : -1
        const head = at >= 0 ? beforeNotice.slice(0, at) : beforeNotice
        const tail = at >= 0 ? beforeNotice.slice(at) : ''
        return [
          // (wf31/55) UNDER AN OPEN OVERLAY THE HEADER ALSO GETS THE FADED COLOR, not just
          // the `dim` attribute — that's a fixed degree, and it's barely visible on
          // colorless base text. The list rows use the same `FADED_COLOR`,
          // so the picture dims to ONE level, not two.
          // `dim` DROPS OUT WHERE THE COLOR DIMS: `FADED_COLOR` + `dim` stacked together are
          // a whole degree too dark (the three steps stand at the head of `FADED_COLOR`).
          h(Text, {
            key: 'h',
            bold: true,
            color: frame ? fadeColor : undefined,
          }, head),
          ...(tail !== ''
            ? [h(Text, { key: 'p', color: frame ? fadeColorDim : undefined, dimColor: frame ? undefined : true }, tail)]
            : []),
          // NOTICE IS DIMMED, like the poll indicator: EPHEMERAL feedback, not part of the
          // system's identity. The caller supplies the `⚠`/`✓` prefix, if needed.
          ...(noticeText !== ''
            ? [h(Text, {
                key: 'n',
                color: frame ? fadeColorDim : undefined,
                dimColor: frame ? undefined : true,
              }, noticeText)]
            : []),
        ]
      })(),
    ),
    // THE LIST + THE INSERTED PANEL, IN THEIR OWN BOX, BETWEEN SEPARATOR LINES.
    //
    // THE PANEL IS INSERTED AFTER THE SELECTED ROW, so the "which PR is this about" question
    // is also visible from POSITION, not just from the header. Since 5a, CONFIRMATION also sits
    // this way — the list never disappears.
    //
    // THE TABLE IS FRAMED BY TWO HORIZONTAL LINES (the user's request: first "vertical
    // padding for the table", then "a horizontal line where the empty rows are now"). This way the
    // controls don't stick to the list's last row, and the table
    // reads as one unit.
    //
    // ITS COST IS ZERO IN THE VIEWPORT: `chromeRows` (4) ALREADY counts with two rows
    // that weren't in the tree — per its own comment "header (1) +
    // empty (1) + status (1) + legend (1)", while the global status row was
    // removed in wf31/23, and the "empty" one was never added either. The two lines therefore
    // occupy the space the estimate had already reserved: no
    // single row is dropped from the list.
    //
    // THE FULLSCREEN INVARIANT DOESN'T MOVE EITHER: the root `Box` gets a fixed `height: boxRows`,
    // so the tree ALWAYS fills the terminal (the remaining space stays empty) — Ink's
    // `shouldClearTerminalForFrame` is satisfied on every frame, regardless of the
    // content's height. On a tree sized FROM ITS CONTENT, this insertion could
    // shift the fullscreen boundary, and bring back the resize flicker.
    //
    // ONLY WHEN THERE'S A TABLE: while loading (empty list), the two lines would
    // frame the "loading…" caption — there's nothing to separate there.
    // (wf31/51) WITH THE OVERLAY OPEN, ONLY A GAP IS LEFT: the panel's OWN frame already
    // separates, a line ABOVE it would just stack lines. The space, however, remains so that
    // the list doesn't jump — see the justification for `tableSeparator`'s `line` flag.
    ...(visibleRows.length > 0
      ? [tableSeparator(separatorWidth, 'sep-top', { line: !frame })]
      : []),
    h(
      Box,
      {
        key: 'table',
        flexDirection: 'column',
      },
      ...visibleRows.flatMap((row, i) => {
        const rowNode = h(Row, {
          key: row.number,
          row,
          selected: current && row.number === current.number,
          titleWidth: layout.titleWidth,
          tailLevel: layout.tailLevel,
          // OVERLAY OPEN → the list is dimmed CONTEXT, not the focus.
          dimmed: frame !== null,
          // (wf31/27) THE TABLE's width, NOT the terminal's — the cursor background goes
          // to the table's right edge, not the monitor's. The user's finding: "the highlight
          // should only go that far too". `layout.width` is computed FROM THE CONTENT (see
          // the justification of `listLayout`'s width branch).
          columns: layout.width,
          // (wf31/38) THE CUT's CEILING IS THE IMMEDIATE MEASUREMENT (`capWidth`), NOT the
          // debounced `width`. On narrowing, the row thus fits even in the INTERMEDIATE frames
          // (truncated, but not wrapped) — wrapping is what throws off Ink's
          // clear calculation, and gives the flicker.
          //
          // `Math.min` with `layout.width`: the table width is about the CONTENT
          // (narrower than the terminal for shorter titles), the cap is about the PHYSICAL limit. The
          // smaller one wins — `Row`'s background fill thus doesn't overhang either one.
          terminalColumns: capWidth > 0 ? Math.min(capWidth, layout.width || capWidth) : layout.width,
          // (wf31/56) THE FADE's FRAME COLOR. The end state is `FADED_COLOR`, so the
          // resting picture matches wf31/55 — the animation only provides the TRANSITION.
          fadeT,
          fadePalette: themeColors,
        })
        // INSERTING THE PANEL AFTER the cursor's row. `flatMap`, so the panel becomes one of the list's
        // CHILDREN — a separate Box after the list couldn't satisfy the requirement of
        // placing it BELOW the row.
        // (wf31/65) IN FLOAT MODE THERE's NO INSERTION: the panel floats as the root's last
        // child (tree order is the "z-index"), the list stays untouched.
        if (isInline && !PANEL_FLOAT && i + 1 === insertAfter) {
          return [rowNode, h(React.Fragment, { key: `panel-${row.number}` }, panelNode)]
        }
        return [rowNode]
      }),
      // FAIL-SOFT: if the cursor's row isn't in the visible window (the viewport's
      // contract excludes this — this is the safety net), the panel goes to the END of the list.
      // Silently omitting it is WORSE: the user pressed `i`, and nothing would happen.
      ...(isInline && !PANEL_FLOAT && cursorAt < 0 ? [panelNode] : []),
    ),
    ...(visibleRows.length > 0 && hasFooter ? [tableSeparator(separatorWidth, 'sep-bottom')] : []),
    // THE STATUS ROW's TWO SOURCES: `busy` (a blocking action is running) and `status` (the
    // most recent action's result). THE AI-REVIEW SIGNALS ARE NO LONGER HERE
    // (the user's 3rd point: "the status message at the bottom of the screen isn't a good place,
    // it mutates the layout") — the progress, end states, and errors live in the
    // PR PANEL (aiReviewPanelLines), and the fact that it's running is signaled by the list row's
    // Braille spinner.
    // THE EXIT QUESTION PRECEDES EVERYTHING, and is NOT dimmed: this is the ONLY place where
    // the status row ASKS for a decision instead of informing. It must be visible even under `busy`,
    // because the question is about the running review.
    // (wf31/9) THE EXIT QUESTION's ONLY CAUSE IS THE RUNNING REVIEW. The unloaded
    // findings' pending branch was REMOVED (see the `q` key's branch): since the disk cache,
    // there was no loss there, only information about how the cache works — per the user's
    // decision, it's the automatic default, which doesn't need to be mentioned.
    // (wf31/23) THE GLOBAL STATUS ROW REMOVED.
    //
    // The user's decision, verbatim: "There's a mini feedback at the bottom of the app, e.g.
    // »aborted« […] I don't want a global status like this, take it out, it looks stupid
    // down there too. And it shouldn't be anywhere else either. When a pending state is needed,
    // always put it at the triggering legend […] so it's contextual."
    //
    // THE THREE MESSAGE CLASSES' NEW LOCATION:
    //   · PENDING (`⏳ approve…`)     → into the LEGEND, next to the triggering key
    //     (`a: approve (running…)`) — contextually, as the user asked;
    //   · RESULT (`#895: merged`)  → into the HEADER, right-aligned (the user's
    //     clarification: "Actually then put it in the header, aligned right..");
    //   · INPUT RESPONSE (`aborted`) → the same place, the header's right edge.
    //
    // WHAT REMAINS HERE: EXCLUSIVELY the exit question. That isn't status, it's a PENDING
    // DECISION — while open, `y`/`n` swallows every other key, so it must be on
    // screen. `loading…` stays too: it's the ONLY state
    // when there's neither a list nor a legend to attach the signal to.
    exitConfirm
      ? h(Text, { color: 'yellow' },
          'an AI review is running — exiting will abort it (findings written to the hunk session '
          + 'are kept). Exit? [y/N]')
      // WHILE LOADING (loadedAt not yet set): empty row + standalone caption — the
      // regular status row isn't shown (the user: "there could be some spacing around the word
      // too… I wouldn't show the status row while loading").
      : loadedAt === null
      ? h(React.Fragment, null, h(Text, null, ' '), h(Text, { dimColor: true }, 'loading…'))
      : null,
    // WE DON'T SHOW the global legend with the overlay open: the open overlay's keys
    // are DIFFERENT (its footer advertises them), and the two side by side would suggest
    // the list's keys are active too — when actually the focus is on the overlay.
    // The footer legend isn't shown WHILE LOADING either (the user's note): there's nothing yet
    // to control — it returns after loading.
    // (wf31/11) THE LEGEND IS NOW STATIC: the PR-level, state-dependent keys
    // (`c`/`d`/`r`/`f`) moved into the PANEL's footer, where the decision is also made —
    // only the list-level keys remain here.
    // (wf31/45) PENDING ON THE LEGEND's RIGHT EDGE, WITH INVERSE HIGHLIGHT. The left side
    // (the key list) is BYTE-FOR-BYTE unchanged, so there's no layout jump — the justification is
    // at the head of `legendWithPending`.
    //
    // THREE TEXTS, because the `inverse` attribute lives per Text: `left` is dim, `gap`
    // is neutral (just space), `right` is inverse. A single concatenated string couldn't
    // express this.
    ...(frame || loadedAt === null
      ? []
      : [(() => {
          // (wf31/46) THE TABLE's WIDTH, NOT THE VIEWPORT's. The user's finding: "again you put the
          // right edge to the viewport's right edge instead of the table's. You already
          // solved this in the header."
          //
          // `layout.width` is the table-edge computed FROM THE CONTENT (see `listLayout`'s
          // width branch) — the header's `notice` also aligns to this (wf31/27). The legend's
          // pending needs to go to the SAME PLACE: the three ephemeral signals (header notice,
          // legend pending) thus align in ONE line with the list's right edge, not
          // stuck to the monitor's edge.
          //
          // We fall back to `width` if the table doesn't exist yet (empty list, loading) —
          // there `layout.width` is 0, and a 0 measure would swallow every signal.
          const { left, gap, right } = legendWithPending(
            KEYS,
            activePendingKey,
            layout.width > 0 ? layout.width : width,
          )
          return h(
            Box,
            { key: 'legend' },
            h(Text, { key: 'lg-l', dimColor: true }, left),
            ...(gap !== '' ? [h(Text, { key: 'lg-g' }, gap)] : []),
            ...(right !== '' ? [h(Text, { key: 'lg-r', inverse: true }, right)] : []),
          )
        })()]),
    // (wf31/65) THE FLOATING PANEL — AS THE LAST CHILD, because in Ink's Output buffer
    // a node written LATER covers an earlier one: this is what puts the panel "on top". The
    // absolute position removes it from the flow, so it doesn't push the rows above.
    ...(isInline && PANEL_FLOAT ? [panelNode] : []),
  )
}

export async function runTui() {
  // THE TUI NEEDS A REAL TTY — on non-TTY the caller (tuipr.sh) provides the list,
  // we never even get here. Defensively we check anyway.
  if (!process.stdout.isTTY) {
    process.stderr.write('the TUI needs a TTY — use `tuipr queue --list` instead\n')
    process.exitCode = 1
    return
  }
  // (wf31/34) ALTERNATE SCREEN — THE STRUCTURAL SOLUTION TO THE RESIZE GLITCH.
  //
  // THE THREE PREVIOUS ATTEMPTS AND WHY THEY FAILED (all MEASURED, on the user's findings):
  //   · wf31/28-29: a hard cell ceiling on every written row. The rows really don't
  //     overhang (measured at 190/100/60/40/20 cells) — the glitch REMAINED;
  //   · wf31/31: our own `2J/3J/H` in the resize event. The screen WENT BLANK and DID NOT
  //     come back, because Ink's `onRender` bails out on the `output === lastOutput` diff:
  //     the state bump didn't change the OUTPUT;
  //   · wf31/33: width from three sources, the smallest wins. The rows already build
  //     with the correct measure on the first resize render — the glitch REMAINED.
  //
  // THE LESSON: the bug is NOT in our width calculation. Ink's `resized`
  // handler is built on `log-update`'s LINE-COUNT-BASED clearing (`eraseLines(previousLineCount)`),
  // and doesn't clear at all on widening. We can't fix this from the outside: the
  // `lastOutput`/`lastOutputHeight` are private, and the public `clear()`
  // SYNCHRONIZES `lastOutput`, so the next render afterward sees the tree as
  // "unchanged".
  //
  // ALTERNATE SCREEN STRUCTURALLY WORKS AROUND THIS: the TUI draws into the SECONDARY
  // terminal buffer, which has no scrollback. The leftover produced on resize therefore
  // can't ACCUMULATE — the buffer's size IS the viewport, and the
  // terminal does its own redrawing. This is the well-established pattern of
  // `vim`/`less`/`htop`, not a trick.
  //
  // WHAT IT ALSO SOLVES (your wf31/28 request): exiting writes `exitAlternativeScreen`,
  // so your PROMPT returns UNTOUCHED — the list does NOT stay there in the scrollback.
  // My own `2J/3J/H` cleanup thus became UNNECESSARY, and I removed it too: two
  // mechanisms for the same purpose would mean one of them silently goes stale.
  //
  // OPENING A HUNK (`suspendTerminal`) IS SYMMETRIC: Ink's `beginSuspend`
  // writes `exitAlternativeScreen` (the hunk runs in the PRIMARY buffer, as it should), and
  // `endSuspend` steps back — I verified this in the source (ink 7.1.1).
  //
  // FAIL-SOFT: `resolveAlternateScreenOption` itself excludes the non-TTY and CI
  // environment, so the option is a silent no-op there — no separate guard is needed.
  //
  // (wf32) STDIN EXPLICITLY THROUGH `stdinWrapper` — see the
  // `DelegatingStdin` chapter. This way Ink NEVER sees the real
  // `tty.ReadStream`, so opening a hunk (`openHunkView`) can swap the target behind the
  // wrapper at any time, without Ink knowing about it —
  // this is what solves the shell getting stuck after closing a hunk (the stream-level
  // irrevocability of the stdin fd's blocking read).
  // (wf31/62) A ONE-TIME QUERY OF THE TERMINAL's COLORS — BEFORE THE RENDER, TOO.
  //
  // The answer comes over stdin, so it's safe ONLY here, when Ink (and the
  // target behind stdinWrapper) isn't reading yet. Fail-safe: on a non-responding
  // terminal it's `null`, and the fade continues with the built-in approximations.
  // (startup-freeze) THE KILL SWITCH is the diagnostic's A/B arm: if the freeze
  // reappears even with the color query disabled, suspicion shifts elsewhere. It's a
  // harmless escape hatch in production too (the fade continues with the built-in approximations).
  const themeColors = process.env.TUIPR_NEXT_TUI_NO_COLOR_QUERY
    ? null
    : await queryTerminalColors().catch(() => null)
  // (startup-freeze) ATTACHING the stdin forward ONLY NOW — this way during the query
  // truly no one was reading on fd 0 (see the DelegatingStdin constructor).
  stdinWrapper.engage()
  const app = render(h(App, { themeColors }), { stdin: stdinWrapper, alternateScreen: true })
  await app.waitUntilExit()
}
