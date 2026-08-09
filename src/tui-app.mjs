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
// (wf31/6) `f: review feltöltése` (upload review) — the user: "»upload« isn't
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
// `j/k vagy ↑/↓: navigáció` → `j/k: sor` shortening frees up the space. The
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
 * A pending-címke a futó akció kulcsához, vagy `null`.
 *
 * FAIL-SOFT AZ ISMERETLEN KULCSRA: `null`, tehát a legend változatlan. Egy
 * kitalált címke (pl. a kulcs kiírása) rosszabb lenne, mint a jelzés hiánya — a
 * `busy` alatt a UI amúgy is blokkolt.
 */
export function pendingLabelFor(key) {
  if (typeof key !== 'string' || key === '') return null
  return PENDING_LABELS[key] ?? null
}

/**
 * A legend + a jobbra igazított pending EGY sorba, CELLÁBAN mérve.
 *
 * A visszatérés `{ left, gap, right }`: a render HÁROM Textre vágja, mert a
 * `right` INVERZ kiemelést kap (`inverse`), a `left` pedig dim marad. Egy
 * összefűzött string ezt nem tudná — az attribútum Text-enként él.
 *
 * MIÉRT `inverse`, ÉS NEM FIX HEX-SZÍNEK: az ANSI `inverse` (`\e[7m`) a terminál
 * SAJÁT elő- és háttérszínét cseréli fel, tehát a téma DÖNTI EL az eredményt —
 * sötét témán világos háttér + sötét betű (amit a user kért), világos témán a
 * fordítottja. Egy fix `backgroundColor: '#d8dee9'` a user gépén pontos lenne, de
 * világos témán BELEOLVADNA a háttérbe, és a jelzés eltűnne.
 *
 * A DEGRADÁCIÓ a `headerLine` mintája: ha a kettő nem fér el, a PENDING esik ki, a
 * legend marad. Ok: a legend a VEZÉRLÉST hirdeti (enélkül a UI használhatatlan), a
 * pending EFEMER — és a `busy` állapotot a user amúgy is érzékeli abból, hogy a
 * gombok nem élnek.
 */
export function legendWithPending(keys, key, columns = 0) {
  const label = pendingLabelFor(key)
  if (label === null) return { left: keys, gap: '', right: '' }
  const limit = Math.max(0, Math.floor(Number(columns) || 0))
  // A `GAP` a minimális hézag: enélkül szűk terminálon a legend utolsó szegmense
  // és a pending ÖSSZEÉRNE (`q: kilépés⏳ approve…`).
  const GAP = 4
  const need = displayWidth(keys) + GAP + displayWidth(label)
  if (limit <= 0 || need > limit) return { left: keys, gap: '', right: '' }
  return { left: keys, gap: ' '.repeat(limit - displayWidth(keys) - displayWidth(label)), right: label }
}

// A PANEL KERETÉNEK (chrome) FIX sor-költsége — a viewport-számításhoz.
//
// A TARTALOM magasságát NEM becsüljük: a `clipBodyLines` MÉRI (tördeléssel, a
// keret belső szélességén). MÉRT BUG volt a becslés: egy sávonkénti "kb. ennyi
// sor" heurisztika a TÖRDELÉST nem vette figyelembe, egy hosszú advice-bekezdés
// 3-4 sort foglalt, a becslés 1-et adott — és a frame 12 soros terminálon 29
// sorra hízott, a FEJLÉC pedig kicsúszott. A chrome viszont TÉNYLEG fix:
// felső keret + cím + üres + üres + lábléc + alsó keret.
const PANEL_CHROME_ROWS = 6

/**
 * A TÁBLA VÍZSZINTES VÁLASZTÓVONALA — a fejléc/tábla és a tábla/lábléc között.
 *
 * A user kérése: "vízszintes vonal a mostani üres sorokban, tehát separator.
 * Természetesen a tábla széléig, ne a viewportig."
 *
 * A SZÉLESSÉG A HÍVÓ DOLGA (`layout.width`, fizikai plafonnal) — ez a függvény
 * csak rajzol. Így ugyanaz a mérték adható neki, amit a `Row` háttere és a fejléc
 * `notice`-a is használ: a három elem jobb széle EGY vonalban áll.
 *
 * `dimColor`: a vonal SZERKEZET, nem tartalom — a szemnek a sorokon kell
 * megállnia, nem a kereten. A `─` U+2500 (BOX DRAWINGS LIGHT HORIZONTAL) mért
 * advance-e 1 cella (a box-drawing blokk nem ambiguous-width, ellentétben a
 * geometric-shapes-szel).
 *
 * NULLA/NEGATÍV SZÉLESSÉGRE `null`: a `repeat` dobna, és egy 0 cellás vonal
 * amúgy is csak egy néma üres sor lenne.
 *
 * (wf31/51) A `line: false` NÉMA HELYKIHAGYÁST ad a vonal helyett — a MAGASSÁG
 * változatlan (1 sor). A user kérése: "nyitott info panel esetén a felső separator
 * se kell, persze helykihagyás igen, layout jump ne legyen. Csak sok a vonal az
 * info panel keretével együtt."
 *
 * A KETTŐ SZÉTVÁLASZTÁSA LOAD-BEARING: ha a vonal egyszerűen ELMARADNA, a fa egy
 * sorral rövidebb lenne, és a lista a panel nyitásakor EGY SORT FELJEBB UGRANA — a
 * felső elválasztó a lista FÖLÖTT áll, tehát a hiánya mindent eltol. A helyfoglaló
 * sor pontosan ezt szünteti meg: a vonal eltűnik, a hely marad.
 *
 * EGY SZÓKÖZ, NEM `w` DARAB: a sor MAGASSÁGA a lényeg (1), a szélessége nem — egy
 * `w` cellás szóköz-sor ugyanannyit ér, csak több bájt a kimeneten.
 */
function tableSeparator(width, key, { line = true } = {}) {
  const w = Math.max(0, Math.floor(Number(width) || 0))
  if (w <= 0) return null
  return h(Text, { key, dimColor: true }, line ? '─'.repeat(w) : ' ')
}

// --- (wf32) A HUNK-ZÁRÁS UTÁNI SHELL-EN-RAGADÁS GYÖKÉROKA ÉS A JAVÍTÁS ------
//
// A JELENSÉG (a user leletéből, tmux-ban MÉRVE, `stty -f <tty> -a` + `sample`/
// `lldb` a folyamaton): a `d`→hunk→`q` váltás UTÁN a képernyő HOL azonnal
// visszatér, HOL a SHELL PROMPTJÁN ragad (`alternate_on=0`), és a lista csak
// egy KÉSŐBBI billentyűnyomásra (bármelyik) jelenik meg — FRISSÍTETT tartalommal,
// ami azt mutatja, hogy a TUI process a teljes idő alatt ÉLT, csak a képernyő
// hazudott. Ez NEM render-hiba: mérve (`stty -f <tty> -a` 10ms-es pollal a `q`
// után) a terminál `icanon` (cooked) módban maradt, miközben az Inknek RAW
// módba kellett volna visszaállítania.
//
// A GYÖKÉROK (izolált, Ink NÉLKÜLI reprodukcióval bizonyítva — lásd a
// tmux-os mérési jegyzőkönyvet a PR leírásában): a `hunk` gyerek `stdio:
// 'inherit'`-tel fut, tehát a mi stdin fd 0-nkat is örökli. Az Ink `App.js`
// `pauseInput()`-ja a hunk indítása előtt leválasztja a saját `'readable'`
// listenerét és `unref()`-eli a streamet — ez JS-szinten helyes, de a libuv
// `uv_tty_t` handle a KORÁBBI, raw-mode alatt aktívan olvasó `read()` syscallt
// NEM tudja megszakítani (ismert libuv-korlát, lásd libuv/libuv#982: "Calling
// uv_read_stop on stdin tty causes EOF to never be read"). A szál emiatt EGY
// SZINKRON, BLOKKOLÓ `read()`-ben marad a mi stdin fd-nkön — és amíg ott van,
// a Node event loop NEM tudja feldolgozni a hunk gyerekének halálát jelző
// SIGCHLD-et sem: a `child.on('close', …)` (amire az `openReviewView` vár)
// ELAKAD, sokszor MÁSODPERCEKIG, akár DESZERC-EKIG. Az Ink `endSuspend()`-je
// (ami `resumeInput()`-tal raw módba állítaná vissza a terminált) csak EZUTÁN
// futhat — tehát a terminál cooked marad, amíg valamilyen BEMENET (egy
// véletlen billentyű, akár a KÖVETKEZŐ `d`) fel nem oldja a blokkolást. Ez
// magyarázza a nem-determinisztikus tünetet is: a `sample`/`lldb` a folyamaton
// `uv__stream_io → read` naiv (libsystem_kernel.dylib) hívást mutatott, DE egy
// `setInterval`-tickerrel bizonyítva az event loop NEM blokkolt egészben —
// csak addig a pillanatig, amíg a `q` után a fő szál BELÉPETT ebbe a blokkoló
// olvasásba, és onnantól SEMMI (timer, watchdog, poll) nem futhatott, amíg
// bemenet nem jött.
//
// A JAVÍTÁS: mivel a blokkoló `read()` STREAM-SZINTRŐL NEM VISSZAVONHATÓ
// (mérve: `stdin.pause()`/`unref()`/`removeListener()` semelyik kombinációja
// nem oldja fel a MÁR olvasásban lévő régi targetet) — csak a `stdin.destroy()`
// a SPAWN ELŐTT, majd egy FRISS `tty.ReadStream(0)` a gyerek `close`-ja UTÁN
// (lásd a `destroyOldTarget`/`attachFreshTarget` fejét — a KÉT LÉPÉS SZÉTVÁLÁSA
// és az időzítésük maga is MÉRT, két külön hibaosztályt elkerülő döntés).
// KÖZVETLEN natív `stty`-méréssel igazoltuk: a régi, destroyed streamen
// hívott `setRawMode(true)` a JS-oldali `isRaw` flaget HAZUG módon állítja
// `true`-ra, a NATÍV terminálmódot nem érinti — ezért kell VALÓBAN friss
// stream, nem a régi objektum "megjavítása".
//
// AZ INK-INTEGRÁCIÓ: az Ink `render()` a `process.stdin`-t EGYSZER, INDULÁSKOR
// zárja be az `Instance.options.stdin`-be (lásd `ink/build/render.js`), és
// nincs publikus API a futásidejű cserére — az `App.js` `pauseInput`/
// `resumeInput` callback-jei is ugyanerre a LEZÁRT referenciára hivatkoznak.
// Egy teljes `unmount()`+friss-`render()` minden `d`/`q` váltásnál MEGOLDANÁ
// (egy új Instance friss `process.stdin`-t olvasna be), de ez a TELJES React
// state elvesztésével járna (kurzor, notice, panel, cache — lásd az App state
// felsorolását fentebb) minden egyes hunk-megnyitásnál — elfogadhatatlan ár.
//
// A DELEGATINGSTDIN A KÖZÉPÚT: az `App.js` a stdin-en PONTOSAN NYOLC dolgot
// hív (ellenőrizve a forrásban): `isTTY` (olvasás), `addListener('readable',
// …)`, `removeListener('readable', …)`, `read()`, `setEncoding('utf8')`,
// `setRawMode(bool)`, `ref()`, `unref()`. Ez egy zárt, stabil felület — a
// wrapper egy `EventEmitter`, ami ezt a nyolc hívást egy BELSŐ, CSERÉLHETŐ
// `_target` streamre delegálja, és a `_target` eseményeit (elsősorban
// `'readable'`) a MAGA emitterén továbbadja. Az Ink `render()`-nek EZT a
// wrappert adjuk stdin-ként — az Ink így SOHA nem látja a valódi
// `tty.ReadStream`-et közvetlenül, tehát a wrapper `_target`-jét bármikor
// kicserélhetjük anélkül, hogy az Ink-nek erről tudnia kellene.
//
// A CSERE KÉT LÉPÉSRE VÁLIK, ÉS AZ IDŐZÍTÉSÜK LOAD-BEARING (MÉRVE, a második
// próbálkozás bukásán — lásd az `attachFreshTarget` fejét): a `destroyOldTarget()`-nek
// A SPAWN ELŐTT kell lefutnia (miután az Ink `beginSuspend()`-je már
// leválasztotta a régi target hallgatóit), az `attachFreshTarget()`-nek pedig
// A GYEREK `close` ESEMÉNYE UTÁN, SOHA KORÁBBAN — egy friss stream a spawn
// előtt/alatt ÚJRA BEVEZETNÉ a hunk-gyerekkel közös TTY-olvasás versenyét (a
// `script -q /dev/null` PTY-izoláció felesleges kerülőútját).
class DelegatingStdin extends EventEmitter {
  constructor(initialTarget) {
    super()
    // (indulási-fagyás) A KONSTRUKTOR NEM CSATOL LISTENERT — csak eltárolja a
    // targetet. A korábbi azonnali `_attachTarget` a MODUL BETÖLTÉSEKOR
    // 'readable'-listenert tett a `process.stdin`-re, ami a streamet olvasásba
    // rántja (a listener regisztrációja maga indít natív read-et az fd 0-n).
    // Ez megcáfolta a `runTui` feltevését, hogy a `queryTerminalColors` alatt
    // "a stdin-en még senki nem olvas": a query saját `/dev/tty` olvasója és a
    // fd 0 olvasója EGYSZERRE versenyzett ugyanazért a terminál-eszközért —
    // macOS-en ráadásul a /dev/tty a libuv select-fallback szálát használja. A
    // verseny kimenetele időzítésfüggő; a vesztes ágon az input örökre elveszett
    // (a TUI kirajzolódott, de semmilyen billentyűre — Ctrl-C-re sem — reagált,
    // kb. minden 3-4. indításnál). A csatolást ezért az `engage()` végzi, a
    // query LEZÁRÁSA UTÁN, a render() előtt.
    this._target = initialTarget
    this._forwardedEvents = ['readable', 'end', 'error']
  }

  /**
   * A kezdő target TÉNYLEGES csatolása — a `runTui` hívja, a színkérdezés
   * (`queryTerminalColors`) lezárása UTÁN és a `render()` ELŐTT. Eddig a
   * pillanatig az fd 0-n GARANTÁLTAN nincs olvasónk (lásd a konstruktor
   * indoklását).
   */
  engage() {
    this._attachTarget(this._target)
  }

  _attachTarget(target) {
    this._target = target
    // MINDEN korábbi forward-listenert eltávolítunk ELŐSZÖR, különben egy
    // korábbi _attachTarget hívás (ugyanazon targetre, elvi lehetőség) duplán
    // csatolna. A `target`-en (nem a wrapperen!) törlünk — ez a mi SAJÁT,
    // belső forward-fn-jeinket távolítja, nem az App.js által csatolt
    // 'readable'-listenert (azt az App.js a WRAPPEREN, nem a targeten tartja).
    for (const ev of this._forwardedEvents) {
      target.removeListener(ev, this._forwardHandlerFor(ev))
      target.on(ev, this._forwardHandlerFor(ev))
    }
  }

  // Egy STABIL handler-referencia eseménytípusonként — a removeListener/on
  // pár csak akkor ér célt, ha ugyanazt a függvényt kapja mindkét oldalon.
  _forwardHandlerFor(ev) {
    this._handlers ??= {}
    this._handlers[ev] ??= (...args) => this.emit(ev, ...args)
    return this._handlers[ev]
  }

  /**
   * A RÉGI target DESTROY-olása — HÍVANDÓ A SPAWN ELŐTT.
   *
   * MÉRT BUG (a wf32 ELSŐ, ELÉGTELEN próbálkozásán, a `swapToFreshTarget` egy
   * korábbi, EGYBEN destroy+friss-stream alakján): a `_attachTarget` a
   * KONSTRUKTORBAN egy SAJÁT `forwardHandler`-t regisztrál a target
   * `'readable'`-jére — ez a regisztráció ÖNMAGÁBAN "readable listening" módba
   * kapcsolja a Node stream-et, FÜGGETLENÜL attól, hogy a WRAPPEREN (App.js
   * felől) van-e még aktív listener. Az `App.js` `pauseInput()`-ja a
   * `wrapper.removeListener('readable', …)`-t hívja — ez CSAK a wrapper SAJÁT
   * EventEmitter-listenerét törli, a target-en ülő `forwardHandler`-t NEM. A
   * régi target így FOLYAMATOSAN olvasásban marad, és amikor a `destroy()`
   * ide ér, a blokkoló natív `read()` MÁR folyamatban van.
   *
   * A JAVÍTÁS: MI SAJÁT MAGUNK távolítjuk el a forward-listenert a régi
   * targetről, MIELŐTT a destroy()-t hívnánk — így a régi target a destroy
   * pillanatában NEM olvas semmit (nincs 'readable'-listenere), tehát a
   * `destroy()` egy VALÓBAN idle streamet ér, nem egy már-olvasó egyet.
   *
   * FAIL-SOFT: a `destroy()` lezárt/már destroyed streamen no-op-ként dobhat —
   * ez nem buktathatja a hívót, mert a cél (a régi olvasó megszüntetése)
   * enélkül is teljesül (már destroyed).
   *
   * SZÁNDÉKOSAN NEM hoz létre itt friss target-et — lásd az `attachFreshTarget`
   * fejét: a friss stream KORÁBBI létrehozása (a gyerek FUTÁSA ALATT) egy
   * MÁSIK, MÉRT hibaosztályt hozott vissza (a wf26/wf31/19 előtti TTY-verseny:
   * a friss stream és a `stdio:'inherit'`-es hunk gyerek EGYSZERRE olvasna a
   * KÖZÖS öröklött fd-ről).
   */
  destroyOldTarget() {
    const oldTarget = this._target
    try {
      for (const ev of this._forwardedEvents) {
        oldTarget?.removeListener(ev, this._forwardHandlerFor(ev))
      }
    } catch { /* lásd a fail-soft indoklást fent */ }
    try {
      oldTarget?.destroy()
    } catch { /* lásd a fail-soft indoklást fent */ }
  }

  /**
   * EGY FRISS `tty.ReadStream(0)` csatolása — HÍVANDÓ A GYEREK `close`
   * ESEMÉNYE UTÁN, SOHA KORÁBBAN.
   *
   * MÉRT BUG (a wf32 MÁSODIK próbálkozásán, `sample`/`lldb`-vel + a
   * `forwarding event: readable` logsorral elkapva): ha a friss stream a
   * SPAWN ELŐTT jön létre, ÚJRA BEVEZETI a hunk-gyerekkel közös TTY-olvasás
   * versenyét — pontosan azt a hibaosztályt, amit a `script -q /dev/null`
   * PTY-izoláció (lásd a `reviewCommand` fejét) a hunk SAJÁT process-groupja
   * felől már megszüntetett. A friss stream a `stdio:'inherit'` miatt UGYANAZT
   * az öröklött fd-t figyelné, mint a hunk gyereke — két aktív olvasó, két
   * lehetséges nyertes, nem-determinisztikus kimenet.
   *
   * A JAVÍTÁS: a friss stream csak AKKOR jön létre, amikor a gyereknek MÁR
   * NINCS mit olvasnia a fd-ről (elment) — ez a `close` esemény utáni pillanat.
   */
  attachFreshTarget() {
    this._attachTarget(new tty.ReadStream(0))
  }

  // --- Delegált metódusok/property-k — az App.js PONTOS, zárt felülete -----
  get isTTY() { return this._target.isTTY }
  get isRaw() { return this._target.isRaw }
  get destroyed() { return this._target.destroyed }
  setRawMode(mode) { return this._target.setRawMode(mode) }
  setEncoding(enc) { return this._target.setEncoding(enc) }
  read(...args) { return this._target.read(...args) }
  ref() { return this._target.ref?.() }
  unref() { return this._target.unref?.() }
}

// MODUL-SZINTŰ SINGLETON, NEM `App`-STATE: az `openHunkView` (az `App`
// komponensen belül, `useCallback`-kel stabilizálva) és a `runTui` (a
// `render()` hívásban) EGYAZON wrapperre kell hivatkozzon — egy React-state-be
// zárt wrapper minden renderen ÚJ referenciát adna, és az Ink `render()`-nek
// ÁTADOTT stdin ettől függetlenül az INDULÁSKORI marad (lásd a modul-fejezetet:
// az Ink egyszer, lezárva olvassa ki). A `process.stdin`-nel indul: ez a
// VALÓDI kezdő target, amit a runTui a render()-nek ad.
const stdinWrapper = new DelegatingStdin(process.stdin)

// A RENDER-RÉTEG (queue-sor + a három overlay-body) A SAJÁT MODULJÁBAN ÉL:
// bin/tui-render.mjs. Az áthelyezés MECHANIKUS volt — a blokk NULLA
// App-állapotot zárt be (se hook, se setter, se ref a closure-jében), tehát a
// hook-sorrend (a React néma hibaosztálya) érintetlen.


// EXPORTÁLT, hogy a RENDER (és a billentyű-kezelés) manuálisan verifikálható
// legyen egy fake stdout/stdin fölé rendelt Ink-példánnyal. A unit-tesztek
// továbbra sem importálják ezt a modult (ink/react kellene hozzá) — a
// verifikáció külön, kézi futtatás.
/**
 * @param {object} [props]
 * @param {number} [props.pollIntervalMs] a háttér-poll TICK-ütem. Csak a
 *   TESZT-HARNESS adja meg (élesben a core POLL_INTERVAL_MS-e a mérték); egy
 *   sűrűbb tick önmagában NEM pollozik gyakrabban, mert az esedékességet a
 *   poll-állapotgép `nextDueAt`-je dönti el.
 * @param {() => number} [props.pollNow] az INJEKTÁLT ÓRA. Enélkül `Date.now()`.
 *   A tesztek ezzel skálázzák a virtuális időt, hogy a 100 s-os esedékesség és a
 *   15 perces idle-timeout valós milliszekundumok alatt elérhető legyen — valódi
 *   várakozás nélkül, a determinizmus feláldozása nélkül.
 * @param {number} [props.sessionWaitMs] a HUNK-SESSION megjelenésére való
 *   várakozás plafonja. Élesben a core defaultja (10 s); a TESZT-HARNESS ezt
 *   rövidíti, mert 10 valós másodpercet várni a timeout-ágra értelmetlen (és
 *   flaky). A VISELKEDÉS nem változik tőle: ugyanaz az állapotgép fut, csak a
 *   határ mozdul.
 * @param {number} [props.aiTimeoutMs] a HÁTTÉR-REVIEW PLAFONJA. Élesben a core
 *   `AI_REVIEW_TIMEOUT_MS`-e (30 min, a MÉRT CI-eloszlásból); a TESZT-HARNESS ezt
 *   rövidíti, mert 30 valós percet várni a timeout-ágra nem lehet. Ugyanaz a
 *   watchdog fut, csak a határ mozdul.
 * @param {number} [props.aiTickMs] a PROGRESSZ-TICK ütem (élesben 1 s). MÉRT
 *   költség: ~12 ms CPU/tick, azaz ~1.2% egy magon 1 s-os tick mellett — tehát
 *   elhanyagolható. Tesztben pár tíz ms.
 * @param {number} [props.aiFindingPollMs] a FINDING-SZÁMLÁLÓ olvasási üteme
 *   (élesben 5 s). MÉRT költség: 0.42 s / `comment list` hívás ÉLŐ hunk TUI
 *   mellett, tehát 5 s-nál ~8% duty cycle (1 s-nál 42% lenne — az sok).
 */
export function App({
  pollIntervalMs, pollNow, sessionWaitMs,
  aiTimeoutMs, aiTickMs, aiFindingPollMs,
  // (wf31/62) A RUNTIME MÉRT terminál-színek (OSC 10/4, indításkor egyszer) —
  // a fade-tween kezdőpontjai. `null`, ha a terminál nem válaszolt.
  themeColors = null,
} = {}) {
  // (wf31/42) A `waitUntilRenderFlush` az Ink SAJÁT flush-je: a belsejében
  // `reconciler.flushSyncWork()` fut, plusz megvárja a macrotask-queue-t és (concurrent
  // módban) a következő render-commitot. Ez az, amivel egy pending-jelzés
  // GARANTÁLTAN a képernyőn van, MIELŐTT a blokkoló munka elindul — a
  // `setTimeout(0)` csak reménykedik benne.
  const { exit, suspendTerminal, waitUntilRenderFlush } = useApp()
  // A NYERS queue-modell (a `queue --json` tömbje). A MEGJELENÍTENDŐ sorokat
  // ebből + a cache-állapotokból SZÁMOLJUK renderenként (lásd lentebb) — a
  // buildRows tiszta és I/O-mentes, tehát ez nem költség. A KÉT ÁLLAPOT
  // SZÉTVÁLASZTÁSA load-bearing: ha a kész sorokat tárolnánk, a cache-jelző
  // frissítéséhez a teljes queue-t kellene újratölteni (gh-hívás), és a jelző
  // pont az ellenkezőjét érné el annak, amiért készült.
  const [model, setModel] = useState([])
  const [index, setIndex] = useState(0)
  // (wf31/23) A VISSZAJELZÉS a fejléc JOBB szélén jelenik meg (a globális
  // status-sor kivezetve). Két üzenet-osztályt hordoz:
  //   · EREDMÉNY (`#895: merged (merge)`, `#904: approved`),
  //   · INPUT-VÁLASZ (`megszakítva`, `túl korai — nyomd meg újra`).
  // A PENDING NEM ide tartozik: az a legendbe került (`pendingKey`).
  const [notice, setNotice] = useState('')
  // (wf31/25) OPTIMISTA ÁLLAPOTOK: PR-szám → `'merged'` | `'approved'`.
  //
  // MIÉRT KELL (mért lelet, a user #895-ös esete): a `gh pr merge` exit 0-t adott,
  // a `reload()` LEFUTOTT, és a PR MÉGIS `● in queue`-ként maradt a listán — a
  // GitHub GraphQL-indexe aszinkron frissül, tehát a merge utáni másodpercekben a
  // `gh pr list --state open` MÉG a régi állapotot adja. Ugyanez áll az
  // approve-ra: az `✔ approved` rmark csak a következő sikeres reload után jött.
  //
  // A SAJÁT AKCIÓNK EREDMÉNYÉT ISMERJÜK (exit 0), tehát nem kérdezzük vissza attól
  // az API-tól, ami épp késik. A jelölés a `buildRows`-ba megy, ami a MARK-ot
  // (`✔ merged`) és az rmark-ot (`✔ approved`) írja felül, plusz a sort dimmeli.
  //
  // MIKOR TŰNIK EL: amikor a MODELL utolérte magát — a `reload` ág törli azokat a
  // bejegyzéseket, amiket a friss adat már tükröz (mergelt PR eltűnt a listából /
  // az approve megjelent a `reviewDecision`-ben). Így a jelölés nem ragad be, és
  // nem is hazudik tovább, mint ameddig szükséges.
  const [optimistic, setOptimistic] = useState({})
  // A BETÖLTÉS IDŐPONTJA — a fejléc mondja ki. A user kérése: "A fejlec mutassa,
  // MIKOR toltottuk utoljara." Enélkül a képernyőn álló lista nem különböztethető
  // meg a 20 perccel korábbitól, és a döntés (approve/merge) elavult képen születik.
  const [loadedAt, setLoadedAt] = useState(null)
  // A trunk (`origin/<main|dev>`) SHA: a cache-horgony másik fele. EGYSZER,
  // betöltésenként mérve (nem soronként) — lásd a fetchMainSha fejét.
  const [mainSha, setMainSha] = useState(null)
  // (wf31/44) A NEXT-REBUILD ÁLLAPOTA a fejléchez — `{ state, at }` vagy `null`.
  //
  // MIÉRT STATE, ÉS MIÉRT NEM A RENDERBEN MÉRJÜK: a `fetchRebuildStatus` egy
  // `gh run list` SPAWNSYNC, ami a render-úton FRAME-ENKÉNT futna (a fejléc minden
  // keyfelütésre, minden poll-tickre újraszámolódik) — ez a projekt kimondott
  // hibaosztálya (lásd a `fetchCoreSha` memoizálásának indoklását). A mérés ezért a
  // BETÖLTÉS útján fut, ahol a többi `gh`-hívás is.
  //
  // A `null` A NORMÁL ESET: a `fetchRebuildStatus` CSAK a nem-`success` állapotot
  // adja vissza (a jó állapotot nem hirdetjük — a user döntése).
  const [rebuild, setRebuild] = useState(null)
  // (1d) A main-SHA REF-BEN IS. MIÉRT KELL A STATE MELLETT — MÉRT BUG, ÉLŐ
  // RENDERBŐL: a `persistReview` a `doAiReview` hosszan futó, `useCallback([])`-kel
  // STABILIZÁLT ágából hívódik, ami a LÉTREHOZÁSAKOR érvényes `mainSha`-t zárja
  // be — és az akkor még `null` (a queue-betöltés utána fut le). A lemezre így
  // `mainSha: null` horgony került, ami FAIL-CLOSED módon SOSEM egyezik: a
  // bejegyzés örökre elavult volt, tehát a diszk-cache NÉMÁN nem működött. (A
  // memória-cache-t ez nem érinti: az a horgonyát RENDER-időben számolja.)
  //
  // A REF a HÍVÁS PILLANATÁBAN olvas, tehát a stabil callback is a friss értéket
  // látja — a `useCallback` dependency-listájának felnyitása helyett, ami a
  // review-t futás közben újra-létrehozná.
  const mainShaRef = React.useRef(null)
  useEffect(() => { mainShaRef.current = mainSha }, [mainSha])
  // A MÉRÉS-CACHE. `useRef`, NEM state: a bejegyzés írása NEM renderel újra
  // magától (a mérés-esemény amúgy is renderel az `info` state-en keresztül), és
  // egy state-be tett Map minden írásnál új referenciát kívánna. A RENDER a
  // `cacheVersion`-ből tudja, hogy változott — így a jelző frissül, de a
  // cache-írás nem indít render-vihart.
  const cache = React.useRef(createCache())
  const [cacheVersion, setCacheVersion] = useState(0)
  const bumpCache = useCallback(() => setCacheVersion((v) => v + 1), [])

  // --- (1d) A REVIEW-EREDMÉNYEK DISZK-CACHE-E -------------------------------
  //
  // A USER KÉRÉSE: "a review-kat cache-elje diszkre az app, mert fárasztó
  // mindig újraindítani." A memória-cache a TUI-val együtt meghal, tehát egy
  // újraindítás után a KIFIZETETT (tokenbe került) findingok elvesztek — pontosan
  // ezt a veszteséget szünteti meg ez a réteg.
  //
  // A PERZISZTÁLÁS EGY HELYEN (`persistReview`), nem a hívási helyeken szétszórva:
  // a findings-tárolásnak KÉT ága van (élő hunk-session / answer-only), és a
  // horgony-összeállítást mindkettőben megismételni pontosan az a duplikáció,
  // amiből az egyik ág lemarad. A törlés (`forgetReview`) ugyanígy egy helyen.
  //
  // FAIL-SOFT: a store `false`/`null`-t ad hibára, és MI SEM jelzünk a UI-ba. A
  // review eredménye a memóriában MEGVAN — egy "/tmp nem írható" hibaüzenet a
  // kifizetett eredmény MELLETT csak zaj, cselekvési lehetőség nélkül.
  const persistReview = useCallback((row, findings, summary) => {
    if (!Array.isArray(findings) || findings.length === 0) return
    try {
      reviewStoreWrite({
        repoRoot: fetchRepoRoot(),
        pr: row.number,
        // A HORGONY HÁROM FELE: a PR updatedAt-je, a main SHA (a memória-cache
        // már ezt használja) és a CORE SHA — más kód más sémát adhat.
        // A main-SHA a REF-BŐL (a hívás pillanatában), NEM a bezárt state-ből —
        // lásd a mainShaRef fejét: a stabil `doAiReview` callback a `null`
        // kezdőértéket zárta be, és a horgony fail-closed módon SOSEM egyezett.
        anchor: reviewStoreAnchor({ row, mainSha: mainShaRef.current, coreSha: fetchCoreSha() }),
        findings,
        summary: typeof summary === 'string' ? summary : null,
      })
    } catch {
      // A `fetchRepoRoot` DOBHAT (nem-git cwd). A perzisztálás kedvéért nem
      // veszíthetjük el a futást — a memória-cache-ben minden megvan.
    }
  }, [])

  // --- A LEMEZRŐL VISSZAÁLLÍTOTT REVIEW-K KÍSÉRŐ ADATA ----------------------
  //
  // PR-szám → `{ summary, toolDrift }`. KÉT dolgot hordoz, és MINDKETTŐ a user
  // ugyanazon leletéből ("a 904-es review-ja nincs betöltve a TUI-ban") jön —
  // mert a lelet HÁROM külön hibából állt össze, nem egyből:
  //
  //   1) A `coreSha` BLOKKOLTA a betöltést (a store-ban javítva: `tool-drift`).
  //   2) A hidratálás `aiReview` STATE-ET NEM ÍRT, tehát a PR-panel review-
  //      szekciója ÜRES maradt. A findingok a memória-cache-ben ott voltak (az
  //      `r: elvetés` címke és a lista-glif ezt mutatta is), de a user a
  //      PANELBEN keresi a review-t — és ott az előző futásból SEMMI nem látszott.
  //   3) A store `summary`-ja (a VERDICT) ELVESZETT: a memória-cache
  //      (`cacheStoreAiFindings`) csak a findingokat tárolja, summary-t nem.
  //      Egy újraindítás így a review LEGÉRTÉKESEBB részét dobta el csendben.
  //
  // A `summary` TEHÁT NEM DEKORÁCIÓ: a `done`/`done-answer` panel az összegzőt a
  // findingok FÖLÉ írja, mert "a findingok listája NEM verdict"
  // (`aiReviewPanelLines` wf24/2). Enélkül a visszaállított review a
  // következtetés nélküli nyers lista lenne.
  //
  // MIÉRT STATE, ÉS NEM A `cache` REF-BEN: ez RENDER-BEMENET (a panel olvassa),
  // tehát a beállításának RENDERT KELL okoznia. A `cache` ref szándékosan nem
  // renderel magától (a `bumpCache` teszi) — egy ott tárolt flag a hidratálás
  // pillanatában a MÁR LEFUTOTT renderből maradna ki, és csak a következő,
  // VÉLETLEN renderen jelenne meg. A `bumpCache`-re akasztani pedig azt
  // jelentené, hogy a jelzés a cache-verzió mellékhatásán lóg — ugyanaz a
  // doktrína, ami a `cacheVersion`/`aiFindings` szétválasztásában áll.
  //
  // MIÉRT PR-RA KULCSOLT OBJEKTUM, ÉS NEM EGY MAP: az objektum-literál
  // `useState`-tel együtt IMMUTÁBILIS frissítést ad (új referencia → render),
  // amit egy Map mutálása nem — egy `map.set()` NEM renderelne, és pont a fenti
  // hibaosztályba futnánk vissza.
  const [restoredReviews, setRestoredReviews] = useState({})

  const forgetReview = useCallback((pr) => {
    // AZ ELVETÉS A LEMEZRŐL IS TÖRÖL: különben a következő indításban a user
    // explicit döntése (dupla-`x`) némán visszafordulna, és az elvetett
    // findingok visszatérnének.
    try {
      reviewStoreDelete({ repoRoot: fetchRepoRoot(), pr })
    } catch { /* fail-soft: lásd a persistReview-t */ }
    // A VISSZAÁLLÍTÁS-KÍSÉRŐ IS MEGY: elvetett review-ról nincs mit mutatni, és
    // egy ottmaradt bejegyzés a KÖVETKEZŐ (frissen futtatott) review panelére
    // vinne át egy IDEGEN összegzőt és egy hazug "más core-verzió mérte" caveatet.
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
   * A MEGERŐSÍTŐ MODÁL megnyitása — EGYETLEN úton, minden akcióhoz.
   *
   * MIÉRT EGY HELYEN: a régi kódban NÉGY `setConfirm({...})` hívás állt szét
   * (approve / merge / upload / ai-review), és mindegyik maga vette fel az
   * `armedAt`-ot ÉS maga döntötte el, mit tesz a nyitott info-panellel. A
   * dwell-kapu (confirmAccepts) így négy helyen élt-halt, és egy elfelejtett
   * `armedAt` NÉMÁN kikapcsolta volna a typeahead-védelmet azon az egy ágon.
   *
   * A `panelToModal` MEGTARTJA a `row`-t ÉS a `progress`-t: ha a modál egy nyitott
   * INFO-panelről nyílik, az Esc VISSZALÉP a panelre, és a mért diagnózis nem
   * veszik el. Ha nem volt panel (a listáról nyílt), a `panelOpen` most nyit egyet
   * — így az Esc ott is a PANELRE visz, tehát a "megnézem → cselekszem →
   * visszanézem" kör EGY helyen zárul, ahogy a user kérte.
   *
   * A VÁLASZTÁS-INDEX NULLÁZÓDIK: minden új döntés a NEM-en (fail-closed) indul.
   * Enélkül egy előző modálban "Igen"-re állított kurzor átvándorolna a
   * következőre — pontosan az a fajta ragadós állapot, ami egy visszavonhatatlan
   * akciónál megengedhetetlen.
   */
  const openModal = useCallback((row, modalProps) => {
    setChoiceIndex(0)
    setPanel((cur) => panelToModal(cur ?? panelOpen({ row }), { armedAt: Date.now(), ...modalProps }))
  }, [])

  /**
   * A NYITOTT MODÁL részleges frissítése (budget-váltás, review-út-léptetés).
   *
   * Az `armedAt`-hoz SZÁNDÉKOSAN NEM nyúlunk: ezek a gesztusok se megerősítést, se
   * megszakítást nem jelentenek, tehát a dwell-kapu nem indulhat újra. Ha
   * armolnának, a plafon/út nyomkodásával a 250 ms-os védelem VÉGTELENÜL
   * újraindítható lenne — a typeahead-kapu kikerülhetővé válna pont azon az úton,
   * ami a leginkább token-költő (AI-review).
   */
  const patchModal = useCallback((patch) => {
    setPanel((cur) => (cur?.mode === 'modal' ? { ...cur, modal: { ...cur.modal, ...patch } } : cur))
  }, [])

  /**
   * A queue újratöltése. A `hard` út (az `R` billentyű) a cache-t IS
   * invalidálja; a puha út (egy akció utáni reload) NEM — az akció (approve /
   * merge / findings-feltöltés) nem mozdítja el a merge-tree próbák eredményét,
   * és egy néma cache-dobás minden approve után újramérést kényszerítene, azaz
   * pontosan azt a lassulást hozná vissza, amiért a cache készült.
   *
   * A MAIN-SHA MINDEN BETÖLTÉSSEL frissül: ha a main elmozdult, a horgony
   * elmozdul, tehát a MEGLÉVŐ bejegyzések ELAVULTTÁ válnak — törlés nélkül, mert
   * a listán jelezni kell, hogy VAN mért eredmény, csak már nem érvényes.
   */
  const reload = useCallback(({ hard = false } = {}) => {
    try {
      const fresh = fetchQueue()
      // A SORREND load-bearing: a cache-invalidálás a modell beállítása ELŐTT
      // fut, különben egy render még a régi (immár érvénytelen) bejegyzéseket
      // "friss"-nek látná az új horgonnyal.
      if (hard) cacheInvalidateAll(cache.current)
      const sha = fetchMainSha()
      setMainSha(sha)
      // A REBUILD-ÁLLAPOT ugyanazon a betöltés-úton mérve, mint a main-SHA. A
      // `fetchRebuildStatus` FAIL-SOFT (`null` mindenre, ami nem mérhető), tehát
      // nincs try/catch: egy rebuild-státusz nem buktathatja a queue betöltését.
      setRebuild(fetchRebuildStatus())
      setModel(fresh)
      setLoadedAt(new Date())
      bumpCache()
      // (wf31/25) AZ OPTIMISTA JELÖLÉSEK TAKARÍTÁSA — amit a friss modell MÁR
      // tükröz, az itt kiesik. Enélkül a jelölés BERAGADNA: egy `approved`
      // optimista bejegyzés örökre felülírná az rmark-ot, akkor is, ha a review-t
      // közben visszavonták.
      //
      // A KÉT ÁLLAPOT MÁSKÉNT ÉR CÉLT, ezért két külön feltétel:
      //   · `merged` — a PR ELTŰNT a nyitott listából (ez a cél; a modell utolérte);
      //   · `approved` — a `reviewDecision` MEGJÖTT `APPROVED`-ként.
      // Ami MÉG NEM teljesült, az MARAD — a következő reload újra megvizsgálja.
      setOptimistic((cur) => {
        const keys = Object.keys(cur)
        if (keys.length === 0) return cur
        const byNumber = new Map(fresh.map((r) => [r.number, r]))
        const next = {}
        for (const k of keys) {
          const row = byNumber.get(Number(k))
          if (cur[k] === 'merged') {
            // A sor MÉG ott van → a jelölés kell. Ha eltűnt, a jelölésnek sincs
            // már mit felülírnia.
            if (row !== undefined) next[k] = 'merged'
          } else if (cur[k] === 'approved') {
            // A modell MÉG nem tud az approve-ról → tartjuk. Ha már tud (vagy a
            // sor eltűnt), elengedjük.
            if (row !== undefined && row.reviewDecision !== 'APPROVED') next[k] = 'approved'
          }
        }
        // AZONOS TARTALOMRA UGYANAZ A REFERENCIA: a `buildRows` memo-ja az
        // `optimistic`-ra is figyel, és egy új (de egyező) objektum minden
        // reloadnál újraszámolná a teljes sor-listát.
        return keys.length === Object.keys(next).length ? cur : next
      })
      // A POLL BÁZISA ÚJRAINDUL: a korábbi elavultság-jelzés MEGSZŰNIK — a user
      // épp azt tette meg, amit a jelzés kért. Egy megmaradó jelzés a frissítés
      // után azt tanítaná, hogy a jelzés hazudik, és a user leszokna róla.
      //
      // A BÁZIS A PRÓBÁVAL AZONOS ÚTON készül (`fetchStalenessProbe`), NEM a
      // frissen betöltött `queue --json` modellből.
      //
      // MIÉRT — MÉRT BUG, ÉLŐ RENDERBŐL: az első változat a bázist a queue
      // modelljéből számolta ("ingyen van, a mezők már megvannak"). Csakhogy a
      // KÉT FORRÁS KÜLÖNBÖZHET: a `queue --json` a maga szűrésével és
      // időpontjában olvas, a poll a saját `gh pr list`-jével a magáéban. Ha a
      // kettő aláírása eltér (mert időközben tényleg változott valami, vagy mert
      // a két lekérés más pillanatot lát), akkor az `R` utáni ELSŐ tick AZONNAL
      // "elmozdulást" észlelt — a jelzés visszajött, és SOHA nem lehetett
      // eltüntetni. Élő renderben ez pontosan így viselkedett: `R` után a
      // fejlécben ott maradt az "⟳ elavult", vagyis egy hazug, örökké villogó
      // figyelmeztetés — az a hibaosztály, amit ez a feature megszüntetni akart.
      //
      // A KÖLTSÉG (mért ~550 ms) TUDATOSAN VÁLLALT, és nem a UI útjában van: a
      // `queue --json` maga ~1.8 s, tehát a bázis-próba a betöltés ~30%-a, és
      // KIZÁRÓLAG a betöltéskor fut (nem renderenként). Az alternatíva — két
      // különböző forrásból vett aláírás összehasonlítása — nem
      // teljesítmény-kérdés, hanem HELYESSÉGI: eltérő forrásokat nem lehet
      // egymáshoz mérni.
      const base = fetchStalenessProbe()
      poll.current = pollInit({
        now: now(),
        // A próba HIBÁJA esetén `null` a bázis: a `stalenessChanged`
        // fail-closed a hamis pozitív ellen (nincs mihez mérni → nincs
        // "elavult"), a következő SIKERES próba pedig felveszi a bázist. Így egy
        // pillanatnyi hálózati hiba a betöltéskor NEM okoz hamis jelzést.
        signature: base.ok ? base.signature : null,
      })
      setPollLabel('')
      setNotice(`${fresh.length} PR a queue-ban${hard ? ' (refresh: a cache invalidálva)' : ''}`)
    } catch (error) {
      // A queue-betöltés hibája NEM sor-specifikus (nincs mit kiválasztani), de
      // overlay-t akkor is kap: enélkül a TUI üres listát mutatna magyarázat
      // nélkül, ami "nincs PR"-nak olvasható — hazug csend egy fail helyén.
      showError(null, `a queue nem tölthető be: ${error.message}`)
    }
  }, [bumpCache, showError, now])

  /**
   * A PUHA újratöltés HÁTTÉR-változata — a hunk-nézet zárása utáni út (5/2).
   *
   * MIÉRT KÜLÖN ÚT (a user 5. futásának 2. lelete, MÉRVE timestampelt
   * spawn-naplóval, éles költség-projekcióval): a `q` utáni reload() a
   * runExclusive-on BELÜL, spawnSync-ként futott — queue --json ~1.9 s +
   * git rev-parse ~60 ms + gh pr list staleness-próba ~0.55 s —, tehát az app
   * ~2.5 másodpercig "dolgozom…"-ot mutatott és SÜKET volt (az event loop is
   * állt: a leütött gomb a busy-guardon halt el). A szerződés: a nézet zárása
   * után a UI AZONNAL él, a friss queue a háttérben ér be.
   *
   * UGYANAZOKAT az állapotokat írja, mint a reload() puha útja (modell, main-SHA,
   * cache-verzió, poll-bázis, status) — a `hard` ág itt nincs: ez az út mindig
   * akció utáni puha frissítés. A hibakezelés is a reload()-é: overlay, nem dobás.
   */
  const reloadAsync = useCallback(async () => {
    try {
      const fresh = await fetchQueueAsync()
      const sha = await fetchMainShaAsync()
      setMainSha(sha)
      // A REBUILD-ÁLLAPOT ugyanazon a betöltés-úton mérve, mint a main-SHA. A
      // `fetchRebuildStatus` FAIL-SOFT (`null` mindenre, ami nem mérhető), tehát
      // nincs try/catch: egy rebuild-státusz nem buktathatja a queue betöltését.
      setRebuild(fetchRebuildStatus())
      setModel(fresh)
      setLoadedAt(new Date())
      bumpCache()
      // A POLL BÁZISA itt is a PRÓBA útján készül (nem a queue-modellből) —
      // ugyanaz az elv és ugyanaz a mért hibaosztály, mint a reload()-ban.
      const base = await fetchStalenessProbeAsync()
      poll.current = pollInit({
        now: now(),
        signature: base.ok ? base.signature : null,
      })
      setPollLabel('')
      setNotice(`${fresh.length} PR a queue-ban`)
    } catch (error) {
      showError(null, `a queue nem tölthető be: ${error.message}`)
    }
  }, [bumpCache, showError, now])

  useEffect(() => { reload() }, [reload])

  // --- (1d) A DISZK-CACHE LAZY HIDRATÁLÁSA (EGYSZER, indításkor) ------------
  //
  // MIKOR: a queue MEGÉRKEZÉSE UTÁN, mert a horgony-összevetéshez a PR
  // `updatedAt`-je KELL — az pedig a queue-ból jön. A `mainSha` ugyanabban a
  // betöltésben áll be.
  //
  // MIÉRT EGYSZER (`hydratedRef`): a lemez-olvasás I/O. A `model`/`mainSha`
  // MINDEN újratöltéskor (`R`, akció utáni puha reload) változik, tehát
  // dependencyként minden refresh újraolvasná a /tmp-t — a lemezen viszont
  // semmi nem változott közben (MI írjuk, és arról a memória-cache már tud).
  // A hidratálás a session INDULÁSÁRÓL szól: "mit hoztunk magunkkal a korábbi
  // futásokból".
  //
  // A TÁRGY-HORGONY EGYEZÉSE KÖTELEZŐ, A SZERSZÁM-HORGONYÉ NEM (a review-store
  // fejlécének rangsora): a `stale` (elmozdult diff) bejegyzést NEM töltjük be —
  // a review a PR egy MÁS állapotáról szólt, tehát findingként HAMIS állítás
  // lenne a mostani kódról. A `tool-drift` (ugyanaz a diff, MÁS core-verzió
  // mérte) VISZONT BETÖLTŐDIK, fenntartással megjelölve.
  // (A store az elavult fájlt is megtartja; a `~`-jelzős jövőbeli használatnak
  // megvan az adata, de a betöltés-út tiszta marad.)
  const hydratedRef = React.useRef(false)
  useEffect(() => {
    if (hydratedRef.current) return
    // A queue-ra VÁRUNK: üres modellel a horgonyt nem tudnánk összevetni, és egy
    // horgony nélküli betöltés pont az elavult-findings hibát csinálná.
    if (loadedAt === null || model.length === 0) return
    hydratedRef.current = true
    try {
      const stored = reviewStoreLoadAll({ repoRoot: fetchRepoRoot() })
      const coreSha = fetchCoreSha()
      let restored = 0
      // A VISSZAÁLLÍTOTTAK KÍSÉRŐ ADATA: az összegző (verdict) és a
      // szerszám-drift jelzése, PR-ra kulcsolva — lásd a `restoredReviews` fejét.
      const carried = {}
      for (const row of model) {
        const entry = stored[row.number]
        if (!entry || !Array.isArray(entry.findings) || entry.findings.length === 0) continue
        const anchor = reviewStoreAnchor({ row, mainSha, coreSha })
        const state = reviewStoreEntryState(entry, anchor)
        // A DÖNTÉS A KÖZPONTI LEKÉPEZÉSEN megy át (`reviewStoreStateLoadable`),
        // NEM egy itteni `!== 'fresh'`-en. MÉRT HIBAOSZTÁLY: pontosan egy ilyen
        // szigorú egyenlőség tette a `tool-drift`-tel egyenértékű core-eltérést
        // néma betöltés-tilalommá — a user #904-es lelete. Egy jövőbeli negyedik
        // állapot ugyanígy némán a tiltó ágra esne.
        if (!reviewStoreStateLoadable(state)) continue
        // AZ ÖSSZEGZŐ ÉS A DRIFT-JELZÉS EGYÜTT UTAZIK. A `summary` a store-ból
        // jön (a memória-cache nem tárol summary-t), a `toolDrift` az állapotból.
        carried[row.number] = {
          summary: typeof entry.summary === 'string' && entry.summary.trim() !== ''
            ? entry.summary
            : null,
          toolDrift: state === 'tool-drift',
        }
        // A MEMÓRIA-CACHE-BE kerül, `applied: false`-szal (a store sosem ad
        // mást): innentől a MEGLÉVŐ életciklus viszi — az `r` "review
        // megnyitása"-t hirdet, és a megnyitás a session-identitáshoz kötött
        // logikán betölti a note-okat a hunkba.
        cacheStoreAiFindings(cache.current, row.number, entry.findings)
        // A REVIEW-NYOM IS VISSZAÁLL: a review TÉNYLEGESEN lefutott (a költés
        // megtörtént), csak egy korábbi processzben. A nyom nélkül az attesztációs
        // body a rövidebb ("nem volt review") ágra esne — az hazugság lenne.
        markReviewTrace(cache.current, row.number, 'ai')
        restored += 1
      }
      if (restored > 0) {
        bumpCache()
        // A KÍSÉRŐ ADAT a RENDER-BEMENETRE: a panel review-szekciója innen kapja
        // az összegzőt és a drift-caveatet.
        setRestoredReviews(carried)
        // (wf31/54) A VISSZAÁLLÍTÁS-NOTICE KIVEZETVE. A user lelete a fejlécről:
        // "1 cache-elt review visszaállítva (lemezről) (ebből 1 más core-verzióval
        // mérve) — szerintem ez a szöveg nem kell, too much info".
        //
        // A RÉGI INDOKLÁS ("a néma visszaállítás rosszabb, nem derül ki, mi van
        // kész") KÖZBEN ELAVULT: a visszaállított review-nyom PR-onként LÁTSZIK a
        // listában (`⊙`, a wf31/49 óta `whiteBright`-tal, jól láthatóan) — tehát a
        // user pontosan azon a soron látja, ahol dönt, nem egy globális összegben.
        // A drift-fenntartás ugyanígy a PANELBEN áll (drift-caveat), a `d`
        // útján — ott, ahol a review-t meg is nézi.
        //
        // ÉS FELÜL IS ÍRTA A JOBBAT: a queue-létszámot a betöltés/refresh útja már
        // kiírja (`N PR a queue-ban`), ez a hívás pedig UGYANAZT ismételte meg egy
        // hosszú farokkal — vagyis egy rövid, hasznos jelzést cserélt le egy
        // hosszabbra, ami a fejléc jobb szélén amúgy is degradálódni kezd.
        //
        // AMI MARAD: a `setRestoredReviews(carried)` és a `bumpCache()` — azok a
        // MŰKÖDÉS részei (a panel review-szekciója és a drift-caveat ebből él),
        // nem a szövegé.
      }
    } catch {
      // FAIL-SOFT: nem-git cwd, olvashatatlan /tmp. A TUI a memória-cache-szel
      // működik tovább, és a UI-ba NEM megy nyers hiba.
    }
  }, [loadedAt, model, mainSha, bumpCache])

  // A SOROK a nyers modellből + a cache-állapotokból SZÁMOLÓDNAK, renderenként.
  //
  // A CACHE-ÁLLAPOTOK EGY LÉPÉSBEN, a modell fölött végigmenve: PR-onként egy
  // Map-olvasás + egy horgony-összehasonlítás, TISZTÁN (se gh, se git, se hunk).
  // Ez a user 4. pontjának konkrét alakja: a jelző nem lassítja a listát, mert a
  // jelző előállítása nem I/O. A `cacheVersion` a dependency: attól frissül a
  // jelző, hogy a cache változott — nem attól, hogy újratöltjük a queue-t.
  // A SOR-SPINNER (4): amíg egy PR-on review fut, a sora 1 cellás Braille-
  // spinnert kap. A frame-index a meglévő ticker `aiTick`-je — külön timer
  // NINCS. Review nélkül a map null, tehát a flag-sáv változatlan.
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
        // (wf31/72) A FUTÓ AKCIÓ A SORHOZ KÖTVE: a hátrahagyott PR így akkor is
        // jelzi, hogy dolgozik, ha a kurzor már máshol jár. A `pendingKey` a
        // MELYIK akció, a `pendingPr` a MELYIK soron — a kettő együtt áll be és
        // együtt tűnik el a `runExclusive`-ban, tehát nem csúszhat szét.
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

  // A cím-oszlop a TERMINÁL szélességéhez igazodik: fix padding mellett keskeny
  // terminálon az Ink tördel (a sor két sorba szakad, a szeparátor összecsúszik).
  //
  // A MEZŐ NEVE `columns`, NEM `width` — MÉRT BUG: a `const { width } =
  // useWindowSize()` MINDIG undefined-ot adott (az Ink `{ columns, rows }`-t ad),
  // tehát a lenti 120-as fallback minden renderben lecsapott. Következmény: a
  // 60 oszlopos terminálon a lista degradációja SOSEM lépett működésbe (a
  // háromszor bejelentett tördelés), és az overlay kerete fixen 118 cella lett.
  // Élő Ink-renderben mérve 60/100/190 oszlopon — a statikus tesztek ezt az
  // osztályt nem fogják el, mert a hívás önmagában szintaktikailag helyes.
  // A FALLBACK itt, EGY helyen dől el: nem-TTY-n (vagy resize-közben) a columns
  // 0/undefined lehet, és egy 0-s szélesség minden oszlopot elnyelne.
  // (wf31/33) SAJÁT SZÉLESSÉG-MÉRÉS A RESIZE-EVENTBŐL.
  //
  // MIÉRT NEM ELÉG AZ INK `useWindowSize`-A ÖNMAGÁBAN: az is a `stdout` 'resize'
  // eventjére állít state-et, DE a mi számításunk a `layout.width`-en át egy
  // MÁSODIK, származtatott mértéket is használ (a tábla szélessége a tartalomból)
  // — és a kettő ugyanabban a tickben eltérhet. A `process.stdout.columns` a
  // KERNELTŐL jön (TIOCGWINSZ), tehát a resize pillanatában is érvényes, és ezt a
  // rést zárja be.
  //
  // A GLITCH MAGÁT EZ NEM OLDOTTA MEG (mérve, a user leletén) — arra az
  // `alternateScreen` a válasz, lásd a `runTui` fejét. Ez a mérés viszont
  // önmagában is helyes: a sorok az ELSŐ resize-renderben a valódi mértékkel
  // épülnek, nem egy tickkel késve.
  const [measuredSize, setMeasuredSize] = useState(() => ({ columns: process.stdout.columns || 0, rows: process.stdout.rows || 0 }))
  // (wf31/37) A RESIZE CSILLAPÍTÁSA — a szűkítés-közbeni FLICKER ellen.
  //
  // A user leletéből: "szűkítésnél wrapping flicker van, de utána helyreáll". A
  // „helyreáll" a lényeg: a VÉGÁLLAPOT helyes (a full screen mód megoldotta), a
  // flicker a KÖZBENI frame-ekből jön.
  //
  // A MECHANIZMUS: az egérhúzás alatt a terminál TUCATNYI `resize` eventet küld
  // (cellánként egyet). Mindegyikre lefut az Ink `resized`-je (törlés +
  // layout + render) ÉS a mi state-frissítésünk (újabb render). A frame-ek
  // versenyeznek: egy még ki sem íródott, amikor a következő már törölni akar —
  // és a köztes állapotokban a szélesség-mértékek egy tickre elcsúszhatnak, tehát
  // egy-egy frame TÖRDELVE jelenik meg.
  //
  // A CSILLAPÍTÁS a KÖZBENI rendereket vonja össze: a húzás alatt csak a legutolsó
  // méret számít. A `50 ms` a szokásos UI-küszöb — érzékelhetetlen késés, de egy
  // 20 eventes húzást 1-2 renderre fog össze.
  //
  // MIÉRT NEM A `useWindowSize`-ot csillapítjuk: az az INK sajátja, nem a miénk. Az
  // Ink `resized`-je amúgy is minden eventre lefut (azt nem tudjuk befolyásolni) —
  // de a MI state-frissítésünk az, ami a fa ÚJRASZÁMOLÁSÁT is kiváltja, tehát a
  // csillapítás itt a leghatásosabb.
  //
  // EGYETLEN LISTENER: a korábbi (wf31/33-as) AZONNALI frissítés KIESETT. Két
  // listener ugyanarra az eventre ELLENTMONDÁS lett volna: az azonnali ág minden
  // eventre rendert kért, tehát pontosan azt a frame-áradatot termelte, amit a
  // csillapítás megszüntetni akar.
  //
  // A KÖVETKEZMÉNY, kimondva: a resize-rés (~50 ms) alatt a `width`/`termRows` a
  // RÉGI mértéken áll, tehát a köztes frame-ek tördelhetnek. Ez TUDATOSAN
  // vállalt: a `Row`/fejléc kemény vágása (`clampCells`) ezt fel is fogja, és a
  // végállapot mindig helyes — a flicker rövidebb, mint a versengő rendereké.
  useEffect(() => {
    let timer = null
    const onResize = () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        setMeasuredSize({ columns: process.stdout.columns || 0, rows: process.stdout.rows || 0 })
      }, 50)
      // Az `unref` LOAD-BEARING: enélkül egy éppen várakozó timer a TUI kilépését
      // is késleltetné (a Node az event loopot életben tartja miatta).
      timer.unref?.()
    }
    process.stdout.on('resize', onResize)
    return () => {
      process.stdout.off('resize', onResize)
      if (timer !== null) clearTimeout(timer)
    }
  }, [])
  const { columns } = useWindowSize()
  // (wf31/28) A FALLBACK A VALÓDI TERMINÁL-SZÉLESSÉG, NEM EGY FIX 120.
  //
  // A user leletéből: "az app bár reszponzív, csak van egy kellemetlen artifact,
  // hogy a tetején a fejléc és a highlighted sor keszekuszán feltorlódik amikor
  // szűkítem a ghostty ablakát (de Terminal.app-ban is)".
  //
  // A MÉRT MECHANIZMUS: a resize alatt az Ink `useWindowSize()`-a ÁTMENETILEG
  // `0`/`undefined` columns-ot adhat (a SIGWINCH és a state-frissítés között), és
  // a régi `|| 120` fallback ilyenkor EGY HAZUG, FIX szélességet adott. Egy 70
  // cellásra szűkített ablakban tehát a fejléc és a kiemelt sor 120 cellásra
  // épült — az Ink pedig TÖRDELTE őket, ami pontosan a bejelentett „feltorlódás".
  // A hatás a kiemelés bevezetése (wf31/26) óta LÁTHATÓBB: a háttér-kitöltés a
  // hibás szélességet is kirajzolja, tehát a tördelt maradék színes csíkként ül a
  // következő sorban.
  //
  // A `process.stdout.columns` a KERNELTŐL jön (TIOCGWINSZ), tehát a resize
  // pillanatában is ÉRVÉNYES — nincs benne React-state késés. A fix `80` már csak
  // a valóban ismeretlen eset (nem-TTY) mentsvára, és ott a konzervatív (SZŰKEBB)
  // érték a helyes: egy alulmért szélesség CSONKOL, egy felülmért TÖRDEL — és a
  // tördelés a mért hibaosztály (a mark-oszlop soronként elcsúszik).
  // (wf31/33) A SZÉLESSÉG HÁROM FORRÁSBÓL, A LEGKISEBB NYER.
  //
  //   · `measuredColumns` — a SAJÁT resize-mérésünk (a kerneltől). A resize
  //     pillanatában ez a legfrissebb;
  //   · `columns` — az Ink `useWindowSize`-a. Egy tickkel késhet, de a normál
  //     (nem-resize) rendereken ez a hivatalos forrás;
  //   · `process.stdout.columns` — közvetlen mérés, ha a state-ek még üresek
  //     (első render).
  //
  // MIÉRT A LEGKISEBB: egy ALULMÉRT szélesség CSONKOL (kozmetikai), egy FELÜLMÉRT
  // viszont TÖRDEL — és a tördelés az Ink sorszám-alapú törlését csúsztatja el (ez
  // a bejelentett „feltorlódás"). A két hibairány költsége nem szimmetrikus, tehát
  // a konzervatív irányt választjuk.
  //
  // A `80` a végső mentsvár: nem-TTY-n (teszt-harness, pipe) egyik mérés sem ad
  // értéket, és egy 0-s szélesség minden oszlopot elnyelne.
  // (wf31/38) AZ AZONNALI CAP — A HUNK BEJÁRATOTT MINTÁJA.
  //
  // A user leletéből: "Megnéztem a hunkot standalone. Szűkítésnél és tágításnál is
  // késleltet, tehát teljesen jó a késleltetett megközelítés, csak a TUI-nkban
  // szűkítésnél a wrappingot kéne megakadályozni. Hunk valahogy megoldja hogy ne
  // legyen wrap flicker, csak átmeneti cap."
  //
  // A KÉT MÉRTÉK SZÉTVÁLASZTÁSA — EZ A MEGOLDÁS MAGJA:
  //   · `layoutWidth` (DEBOUNCE-OLT) — ebből épül a TÁBLA: a címoszlop büdzséje, a
  //     tail-degradáció szintje, a fejléc igazítása. Ezek ÚJRASZÁMOLÁSA drága és
  //     ugráló, ezért a csillapítás HELYES rájuk;
  //   · `capWidth` (AZONNALI) — ebből jön a VÁGÁS plafonja. Ez a fizikai korlát: ha
  //     a terminál MOST szűkebb, a sor MOST nem lóghat túl — különben a terminál
  //     tördel, és a tördelés az Ink törlés-számítását csúsztatja el (a flicker).
  //
  // MIÉRT MŰKÖDIK EZ FLICKER NÉLKÜL: szűkítéskor a cap AZONNAL csökken, tehát a
  // sorok a köztes frame-ekben is BEFÉRNEK (csonkoltan, de nem tördelve) — a
  // tábla-layout pedig 50 ms után áll rá a végleges mértékre. TÁGÍTÁSNÁL a cap
  // nagyobb lesz, de a tábla még a régi (szűkebb) mértéken van: ott a sorok
  // egyszerűen nem használják ki az új helyet, ami CSAK késleltetett
  // reszponzivitásként látszik — és a user szerint az "jó".
  //
  // A `process.stdout.columns` A KERNELTŐL jön (TIOCGWINSZ), tehát a resize
  // pillanatában is érvényes — nincs benne React-state késés. Ezért NEM state:
  // minden renderben friss, és a render amúgy is lefut az Ink `resized`-je miatt.
  const capWidth = process.stdout.columns || 0
  const widthCandidates = [measuredSize.columns, columns, process.stdout.columns]
    .filter((n) => typeof n === 'number' && n > 0)
  const width = widthCandidates.length > 0 ? Math.min(...widthCandidates) : 80
  const layout = listLayout(rows, width)

  // A VÁLASZTÓVONALAK SZÉLESSÉGE — A TÁBLA SZÉLE, FIZIKAI PLAFONNAL.
  //
  // A `layout.width` a TARTALOMBÓL számolt tábla-szél (ugyanaz a mérték, amit a
  // `Row` háttere és a fejléc `notice`-a kap), a `capWidth` pedig az AZONNALI
  // terminál-mérés. A KISEBB nyer, és ez NEM óvatosság: egy a terminálnál szélesebb
  // vonal TÖRDELNE, a tördelés pedig elcsúsztatja az Ink törlés-számítását — az a
  // resize-flicker gyökere (lásd a `Row` `terminalColumns` indoklását).
  const separatorWidth = capWidth > 0
    ? Math.min(capWidth, layout.width || capWidth)
    : layout.width

  // A LEGEND-PENDING EGYETLEN IGAZSÁGA — EGY HELYEN SZÁMOLVA. Két legend olvassa
  // (a lista lábléce és a panelé), és mindkettőnek UGYANAZT kell mutatnia;
  // külön kifejezésben a kettő szét tudna csúszni.
  const activePendingKey = busy ? pendingKey : null

  // A HUNK-SESSION MEGNYITÁSA / ÁTVÁLTÁSA — a SESSION-AFFINITÁS egyetlen útja.
  //
  // A user kérése: "nem lehetne azt, hogy saját singleton hunk sessiont tart
  // fenn a TUI?" A hunk API-jának MÉRT korlátai között ez a legtöbb:
  //
  //   - sessiont NYITNI csak a `hunk diff`/`hunk show` tud, és az INTERAKTÍV
  //     TUI-t indít (nincs `--headless`/`--detach`/`--background`), tehát a
  //     megnyitás mindig a terminál átvételével jár;
  //   - a `hunk session reload --repo … -- diff <range>` viszont KICSERÉLI az
  //     ÉLŐ session tartalmát — PR-váltásnál tehát NEM kell új hunkot indítani.
  //
  // A SORREND, AMI A SZERZŐDÉS:
  //   1. RELOAD, ha van élő session (a singleton megőrzése). Ez INGYEN van és
  //      NEM veszi át a terminált.
  //   2. Ha nincs élő (vagy ÁRVA a session — törölt repo-gyökér, halott daemon),
  //      NYITÁS: `hunk diff` a HELYES cwd-vel.
  //
  // A `wantView` dönti el, hogy a NÉZETET is meg kell-e nyitni:
  //   - a `d` (diff-review) esetén IGEN — a reload NEM hozza előtérbe a hunkot,
  //     tehát reload UTÁN is meg kell nyitni a nézetet, különben a user `d`-t
  //     nyomott és semmit nem látna;
  //   - az `r` (AI-review) session-NYITÓ útján a nézet a MELLÉKHATÁS (a session
  //     kell, nem a nézet), de a hunk nem tud nézet nélkül nyitni — tehát ott is
  //     megnyílik, és a user `q`-val zárja.
  //
  // A CWD LOAD-BEARING (ez volt a user-jelentett hiba gyökéroka): a `hunk diff`
  // a REPO GYÖKERÉBEN kell induljon, különben a session MÁS gyökérre jön létre,
  // mint amit a `hunkComments(repoRoot)` a `--repo` flaggel keres.
  const openHunkView = useCallback(async (row, { wantView, agentNotes = false }) => {
    const repoRoot = fetchRepoRoot()
    const [base, head] = fetchPrRefs(row.number)
    // 1. RELOAD: ha van élő session, azt váltjuk át — nem nyitunk újat.
    const reloaded = reloadHunkSession(repoRoot, base, head)
    // A NÉZET megnyitása. Reload UTÁN is kell, ha a user LÁTNI akarja (`d`): a
    // reload a TARTALMAT cseréli, a hunk TUI-t NEM hozza előtérbe.
    if (!reloaded || wantView) {
      // Az `agentNotes` a REVIEW-MEGNYITÁS útja (mérve: `hunk diff --agent-notes`
      // = "show agent notes by default") — az AI-kommentek azonnal látszanak.
      // (wf31/19) A TERMINÁL-MÉRET ÁTADÁSA: a gyerek SAJÁT PTY-ban fut
      // (`script -q /dev/null` — a fagyás javítása, lásd a `reviewCommand` fejét),
      // és annak a PTY-nak a mérete NEM a valódi terminálé. A hunk TUI helyes
      // rajzolásához tehát a mért méretet kell ráállítani.
      //
      // A FORRÁS a `process.stdout`, NEM a React `useWindowSize()`-a: ez a
      // callback a `suspendTerminal` útján fut, ahol az Ink épp eldobja a
      // rendereket — egy render-időben olvasott érték itt elavult lehet. A
      // `process.stdout.columns/rows` a SPAWN pillanatában érvényes igazság.
      //
      // NEM-TTY-N `null` MEGY (a `columns` ott `undefined`): a `reviewCommand`
      // ilyenkor a `stty`-előtagot ki is hagyja — kitalált méretet nem írunk be.
      const [cmd, args] = reviewCommand(row.number, base, head, {
        agentNotes,
        columns: process.stdout.columns ?? null,
        rows: process.stdout.rows ?? null,
      })
      // ASZINKRON gyerek (nem `spawnSync`): a hunk TUI a user `q`-jáig fut, és a
      // `spawnSync` addig BLOKKOLNÁ a Node event loopját — amitől a párhuzamos
      // háttér-review ELVBŐL lehetetlen lenne (mérve: a session már élt, a
      // várakozás pollja mégsem futott le újra, a claude csak a diff bezárása
      // után indult). Lásd az `openReviewView` fejét.
      // (wf26) A GYEREK SAJÁT `/dev/tty` fd-t kap (lásd `reviewSpawnOptions`
      // fejét): a `stdio: 'inherit'` mellett a Node libuv-ja BERAGADT a TTY
      // blokkoló `read()`-jébe, a hunk gyereke zombivá vált, és a TUI a nézet
      // zárása után ÖRÖKRE FAGYOTT (a user 6. futásának lelete).
      //
      // Az fd-t a `finally` MINDIG elzárja — a dobás útján is: a `d` egy
      // sessionben sokszor fut, és a szivárgás EMFILE-lel ölné meg a TUI-t.
      const spawnOpts = reviewSpawnOptions(repoRoot)
      // A NODE-PTY RELÉ BEMENETE — a `script`-es út `reviewCommand`-jából
      // (`ptyWrap`) csak a KIMENET (a `[cmd,args]` fentebb) kell, a node-pty
      // útnak a `script`-burkolat NÉLKÜLI, `bash -c`-be írható parancsra van
      // szüksége. A `reviewInnerCommand` UGYANAZT a sablon-behelyettesítést
      // futtatja, mint a `reviewCommand` — egy helyen, hogy a kettő ne
      // csúszhasson szét.
      const innerCommand = reviewInnerCommand(row.number, base, head, { agentNotes })
      // A BERAGADÁS-ŐR ÉS A VISSZAÚT SHELL-FLASH-KOMPENZÁCIÓJA KÖZÖS a KÉT
      // (node-pty / script) út között — `d`-nyomásonként csak EGYIK fut le,
      // tehát a megosztás nem duplikál semmilyen mellékhatást.
      const watchdog = makeStuckViewWatchdog(repoRoot)
      const onChildExit = () => {
        globalThis.__tuiprTrace?.('CHILD_EXIT (hunk kilepett)')
        process.stdout.write('\u001B[?1049h')
      }
      try {
        await suspendTerminal(async () => {
          // (wf31/48) A PENDING-JELZÉS ELENGEDÉSE — ITT, A CALLBACK LEGELEJÉN.
          //
          // A user lelete: "hunkról TUI-ra visszaváltáskor egy pillanatra flashel
          // még a régi pending".
          //
          // A MECHANIZMUS, az ink 7.1.1 forrásából: az `endSuspend()` az `onRender()`-t
          // hívja, az pedig a INK DOM-FÁT rajzolja (`render(this.rootNode)`) — NEM
          // futtatja újra a React komponenseket. A DOM-fát viszont a React COMMIT
          // mutálja, és a commit a suspend alatt IS lefut (csak a terminál-írás marad
          // el: `onRender` korai return `isSuspended`-en). Egy suspend alatti
          // `setState` tehát ELÉR az `endSuspend` frame-jéig — ha a React commitolni
          // tudta.
          //
          // EZÉRT ÁLL ITT, ÉS NEM A CALLBACK VÉGÉN: a hunk-session MÁSODPERCEKIG fut,
          // és a React ezalatt bőven commitol. A callback végére tett törlés a
          // commitot az `endSuspend`-del versenyezteti — az előző kör (wf31/46) pont
          // ezen bukott el.
          //
          // NINCS LÁTHATÓ KORAI ELTŰNÉS: az Ink `beginSuspend()`-je EKKOR MÁR letörölte
          // a saját frame-jét (`log.clear()`), tehát a jelzés innentől amúgy sem
          // látszik — a képernyő a hunké.
          //
          // (A wf31/47-es `pendingMuted` REF KIVEZETVE — MÉRT SAJÁT HIBA: a ref-írás
          // NEM VÁLT KI RE-RENDERT, tehát a render-időben olvasott `activePendingKey`
          // sosem számolódott újra, és a DOM változatlan maradt. A ref az `actionLock`
          // mintája, ami EVENT HANDLERBEN olvasott érték — render-időre nem vihető át.)
          globalThis.__tuiprTrace?.('CB_START (suspend callback belep)')
          setPendingKey(null)
          // (wf31/40) A SHELL-FLASH MEGSZÜNTETÉSE — AZONNAL VISSZA ALT-SCREENBE.
          //
          // A user leletéből: "TUI -> hunk váltásnál egy rövid időre a shell screen
          // jön, ezt jó lenne elkerülni."
          //
          // A MECHANIZMUS (ink 7.1.1, `beginSuspend`): a suspend `exitAlternativeScreen`-t
          // ír, tehát a PRIMARY bufferre esünk vissza — ahol a shell promptja és a
          // scrollback áll. A hunk csak EZUTÁN indul el, és lép be a MAGA
          // alt-screenjébe. A kettő között tehát a shell képe villan fel.
          //
          // A JAVÍTÁS: a callback ELSŐ dolgaként visszalépünk alt-screenbe. A hunk
          // így egy ÜRES másodlagos bufferbe indul, nem a shell képére — a villanás
          // eltűnik. A hunk saját `enterAlternativeScreen`-je ezután no-op (már ott
          // vagyunk), a kilépése pedig a `finally`-ban lévő visszaállításunkkal
          // párosul (wf31/37).
          //
          // MIÉRT NEM A SUSPEND ELŐTT: ott az Ink `beginSuspend`-je még hátra van, és
          // AZ léptetne ki — a sorrend fordítva nem működik.
          //
          // FAIL-SOFT: lezárt streamre a `write` dobhat, és egy dobás ITT a `d`
          // útját vinné el egy kozmetikai művelet miatt.
          try {
            process.stdout.write('\u001B[?1049h')
          } catch { /* a belépés hibája nem buktathatja a nézet megnyitását */ }
          // (wf31/20) A `process.stdin.pause()`/`resume()` PÁR KIVEZETVE — SAJÁT
          // HIBA VOLT, ÉS ÚJ TÜNETET OKOZOTT.
          //
          // MIÉRT KERÜLT BE (wf31/18): a fagyást akkor a szülő TTY-olvasásának
          // hittem, és a `pause()` a stream-szintű leállítás. A KÉSŐBBI MÉRÉS
          // megmutatta, hogy a valódi ok a PROCESS GROUP szintjén volt (a kernel a
          // pgrp alapján dönt) — arra a saját PTY (`script -q /dev/null`) a válasz,
          // és a `pause()` ott már NEM SZÜKSÉGES.
          //
          // MIÉRT KÁROS: az Ink `resumeInput`-ja (az `endSuspend`-ből)
          // `attachReadableListener()`-t hív, ami a `'readable'` ESEMÉNYRE
          // hallgat. Az én `resume()`-om viszont a stream-et `flowing: true`-ba
          // teszi — ott az adat a `'data'` eseményen folyik, a `'readable'` pedig
          // NEM sül el. A visszatérő TUI így NÉMÁN SÜKET maradt: a user leletében
          // a `q` után "üres screen, a lista nem renderel újra".
          //
          // A SORREND IS ROSSZ VOLT: az én `resume()`-om a callback `finally`-jában
          // fut, az Ink `resumeInput()`-ja pedig UTÁNA (az `endSuspend`-ben) —
          // tehát a saját `resume()` egy olyan állapotot állított be, amit az Ink
          // helyreállítása már nem tudott felülírni.
          //
          // A TANULSÁG, AMIÉRT EZ A KOMMENT ITT MARAD: az Ink `pauseInput`/
          // `resumeInput` párja SZIMMETRIKUS és ÖNMAGÁBAN KONZISZTENS. Aki a
          // suspend-callbackből a stdin állapotát állítja, az ELTÖRI ezt a
          // szimmetriát — a stdin kezelése a suspend alatt AZ INK DOLGA.
          //
          // (wf32) EZ A DOKTRÍNA VÁLTOZATLAN, ÉS A LENTI HÍVÁSOK NEM TÖRIK MEG: nem
          // a stdin STREAM-API-ját (pause/resume/setRawMode) hívjuk másképp, mint
          // az Ink, hanem a wrapper MÖGÖTTI target-referenciát cseréljük, amiről az
          // Ink nem is tud — az Ink továbbra is KIZÁRÓLAG a saját pause/resume
          // hívásait végzi, csak épp már MÁSIK targeten (előbb none, majd friss).
          //
          // A HÍVÁS HELYE LOAD-BEARING (lásd a `DelegatingStdin` modul-fejezetét a
          // teljes, méréssel alátámasztott indoklásért — KÉT MÉRT, EGYMÁST metsző
          // hibaosztály van itt, és a helyes időzítés KÖZÖTTÜK áll):
          //   1. `destroyOldTarget()` A SPAWN ELŐTT: az Ink `beginSuspend()`-je
          //      (fentebb már lefutott) a wrapperen keresztül MÁR leválasztotta a
          //      régi target 'readable'-listenerét — a régi targetnek tehát NINCS
          //      aktív JS-oldali olvasója, amikor mi `destroy()`-oljuk. Ha ez
          //      KÉSŐBB (a spawn UTÁN) futna, a blokkoló natív `read()` már
          //      folyamatban lenne (a gyerek FUTÁSA ALATT alakul ki).
          //   2. `attachFreshTarget()` A `close` UTÁN, NEM ELŐBB: egy friss stream
          //      KORÁBBI létrehozása (a gyerek FUTÁSA ALATT) újra bevezetné a
          //      wf26/wf31/19 előtti TTY-versenyt — a friss stream és a hunk
          //      gyereke EGYSZERRE olvasná a `stdio:'inherit'` miatt közös,
          //      öröklött fd-t.
          stdinWrapper.destroyOldTarget()
          // (wf31/16) A BERAGADÁS-ŐR MEGMARAD: ha a hunk processz FUT, de a
          // session a türelmi időn belül NEM jelenik meg, az őr lezárja a nézetet
          // — a teljes terminál befagyása helyett hangos hibát kapunk. Ez a TÜNET
          // biztosítéka; az OKOT a saját PTY oldja meg (`script`-es úton IS, a
          // node-pty-n IS — lásd az `openReviewViaPty` fejét).
          //
          // (wf31/48) A VISSZAÚT SHELL-FLASHE — EZ VOLT A ~40 ms-os ablak, amit az
          // `onChildExit` a LEHETŐ LEGKORÁBBAN kompenzált (a `close`/`exit` közti
          // rés). A node-pty úton ez a kompenzáció már csak BIZTOSÍTÉK: a
          // `openReviewViaPty` a `?1049l`-t magát visszatartja, tehát a terminál
          // ELVBŐL sosem esik vissza a primary bufferre — a `script`-es úton
          // (fallback) viszont VÁLTOZATLANUL ez az elsődleges védelem.
          //
          // AZ ELSŐBBSÉG a node-pty-é: ha elérhető, a `?1049l`-szűrés MEGSZÜNTETI
          // (nem csak szűkíti) a shell-flash-t. A `NODE_PTY_UNAVAILABLE` a
          // FALLBACK-jel — a hívó EZT a `.code`-ot ismeri fel; minden MÁS hibát
          // TOVÁBBDOB, mert az nem "nincs node-pty", hanem VALÓDI review-hiba,
          // amit NEM szabad néma script-fallbackkel elfedni.
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
          // (wf32) A GYEREK MÁR ELMENT — a fd-n nincs több versengő olvasó, tehát
          // MOST biztonságos a friss stream csatolása. Ez a hívás LOAD-BEARING: a
          // `close` esemény MOST determinisztikusan, gyorsan jön (mérve: ~50ms),
          // mert a fenti `destroyOldTarget()` miatt a fő szál NEM ragad be egy
          // blokkoló `read()`-be a hunk futása alatt. Az Ink `endSuspend()`-je (a
          // `suspendTerminal` a callback visszatérése UTÁN, a saját `finally`-jában
          // hívja) ezért AZONNAL lefuthat, és MÁR a friss targetet találja.
          globalThis.__tuiprTrace?.('CHILD_CLOSE (promise feloldva)')
          stdinWrapper.attachFreshTarget()
          globalThis.__tuiprTrace?.('CB_RETURN (endSuspend kovetkezik)')
        })
        globalThis.__tuiprTrace?.('AFTER_SUSPEND (endSuspend lefutott)')
      } finally {
        spawnOpts.closeFds?.()
      }
    }
    return { repoRoot, reloaded }
  }, [suspendTerminal])

  // A hunk átveszi a terminált; az Ink felfüggeszti magát, majd visszatér és
  // újratölti a queue-t (a review közben változhatott a kép).
  //
  // A RE-ENTRANCIA-GUARD (`actionLock`) NEM ugyanaz, mint a `busy`, és NEM
  // váltható ki vele. MÉRT BUG, a user első jelentése ("a 'd' flow után a hunk
  // zárása után alul kiírja, hogy »dolgozom…« és az 'r' semmit nem csinál"):
  //
  //   1. a `d` `busy`-t állít és `suspendTerminal`-ba megy (a hunk fut);
  //   2. az Ink a SUSPEND ALATT ELDOBJA A RENDEREKET (ink.js: `onRender` korán
  //      visszatér, ha `isSuspended`), tehát a `useInput` closure-je a
  //      SUSPEND ELŐTTI `busy: false`-ot látja — az `if (busy) return` guard
  //      STRUKTURÁLISAN nem tud érvényesülni;
  //   3. a második akció (`d` vagy `r`) ezért LEFUT, és a második
  //      `suspendTerminal` DOB: "The terminal is already suspended."
  //      (MÉRVE, ink 7.1.1: `beginSuspend()` dob, ha `isSuspended`);
  //   4. a második hívás `finally`-ja `setBusy(false)`-t hív — MIKÖZBEN AZ ELSŐ
  //      MÉG FUT —, a `doApprove`/`doMerge` úton pedig (ahol nem volt
  //      try/finally) a `busy` VÉGLEG bent maradt: "dolgozom…" örökre, és
  //      egyetlen billentyű sem élt.
  //
  // A GUARD EZÉRT `useRef`, NEM state: a ref-írás AZONNAL látszik ugyanabban a
  // szinkron blokkban, RENDER NÉLKÜL — tehát akkor is, amikor az Ink épp
  // eldobja a rendereket. Egy state-alapú guard ugyanabba a csapdába esne.
  const actionLock = React.useRef(false)

  // A FUTÓ HÁTTÉR-REVIEW handle-je (kill-hez). `useRef`, mint a mérés-handle: nem
  // renderelünk belőle, csak abortálunk vele.
  const aiHandle = React.useRef(null)

  // (wf28/1) AZ `aiPrevDone` MENTÉS-VISSZAADÁS KIVEZETVE — MERT A VÉDENDŐ
  // INVARIÁNS MOST SZERKEZETILEG TELJESÜL.
  //
  // MI VOLT: az `askAiReview` (a menü-nyitás útja) az egy-slotos `aiReview`
  // state-et FELTÉTEL NÉLKÜL felülírta `{ status: 'starting' }`-gal. Ha a slot
  // épp egy MÁSIK PR kész (done/done-answer) review-ját hordozta, az elveszett —
  // és a done elvesztése az `r`-t ott újra INDÍTÁSSÁ tette volna, tehát egy új,
  // fizetős review indulhatott volna az explicit elvetés (dupla-`x`) friction-je
  // NÉLKÜL. Ezért a régi kód FÉLRETETTE a done-t egy refbe, és az elvetett
  // megerősítő minden kimenetén (esc / `n` / blokkoló / dobás) VISSZAADTA.
  //
  // MIÉRT NEM KELL TÖBBÉ: a wf28/1-2 javítással a menü-nyitás ÚTJA NEM ÍR
  // `aiReview` state-et (lásd az `askAiReview` fejét). Ha nem írunk, nincs mit
  // felülírni: a másik PR done-állapota HELYBEN MARAD. A mentés-visszaadás kör
  // tehát nem egyszerűsítés áldozata lett, hanem FELESLEGESSÉ vált.
  //
  // MIÉRT NEM HAGYTAM OTT "biztos, ami biztos": a ref-nek MÉRVE nem maradt
  // ÍRÓJA (az egyetlen írás az `askAiReview` törölt blokkjában volt), tehát a
  // `restoreAiPrevDone` egy ÖRÖK no-op lett volna — de nem ártalmatlan no-op:
  // a törzse `setAiReview((cur) => cur.status === 'starting' ? prev : cur)`,
  // `prev === null`-lal. Vagyis ha valaha lefutott volna egy VALÓDI, futó
  // review 'starting' fázisában (amit a `doAiReview` ír), NULLÁRA törölte volna
  // egy élő review állapotát — a #904-es "eltűnt a progressz" hibaosztály
  // visszacsempészése, csak most egy látszólag halott kódúton.

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
    // (wf31/42) A PENDING-JELZÉS MINDEN `d`-RE, ÉS GARANTÁLTAN A KÉPERNYŐN.
    //
    // A user kérése: "mivel a hunk megjelenése 1-2 mp-be telik, legyen itt is
    // pending UI, de flushSync-kel (ha van ilyen TUI-ban), tehát rendereljen ki a
    // pending UI, mielőtt elindul a folyamat".
    //
    // KÉT VÁLTOZÁS A RÉGI ALAKHOZ KÉPEST:
    //
    // (1) A JELZÉS MINDEN `d`-RE MEGY, nem csak a kész-review útján. A korábbi
    //     komment azt indokolta, hogy a sima `d`-nél "nincs mit betölteni", tehát
    //     hamis lenne a jelzés — DE a user leletе pont az, hogy a hunk MEGJELENÉSE
    //     tart 1-2 másodpercig, review-tól függetlenül. A `d` leütése után tehát
    //     MINDEN esetben van néma szakasz, amit jelezni kell. A `pendingKey`-jel a
    //     LEGEND-be írjuk (`d: diff (fut…)`), ami a kontextuális hely — nem egy
    //     globális status-sorba (az wf31/23-ban kivezetve).
    //
    // (2) A FLUSH `waitUntilRenderFlush`, NEM `setTimeout(0)`. A régi alak csak
    //     ANNYIT tett, hogy a macrotask-queue-ba került — de nem garantálta, hogy a
    //     React commitolt ÉS az Ink kiírta a frame-et. Az Ink `waitUntilRenderFlush`-a
    //     `reconciler.flushSyncWork()`-öt hív, megvárja a macrotaskot, és concurrent
    //     módban a következő render-commitot is — vagyis a jelzés BIZONYOSAN a
    //     képernyőn van, amikor a blokkoló `spawnSync`-ek (repo-gyökér,
    //     session-azonosító, `script`+hunk indítás) elindulnak.
    setBusy(true)
    setPendingKey('d')
    try {
      await waitUntilRenderFlush()
    } catch { /* fail-soft: a flush hibája nem akadályozhatja a megnyitást */ }
    // A `runExclusive` a SAJÁT `busy`/`pendingKey` párját is beállítja (ugyanezekre
    // az értékekre), és a `finally`-jában el is engedi — tehát a fenti kézi
    // beállítás NEM ragad be. MIÉRT KELL MÉGIS KÉZZEL: a `runExclusive` flush-e a
    // `fn` ELŐTT fut, de a `d` útja MÁR ELŐTTE végez blokkoló munkát (a
    // `signalsOpening` mérése és a lenti `fetchRepoRoot`), tehát a jelzésnek
    // korábban kell kimennie, mint ahová a `runExclusive` teszi.
    await runExclusive(async (release) => {
      // A JELZÉS NEM RAGADHAT BE: az `opening` átmeneti állapot, a megnyitás
      // MINDEN kimenetén (siker, hiba, dobás) vissza kell állnia a valódi
      // végállapotra. A `patch` a betöltés eredményét (offer:false + loaded)
      // hordozza, ha megtörtént — a régi `setAiReview((cur) => …)` frissítés
      // ugyanis az `opening` state-re nézve nem találná a mezőket.
      let openingPatch = null
      try {
        const pending = cacheAiFindings(cache.current, row.number)
        // A GUARD SESSION-IDENTITÁSHOZ KÖTÖTT, nem csak a PR-hoz (a user 5/3-as
        // lelete): a hunk `q`-ja a SESSIONT is elviszi, és az `applied` flag egy
        // HALOTT sessionre nézve hazug "kész"-t mondana — az újbóli megnyitás
        // ÚJ, ÜRES sessiont kapna, betöltés nélkül ("eltűnt az agent note").
        // Ezért applied mellett azt is mérjük, él-e MÉG a betöltés célsessionje;
        // ha ugyanaz él, NEM duplikálunk (a régi invariáns változatlan).
        //
        // (wf24/4) A SESSION-MÉRÉS LUSTA: a `hunkLiveSessionId` CSAK applied
        // pending mellett fut. Nem-applied (első betöltés) esetén az
        // `answerFindingsNeedApply` a liveSid-et meg sem nézi (mindig IGEN),
        // tehát a mérés tiszta latencia volt a megnyitó úton — a rövidzár már
        // korábban is ott volt a kifejezésben, de a `fetchRepoRoot()`
        // argumentum-kiértékelés ELŐTTE futott le minden hívásnál. A memoizált
        // gyökér ezt is megszünteti.
        const hasPending = pending !== null && Array.isArray(pending.findings) && pending.findings.length > 0
        const liveSid = hasPending && pending.applied === true ? hunkLiveSessionId(fetchRepoRoot()) : null
        const needApply = answerFindingsNeedApply(pending, liveSid)
        // AZ --agent-notes DÖNTÉSE: a review-megnyitás (`r` kész állapotban) az
        // EXPLICIT flaget hozza; a `d` útján akkor jár, ha VAN mit betölteni
        // (needApply) — ott az AI-kommentek megjelenítése a betöltés értelme. A
        // pending-mentes `d` flag nélkül fut: bájtra a régi út, a hunk defaultja.
        const wantNotes = agentNotes === true || needApply
        if (!needApply) {
          await openHunkView(row, { wantView: true, agentNotes: wantNotes })
        } else {
          // A NÉZET nem awaitelt (a suspend a hunk teljes életére blokkol) — a
          // betöltés a session MEGJELENÉSE után, a nyitott hunk MELLETT fut.
          const root = fetchRepoRoot()
          const viewPromise = openHunkView(row, { wantView: true, agentNotes: wantNotes })
          viewPromise.catch(() => { /* a végén awaiteljük — ez csak a korai unhandled-jelzést nyomja el */ })
          const appeared = await waitForHunkSession(
            root,
            sessionWaitMs === undefined ? {} : { timeoutMs: sessionWaitMs },
          )
          if (appeared === true) {
            const n = applyAnswerFindings(root, pending.findings)
            // A CÉLSESSION azonosítója IS rögzül: a következő megnyitás ebből
            // dönti el, hogy a note-ok még ott vannak-e (session-identitás-guard).
            cacheMarkAiFindingsLoaded(cache.current, row.number, hunkLiveSessionId(root))
            bumpCache()
            // Az ajánlat TELJESÜLT: a panel review-szekciója már nem hirdeti.
            openingPatch = { offer: false, loaded: n }
            setAiReview((cur) => (cur && cur.pr === row.number ? { ...cur, offer: false, loaded: n } : cur))
          } else if (appeared === null) {
            // (hazug-timeout-1) NEM TUDHATÓ ≠ TIMEOUT. A core szerződése
            // (waitForHunkSession) kimondja: a `null` daemon-hiba / hiányzó
            // bináris / séma-változás — itt a várakozásnak semmi értelme, és a
            // "nem jelent meg időben … újrapróbálja" permanens hibán örökké
            // ugyanazt ígérné. A nyers diagnózist adjuk, cselekvésre alkalmasan.
            showError(row,
              'a hunk-session állapota nem mérhető (daemon-hiba, hiányzó hunk bináris vagy megváltozott '
              + '`session list` séma), ezért a válasz-findingok betöltése elmaradt — a cache-ben MEGMARADTAK. '
              + 'Ez nem időzítés kérdése: előbb a hunk telepítését/daemonját hozd rendbe (`hunk session list --json`).')
          } else {
            // FAIL-CLOSED, de NEM veszteség: a findingok a cache-ben maradnak,
            // az ajánlat érvényes marad — a következő megnyitás újrapróbálja.
            showError(row,
              // (wf31/6) A MEGNYITÓ KULCS A `d` (az `r` már nem nyit) — a
              // hivatkozott kulcsnak azzal kell egyeznie, amit a lábléc hirdet.
              'a hunk-session nem jelent meg időben, ezért a válasz-findingok betöltése elmaradt — '
              + 'a cache-ben MEGMARADTAK, a következő megnyitás (`d`) újrapróbálja.')
          }
          await viewPromise
        }
        setNotice(`#${row.number}: a review-session lezárult`)
      } catch (error) {
        showError(row, `a diff-review nem futtatható: ${error.message}`)
      } finally {
        // (wf24/4) AZ `opening` JELZÉS FELOLDÁSA — a `finally`-ben, tehát a
        // DOBÁS útján is: egy beragadt "betöltés…" pontosan azt a néma,
        // reszponzivitás-hiányos élményt adná vissza, ami ellen készült.
        // A visszaállítás IDENTITÁSHOZ KÖTÖTT: ha közben a state már MÁSRA
        // váltott (más PR, új review indult), NEM írjuk vissza a régit.
        if (openingPrev !== null) {
          const patch = openingPatch
          setAiReview((cur) => (
            cur !== null && cur.pr === row.number && cur.status === 'opening'
              ? (patch === null ? openingPrev : { ...openingPrev, ...patch })
              : cur
          ))
        }
        // (5/2) A UI AZONNAL FELSZABADUL: a lock/busy elengedése UTÁN a puha
        // újratöltés a HÁTTÉRBEN fut (aszinkron gyerekek, nem spawnSync) — a
        // hunk-zárás utáni "pár másodperces dolgozom" (mérve ~2.5 s: queue
        // ~1.9 s + rev-parse + gh pr list ~0.55 s) ezzel szűnik meg.
        release()
        await reloadAsync()
      }
    // (wf31/43) A `'d'` KULCS ÁTADVA — MÉRT BUG, A SAJÁT wf31/42-ES KÖRÖMBŐL.
    //
    // A user leletе: "csak flashel a pending ui, rögtön visszaáll a status sor az
    // eredetire, mielőtt váltana hunkra".
    //
    // AZ OK: a `runExclusive` a MÁSODIK argumentumából állítja a `pendingKey`-t, és
    // kulcs nélkül hívva `setPendingKey(null)`-t ír — vagyis AZONNAL KIOLTOTTA a
    // fentebb kézzel beállított `'d'`-t. A kézi beállítás + flush kirajzolta a
    // jelzést, a `runExclusive` pedig letörölte, még a hunk indulása előtt: innen a
    // felvillanás.
    //
    // A KÉZI BEÁLLÍTÁS FENTEBB MÉGIS KELL (nem redundáns): a `runExclusive` flush-e
    // a `fn` ELŐTT fut, de a `d` útja MÁR ELŐTTE végez blokkoló munkát. A kettő
    // most UGYANARRA az értékre állít, tehát nem tud szétcsúszni — és a
    // `runExclusive` `finally`-ja az egyetlen hely, ami elengedi.
    }, 'd', row?.number)
    // Az `aiReview` a DEPS között: a wf24/4-es azonnali jelzés a MOSTANI
    // review-state-ből dönt (van-e kész review ezen a PR-on), tehát egy
    // beragadt closure a jelzést csendben elhagyná.
  }, [aiReview, bumpCache, openHunkView, reloadAsync, runExclusive, sessionWaitMs, showError, waitUntilRenderFlush])

  // A findings feltöltése: EGY review, event=COMMENT. Ez NEM approve.
  //
  // KÉT FORRÁS, KÖTÖTT SORRENDBEN: a hunk-session agent-kommentjei ELSŐ, a
  // cache-elt review-findingok FALLBACK. A user döntése, szó szerint: "ha van
  // hunk anyag, akkor az menjen feltöltésre, egyébként fallback a json-re. A
  // review csak helper, nem audit gate. Ez egy kényelmi tool." A részletes
  // indoklás (miért a hunk az első, és mikor esünk fallbackre) a
  // forrás-választás helyén áll.
  //
  // AZ ATTRIBÚCIÓ FORRÁSA a legutóbbi AI-review MÉRÉSE, ha UGYANARRA a PR-ra
  // futott — akkor a body `tool: "claude-p"`-t, a MÉRT modellt, a költést és a
  // generált/megtartott arányt írja. Ha nem futott AI-review (vagy más PR-ra
  // futott), a régi hunk-attribúció megy, változatlanul. A PR-egyezés
  // ellenőrzése load-bearing: egy másik PR-ról átvándorolt "claude-p" jelzés
  // hazug provenance lenne. A CACHE-BŐL feltöltött úton egy HARMADIK ág visz
  // AI-provenance-t a MÉRT mezők nélkül — lásd ott.
  const doUpload = useCallback((row) => runExclusive(async () => {
    try {
      // A GYÖKÉR-MÉRÉS a KÖZÖS úton (fetchRepoRoot): korábban itt egy MÁSOLT
      // `git rev-parse --show-toplevel` állt, és pontosan a másolás miatt
      // maradt ki a `d` útjáról (ott cwd sem volt) — ez a duplikáció szülte a
      // session-elcsúszást.
      const repoRoot = fetchRepoRoot()
      // A FORRÁS-VÁLASZTÁS: HUNK ELSŐ, CACHE MÁSODIK.
      //
      // A USER DÖNTÉSE, szó szerint: "ha van hunk anyag, akkor az menjen
      // feltöltésre, egyébként fallback a json-re. A review csak helper, nem
      // audit gate. Ez egy kényelmi tool."
      //
      // MI VOLT A HIBA (mért lelet, a user #904-es esete): a `f` KIZÁRÓLAG a
      // hunk-sessionből olvasott, és élő session nélkül azt állította, hogy
      // "NINCS MIT FELTÖLTENI" — miközben KÉT finding ült a cache-ben (a
      // disk-cache-ből visszaállítva). Az üzenet HAMIS volt, és a rossz irányba
      // küldött: nem a findingok hiányoztak, csak a hunkba nem kerültek be.
      //
      // A HUNK MIÉRT MARAD AZ ELSŐ (a sorrend load-bearing, nem véletlen): ha
      // ÉLŐ session van, a user MÁR dolgozott benne — törölt (`comment rm`),
      // szerkesztett, sajátot írt. Az a lista a FRISSEBB és a SZŰKEBB szándék;
      // a cache nyers halmazát fölé helyezni a user munkáját dobná el, és
      // visszahozná az általa MÁR ELVETETT findingokat. A cache tehát FALLBACK,
      // nem alternatíva.
      //
      // A `context: 'upload'` a HIBASZÖVEGET választja, ha a fallback SEM tud
      // segíteni (nincs session ÉS nincs cache) — ugyanaz a FELISMERÉS
      // (isNoActiveSession), más SZÖVEG.
      let comments = []
      let fromCache = false
      try {
        comments = hunkComments(repoRoot, { context: 'upload' })
      } catch (hunkError) {
        // CSAK A "NINCS SESSION" OSZTÁLY ESIK FALLBACKRE, minden más hiba
        // TOVÁBBDOBÓDIK. MIÉRT: egy hiányzó `hunk` bináris, daemon-crash vagy
        // parse-hiba MÁS baj — ott a cache-re csúszás ELFEDNÉ a valódi okot, és
        // a user egy telepítési hibát a findingok hiányának hinne. A
        // `isNoActiveSession` fail-closed felismerése (nem szó szerinti match)
        // pontosan erre a szétválasztásra készült.
        //
        // A FELISMERÉS A SZÖVEGEN megy, mert a `hunkComments` a hibát MÁR
        // üzenetté fordította (`noActiveSessionMessage`) — a strukturált
        // `res`-objektum ide nem jut el. A horgony a MI SAJÁT, konstans
        // mondatkezdetünk, nem a hunk verzióváltással mozgó szövege.
        if (!/nincs élő hunk-session/.test(String(hunkError.message ?? ''))) throw hunkError
        const cached = cacheAiFindings(cache.current, row.number)
        if (!cached || !Array.isArray(cached.findings) || cached.findings.length === 0) {
          // NINCS EGYIK FORRÁS SEM: az EREDETI, cselekvésre alkalmas üzenet megy
          // tovább — itt a "nincs mit feltölteni" IGAZ állítás.
          throw hunkError
        }
        // A CACHE-ELT FINDINGOK POZÍCIÓ-SÉMÁJA MÁS, MINT A HUNK-ÚTÉ, és ezt a
        // `toGithubComments` normalizálja (nem itt, mert ő a KÖZÖS fogyasztó):
        //   · hunk-út:   `{ side: 'new'|'old', line: N }`
        //   · answer-út: `{ newLine: N }` / `{ oldLine: N }`  ← a store ezt tárolja
        //
        // EZ EGY MÉRT, ÉLES BUG VOLT (a user 422-je): a `toGithubComments` csak az
        // első sémát ismerte, a cache-elt findingon a `line` `undefined` lett, és a
        // fájl-szintű ágra esve az EGÉSZ (atomikus) review elbukott — holott a
        // findingoknak VOLT pozíciója, csak más mezőnévben. A korábbi komment itt
        // azt állította, hogy a két alak azonos; nem az.
        comments = cached.findings
        fromCache = true
      }
      // AZ ÜRES (de ÉLŐ) SESSION IS FALLBACKRE ESIK. MIÉRT KELL EZ A MÁSODIK ÁG:
      // a session létezhet ANÉLKÜL, hogy a findingok bekerültek volna — pontosan
      // ez az állapot áll elő, ha a user a hunkot a cache-elt review BETÖLTÉSE
      // NÉLKÜL nyitotta meg (vagy más PR-ra nyitotta). A fenti catch-ág ilyenkor
      // NEM fut le (a `hunkComments` sikeres, csak üres listát ad), tehát a
      // fallback nélkül itt megint a hazug "nincs mit feltölteni" jönne.
      //
      // AZ ÜRESSÉG NEM SZÁNDÉK-JELZÉS: ha a user MINDENT kitörölt volna
      // (`comment rm`), az szándékos elvetés lenne — de azt a review-findingok
      // ELVETÉSE (dupla-`x`) fejezi ki, ami a cache-ből is törli őket. Egy üres
      // session MELLETT megmaradt cache tehát azt jelenti, hogy a findingok
      // sosem jutottak be, nem azt, hogy elvetették őket.
      if (comments.length === 0 && !fromCache) {
        const cached = cacheAiFindings(cache.current, row.number)
        if (cached && Array.isArray(cached.findings) && cached.findings.length > 0) {
          comments = cached.findings
          fromCache = true
        }
      }
      if (comments.length === 0) {
        setNotice('nincs inline megjegyzés a hunk sessionben — nem töltünk fel üres review-t')
        return
      }
      // A user-login sem nyelhető el némán: üres `verifiedBy` mellett a body
      // "@ verifikálta"-t írna, ami az attesztáció értelmét veszi el.
      const userRes = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' })
      const userSpawnErr = spawnFailure(userRes, 'gh')
      if (userSpawnErr) throw new Error(`a gh user-login nem kérhető le: ${userSpawnErr}`)
      if (userRes.status !== 0) {
        throw new Error(`a gh user-login nem kérhető le: ${(userRes.stderr || '').trim() || `gh exit ${userRes.status}`}`)
      }
      const user = userRes.stdout.trim()
      if (!user) throw new Error('a gh user-login üresen jött vissza — attribúció nélkül nem töltünk fel')

      const ai = aiRun && aiRun.row.number === row.number ? aiRun : null
      // AZ ATTRIBÚCIÓ A CACHE-BŐL FELTÖLTÖTT ÚTON IS AI-ATTRIBÚCIÓ — de a MÉRÉS
      // nélküli része NEM találgatható.
      //
      // MIÉRT KELL EZ AZ ÁG: az `aiRun` state a MOSTANI session mérése, ami egy
      // ÚJRAINDÍTÁS után `null` — miközben a findingok a lemezes cache-ből
      // MEGVANNAK. A puszta `ai`-ellenőrzés tehát a fallback-úton a body-t a
      // "sima hunk-attribúció" ágra vitte volna: az AI-provenance (`tool:
      // claude-p`) NÉMÁN eltűnt volna a PR-ról, holott a findingokat bizonyosan
      // az AI-review generálta (a cache CSAK onnan kap findingot).
      //
      // AMIT NEM ÍRUNK BE: `costUsd`, `sessionId`, `skill`, `aiGenerated`. Ezek a
      // FUTÁS mérései, és lemezre SOSEM kerültek — egy kitalált vagy elhagyott
      // érték itt hazug audit-adat lenne a PR body-jában. Az `aiGenerated`
      // hiánya konkrétan azt jelenti, hogy a "N/M megtartva" arány kimarad: a
      // generált darabszámot nem tudjuk, tehát nem állítjuk.
      //
      // AZ ÖSSZEGZŐ VISZONT MEGVAN: a store perzisztálja, és a `restoredReviews`
      // hordozza — a PR olvasójának ugyanolyan hasznos a verdict, mint a TUI-ban.
      const restoredMeta = restoredReviews[row.number]
      uploadFindings(row.number, comments, ai
        ? {
            model: ai.model ?? MODEL,
            user,
            tool: 'claude-p',
            // A VÁLASZTOTT review-út: az `agent-review` (CI-vel bit-azonos) és a
            // `/code-review high` MÁS szabályok szerint reviewol, tehát a PR
            // olvasójának tudnia kell, melyiket látja. Enélkül a MÉRT út némán
            // elveszne a body-ból.
            skill: ai.skill ?? undefined,
            aiGenerated: ai.generated,
            costUsd: ai.costUsd ?? undefined,
            sessionId: ai.sessionId ?? undefined,
            // (wf24/2) AZ AI-ÖSSZEGZŐ A REVIEW-BODY-BA IS: a PR olvasójának
            // ugyanolyan hasznos a verdict, mint a TUI-ban — eddig SEHOL nem
            // jelent meg. Csak akkor kerül be, ha az agent tényleg adott.
            aiSummary: ai.aiSummary ?? undefined,
          }
        : fromCache
        ? {
            // A MODELL sem tudható visszamenőleg (nem perzisztált), ezért a
            // default megy — ugyanaz, amit a nem-AI út is használ.
            model: MODEL,
            user,
            tool: 'claude-p',
            aiSummary: restoredMeta?.summary ?? undefined,
          }
        : { model: MODEL, user })
      // A REVIEW-NYOM a FELTÖLTÉSNÉL is bekerül: a hunk-session kommentjei
      // felkerültek a PR-ra, tehát a review MEGTÖRTÉNT és KÍVÜLRŐL is látható.
      //
      // MIÉRT NEM a 'd' (diff-review) jelöl nyomot: a user kimondott elve
      // szerint a `d` átnézés NEM hagy nyomot (megnyitni egy diffet nem review),
      // és egy 'd'-re állított nyom pontosan azt a proxy-teljesítést tanítaná,
      // amit a friction-modell el akar kerülni. A nyom TÉNYT állít, nem szándékot.
      markReviewTrace(cache.current, row.number, 'hunk')
      bumpCache()
      // A FORRÁS KIMONDVA, ha a fallback futott: a user tudja meg, hogy a
      // feltöltött halmaz a CACHE nyers listája volt, nem a hunkban átnézett —
      // tehát a `comment rm` szűrése NEM ment át rajta. A néma fallback itt
      // rosszabb lenne: a user azt hihetné, a saját szűrését töltötte fel.
      setNotice(
        `#${row.number}: ${comments.length} finding feltöltve (COMMENT — ez nem approve)`
        + (fromCache ? ' · a cache-elt review-ból (a hunk-sessionben nem volt anyag)' : '')
        + (ai ? ` · attribúció: claude-p, ${ai.generated} generált / ${comments.length} megtartva` : ''),
      )
    } catch (error) {
      showError(row, `a findings feltöltése nem sikerült: ${error.message}`)
    }
    // A `restoredReviews` a DEPS között: a fallback-út attribúciója (az
    // összegző) ebből jön, tehát egy beragadt closure a verdictet némán
    // elhagyná a PR body-jából.
    //
    // (wf31/15) A PENDING-SZÖVEG: a feltöltés 2-4 blokkoló `gh` hívást tesz
    // (user-login, repo-név, a review POST-ja), tehát ez a leghosszabb néma
    // szakasz volt — a user épp ezt jelentette.
  }, 'f', row?.number), [aiRun, restoredReviews, runExclusive, showError])

  // Az AI-review: `claude -p` a FUTTATÓ tokenjével, a kiválasztott PR-ra.
  //
  // (2) AZ `r` TÖBBÉ NEM NYITJA MEG A HUNKOT. A user kérése szó szerint: a
  // review a háttérben fut, a TUI-ban (a PR-panelben) látszik a progressz, és
  // amikor ELKÉSZÜLT, a panel ajánlja fel a megnyitást ("N finding — r:
  // megnyitás a hunkban"). A hunk akkor nyílik, amikor VAN MIT látni.
  //
  // A HIBRID MODELL (1) — dupla könyvelés:
  //   - ha van ÉLŐ session: HÁTTÉRBEN átváltjuk a PR-ra (`session reload` — nem
  //     veszi át a terminált), az agent a hunkba ír, ÉS a válaszában is
  //     visszaadja a findingokat;
  //   - ha NINCS élő session: az agent answer-only promptot kap (a hunk-írás
  //     kérése a semmibe menne), a findingok a VÁLASZ-JSON-ból jönnek, a cache
  //     PR-ra kulcsolva eltárolja őket, és a hunk MEGNYITÁSAKOR töltődnek be
  //     (openReview / a panel r-ajánlata, batch-apply, idempotensen).
  // ÍGY A SESSION-HALÁL NEM ÖLI MEG A REVIEW-T: a user egyszer MEGFIZETTE ezt
  // (a review lefutott, a session közben megszűnt, minden elveszett) — a
  // "review MÁR LEFUTOTT… futtasd újra" típusú üzenet ezért TILOS, ha van
  // válasz-JSON.
  //
  // A GATE VÁLTOZATLANUL NEM A CLAUDE EXIT-KÓDJA (mért csapda: exit 0 +
  // subtype:"success" a le sem futott review-ra is jön): élő session mellett a
  // hunk ID-halmaz-diff (`aiReviewGateByIds`) az elsődleges bizonyíték; session
  // nélkül a válasz-JSON strukturált findings-tömbje a mérhető tény.
  //
  // (3) MINDEN JELZÉS A PR-PANELBE megy (`aiReview` state): a progressz, a
  // végállapotok ÉS a hibák is — a globális hiba-overlay az AI-review útján
  // nem használatos többé.
  const doAiReview = useCallback((row, maxBudgetUsd, reviewPath, model) => runExclusive(async (release) => {
    let handle = null
    // A MÉRÉS-ÁLLAPOT REFERENCIÁJA a try ELŐTT: a `finally` IDENTITÁSSAL zárja
    // le (`aiLive.current === live`) — lásd a régi #904-es finally-indoklást.
    let live = null
    try {
      // EGY HÁTTÉR-REVIEW FUTHAT EGYSZERRE (a hunk-session repo-szintű, két
      // párhuzamos futás findingjait a halmaz-diff nem tudná szétválasztani).
      if (aiHandle.current) {
        setNotice('már fut egy AI-review a háttérben — várd meg, vagy szakítsd meg (x)')
        // (wf28/1) NINCS MIT TAKARÍTANI: ez az ág a 'starting'-írás ELŐTT
        // fordul vissza (a saját `setAiReview`-ja néhány sorral lentebb van),
        // tehát a futó review állapotát nem érintette. A régi
        // `restoreAiPrevDone()` hívás azért állt itt, mert a MENÜ-NYITÁS
        // útja már beírt egy 'starting'-ot, amit ez az ág örökölt — az az írás
        // a wf28/1-gyel megszűnt.
        return
      }
      // (6) AZONNALI FEEDBACK: a panel review-szekciója már A BLOKKOLÓ I/O-K
      // (session-próba, git fetch) ELŐTT "AI-review indul…"-t mutat. A
      // setTimeout(0) engedi a React-flush-t, mielőtt a spawnSync-ek blokkolnak.
      setAiReview({ pr: row.number, status: 'starting' })
      // (wf31/42) Ink-flush a `setTimeout(0)` helyett — lásd a `runExclusive`
      // indoklását: az előbbi GARANTÁLJA a kiírt frame-et, az utóbbi csak remélte.
      try {
        await waitUntilRenderFlush()
      } catch { /* fail-soft: lásd ott */ }

      const root = fetchRepoRoot()
      // A SESSION-ÁLLAPOT MÉRÉSE. HÁROM kimenet:
      //   true  — élő session: háttér-reload a PR-ra + `before` ID-halmaz;
      //   false — nincs (vagy árva): answer-only mód, hunk-lépés NÉLKÜL;
      //   null  — nem tudható (daemon-hiba / nincs bináris): answer-only mód —
      //           fail-soft, mert a válasz-JSON út session nélkül is teljes
      //           értékű review-t ad, és a token nem megy a semmibe.
      const alive = probeHunkSession(root)
      let sessionAlive = alive === true
      // A REF-FETCH MINDKÉT MÓDNAK KELL: élő sessionnél a reload célpontja,
      // answer-only módban pedig a prompt fájl-olvasási útja (`git show
      // <headRef>:<path>`) — enélkül az agent a gh api contents + pipe
      // kerülőre kényszerül, amit a permission-réteg elvből denied-el (MÉRT
      // hibaosztály, két élő futásból). FAIL-SOFT: ha a fetch elhasal,
      // headRef=null — a prompt kihagyja az utat, a review attól még fut.
      let prBase = null
      let prHead = null
      // (hazug-felirat-1) A FAIL-SOFT MARAD, de az OK NEM tűnhet el: a
      // fetchPrRefs hibája (git fetch exit≠0, gh auth/rate-limit, ENOENT)
      // változóba kerül — élő session mellett a degradáció (answer-only mód) a
      // végállapotban caveat-ként + őszinte fejlécként kimondódik, a néma üres
      // catch helyett.
      let refsError = null
      try {
        ;[prBase, prHead] = fetchPrRefs(row.number)
      } catch (error) {
        refsError = error?.message ?? String(error)
        prBase = null
        prHead = null
      }
      if (sessionAlive) {
        // A SINGLETON: a meglévő sessiont VÁLTJUK ÁT (reload) — új hunk TUI
        // nem indul, a terminál a miénk marad. Ha a reload árvának találja a
        // sessiont (false), answer-only módra esünk. Ref nélkül nincs reload.
        sessionAlive = prHead !== null && reloadHunkSession(root, prBase, prHead) === true
      }
      // A `before` ID-HALMAZ CSAK élő session mellett mérhető ÉS értelmes.
      const before = sessionAlive ? hunkAgentNoteIds(root, { context: 'review' }) : new Set()

      const timeoutMs = aiTimeoutMs ?? AI_REVIEW_TIMEOUT_MS
      handle = startAgentReview({
        headRef: prHead,
        pr: row.number,
        repoRoot: root,
        reviewPath,
        maxBudgetUsd,
        // A megerősítő panelen VÁLASZTOTT modell (env-kezdőértékkel) — a core
        // command-buildere fail-closed defaultol (opus), ha üres.
        model,
        cwd: root,
        timeoutMs,
        // A PROMPT A SESSION-ÁLLAPOTHOZ igazodik: élő session mellett hunk-írás
        // + válasz-JSON (dupla könyvelés); session nélkül KIZÁRÓLAG válasz-JSON.
        sessionAlive,
        // A STREAM-JELZÉS: ref-be írunk (nem state-be) — az Ink a suspend alatt
        // eldobná a rendert (a projekt tanult csapdája), és a ticker olvassa.
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
      // A PROGRESSZ A PANELBEN: a `running` állapot sora az eltelt időt, a
      // finding-számot és a tool-jelzést mutatja (aiReviewPanelLines), a
      // frissítést a ticker `aiTick`-je hajtja.
      setAiReview({ pr: row.number, status: 'running', startedAt: live.startedAt })
      // A UI ELENGEDÉSE: a claude innentől a háttérben dolgozik, a TUI
      // HASZNÁLHATÓ marad (navigálás, panel, kilépés-kérdés).
      release()

      const outcome = await handle.done
      // ABORTÁLT REVIEW-BÓL NINCS TÉNY — az OK viszont szétválasztva (#904).
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

      // A DUPLA KÖNYVELÉS MÁSIK FELE: a válasz-JSON. A parse hibája NEM nyelődik
      // el, de nem is öli meg a hunk-ágat — csak akkor mondjuk ki, ha a hunk-út
      // sem adott findingot (különben a hunkba írt findingok a mérvadók).
      // (wf24/2) A PARSE MOST `{ summary, findings }`-et ad: az `answer` a
      // findingok tömbje (a régi szerződés minden hívónál változatlan), az
      // `answerSummary` az EMBER-OLVASHATÓ összegző — ezt hiányolta a user
      // ("nem találok összegzést sehol"). A summary hiánya (régi/legyengült
      // agent-alak) `null`, és semmit nem buktat.
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

      // (hazug-elhasalt-1) AZ ELSŐDLEGES BIZONYÍTÉK ELŐBB MÉRŐDIK, MINT AHOGY
      // A KAPU ÍTÉL. A fájl saját designelve szerint élő session mellett a
      // hunk ID-halmaz-diff az elsődleges bizonyíték — a denial-gate tehát nem
      // vághatja el a feldolgozást, mielőtt ez megméretett volna: az agent
      // hunkba írt (kifizetett) findingjai mellett a "review ELHASALT" hamis
      // ítélet, ami elvetésre/újraindításra (dupla költésre) visz.
      //
      // AZ AFTER-MÉRÉS ŐRZÖTT (a user MEGFIZETTE ezt a hibát): a session a
      // review KÖZBEN is megszűnhet (ő maga lépett ki a hunkból, hogy lássa
      // a progresszt), és ilyenkor a `hunkAgentNoteIds` DOB. A dobás NEM
      // dobhatja el a MÁR KIPARSE-OLT válasz-JSON-t — az a dupla könyvelés
      // másik fele, pontosan erre az esetre. Ha van válasz-finding, a lenti
      // (c) answer-only útra esünk (eltárolás + done-answer + ajánlat); a
      // "futtasd újra" típusú üzenet TILOS, mert a költés megtörtént és a
      // findingok KÉZNÉL vannak. Ha válasz SINCS, a hiba hangos marad (lentebb).
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

      // DEGRADÁLT REVIEW: a denial adat, nem ítélet (a core parse már nem dob
      // rá). Findingokkal (válasz-JSON VAGY hunk-írta, halmaz-diffel mért):
      // megy tovább a normál feldolgozás, de a caveat rögzül, és a végállapot
      // kimondja, hogy a review NEM teljes. Finding nélkül: a régi hangos hiba
      // — ott tényleg nincs mit mutatni.
      const denied = outcome.envelope.deniedCommands ?? []
      const deniedCaveat = denied.length > 0
        ? `a review NEM teljes: ${denied.length} hívást megtagadott a permission-réteg`
          + ` (${denied.slice(0, 2).join(' · ')}${denied.length > 2 ? ` · és ${denied.length - 2} további` : ''})`
        : null
      if (denied.length > 0 && !(answer && answer.length > 0) && addedIds.length === 0) {
        // Az exitCode:0 a RÉGI, mért végállapot-szöveget adja vissza a catch-ben
        // ("az AI-review ELHASALT (exit 0): …") — a denial-üzenet szerződése
        // (parancs-megnevezés + MIT TEHETSZ) változatlan, csak a dobás helye
        // költözött a parse-ból ide, ahol a findings-kérdés már eldőlt.
        throw Object.assign(
          new Error(`${denialMessage(outcome.envelope.denials)} Ezért a findingok sem lehetnek teljesek.`),
          { exitCode: 0, costUsd: outcome.envelope.costUsd },
        )
      }
      // A MÉRÉS HIBÁJA válasz-findingok nélkül HANGOS marad (a régi szerződés:
      // a dobás csak akkor tilos, ha a válasz-JSON kéznél van).
      if (afterError !== null && !(answer && answer.length > 0)) throw afterError

      if (live.sessionAlive) {
        // (b) ÉLŐ SESSION: a hunk ID-halmaz-diff a mérvadó — minden marad a
        // régiben, plusz a válasz-példány másolatként eltárolódik (applied).
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
            // A findingok MÁR a hunkban vannak: a válasz-példány csak MÁSOLAT,
            // ezért azonnal `applied` — a megnyitáskori betöltés nem duplikál.
            // A CÉLSESSION azonosítójával együtt (session-identitás-guard): ha
            // a user a hunk zárásával a sessiont is elviszi, a következő
            // megnyitás a MÁSOLATBÓL újratölt — a kifizetett findingok nem
            // "tűnnek el" (a user 5/3-as leletének (b)-ági párja).
            cacheStoreAiFindings(cache.current, row.number, answer)
            cacheMarkAiFindingsLoaded(cache.current, row.number, hunkLiveSessionId(root))
            // (1d) A LEMEZRE IS: a review befejezésekor. Az `applied` flag NEM
            // megy ki (a store dobja el) — a hunk-session nem éli túl a
            // folyamatot, tehát a következő indításban a betöltés újra kell.
            persistReview(row, answer, answerSummary)
          }
          // Az ÖSSZEGZŐ az aiRun-ba IS bekerül: a `f` (feltöltés) útja innen
          // veszi a review-body AI-összegzését (wf24/2).
          setAiRun({ row, ...res, generated: res.added, skill: res.reviewPath, aiSummary: answerSummary })
          markReviewTrace(cache.current, row.number, 'ai')
          bumpCache()
          // (2) AZ AJÁNLAT: a hunk NEM nyílik meg magától — a panel kérdez.
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
        // (c) A HUNK NEM ÉLT (vagy az agent nem írt bele): a findingok a
        // VÁLASZBÓL. Eltárolva, a betöltés a hunk MEGNYITÁSAKOR (Enter/`d`).
        cacheStoreAiFindings(cache.current, row.number, answer)
        // (1d) A LEMEZRE IS — ez az ág a FONTOSABB a kettő közül: itt a
        // findingok CSAK a válasz-példányban léteznek (a hunkban nincsenek),
        // tehát egy újraindítás eddig NYOMTALANUL elvitte a kifizetett review-t.
        persistReview(row, answer, answerSummary)
        // (hazug-felirat-1) ÉLŐ SESSION + ELHASALT REF-FETCH → a degradáció
        // KIMONDVA: a session élt, csak a git/gh bukott el, ezért futott
        // answer-only mód — a default "a hunk-session nem élt a futás alatt"
        // fejléc itt hamis állítás lenne, az ok pedig nyomtalanul veszne el.
        const refsDegraded = alive === true && refsError !== null
        const refsCaveat = refsDegraded
          ? `a hunk-session ÉLT, de a PR-refek lekérése elhasalt (${refsError}) — a review answer-only módra degradálódott`
          : null
        // (dupla-betoltes-1) TRANZIENS AFTER-MÉRÉS-HIBA ÉLŐ SESSION MELLETT:
        // az agent a hunkba (is) írt (session-alive prompt), csak a mérés
        // hasalt el — a válasz-példány applied=false-szal tárolása a következő
        // megnyitáskor MÁSODSZOR töltené be ugyanazokat a findingokat a még élő
        // sessionbe. A két hibairány közül a duplikáció a rosszabb (a core
        // answerFindingsNeedApply doktrínája), ezért ha a session MÉG ÉL, a
        // másolat AZONNAL applied-ként rögzül a session-azonosítóval — a probe
        // `null`-ja (nem tudható) itt ÉLŐKÉNT számít, ugyanazon fail-safe elv
        // szerint. Valóban halott sessionnél marad a sima (c) út (applied=false,
        // a megnyitás betölt — ott a betöltés NEM duplikál, a session üres).
        let dupGuardNote = null
        if (live.sessionAlive && afterError !== null && probeHunkSession(root) !== false) {
          cacheMarkAiFindingsLoaded(cache.current, row.number, hunkLiveSessionId(root))
          dupGuardNote = `✓ ${answer.length} AI-finding a review válaszából ELTÁROLVA — a hunk-írás mérése elhasalt, `
            + `a betöltést duplikáció-védelem miatt nem ismételjük (ok: ${afterError.message})`
        }
        const headNote = dupGuardNote ?? (refsDegraded
          ? `✓ ${answer.length} AI-finding a review válaszából ELTÁROLVA — a hunk-session élt, de a ref-lekérés hibája miatt answer-only mód futott`
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
      // (3) A HIBA IS A PANELBEN: a `failed` szekció mondja ki az exit-kódot, a
      // stderr első sorát és a költést — a globális hiba-overlay helyett.
      const message = error.exitCode !== undefined
        ? aiReviewOutcome({
            kind: 'failed',
            pr: row.number,
            exitCode: error.exitCode,
            signal: error.signal,
            stderr: String(error.stderrText ?? '').trim() !== '' ? error.stderrText : error.message,
            costUsd: error.costUsd,
          }).message
        : `AI-review hiba: ${error.message}`
      setAiReview({ pr: row.number, status: 'failed', message })
    } finally {
      // A LEZÁRÁS IDENTITÁS-ALAPÚ (lásd a #904-es forgatókönyvet): egy korán
      // dobott futás (`live === null`) nem törölheti egy MÁSIK futás állapotát.
      const mine = live !== null && aiLive.current === live
      if (mine) aiLive.current = null
      if (aiHandle.current === handle) aiHandle.current = null
    }
    // A `busy`/lock visszaállítása a `runExclusive` FELELŐSSÉGE.
  }), [aiTimeoutMs, bumpCache, runExclusive])

  // Az AI-review megerősítő ekrányának ELŐKÉSZÍTÉSE: a PR mérete, a scope és a
  // kizárt generált fájlok lekérése. Ez maga is I/O (gh), de INGYEN van —
  // szemben a claude-hívással, amiért a user fizet. Ezért fut a megerősítés
  // ELŐTT: a döntéshez a mérteket kell látni, nem becslést.
  /**
   * (wf31/6) VAN-E AI-FINDING ezen a PR-on — akár BETÖLTETLEN, akár MÁR BETÖLTÖTT?
   *
   * A `d` (megnyitás) EBBŐL dönti el, hogy `--agent-notes`-szal nyitja-e a
   * hunkot. EGY forrás: a session-cache.
   *
   * MIÉRT NEM CSAK A BETÖLTETLENEKET SZÁMOLJA (mért hiba a saját első
   * alakomon, élő renderen elkapva): az `applied` flag azt jelenti, hogy a
   * findingok MÁR BENNE VANNAK a hunk-sessionben — vagyis épp ilyenkor VAN mit
   * megjelenítenie a `--agent-notes`-nak. Az ÉLŐ SESSION útján a válasz-findingok
   * AZONNAL `applied: true`-ként tárolódnak, tehát a "csak betöltetlen" szűrő
   * pont abban az esetben dobta el a flaget, amikor a legtöbb AI-komment volt a
   * sessionben — a user egy NOTES NÉLKÜLI diffet kapott egy épp lefutott review
   * után. (A live render-teszt: "a kész review `d`-megnyitása ÉLŐ sessionnél is
   * --agent-notes-szal fut".)
   *
   * A `--agent-notes` KÉRDÉSE TEHÁT NEM "kell-e betölteni?", HANEM "van-e mit
   * mutatni?" — a betöltés maga külön szerződés (a megnyitási út idempotens
   * batch-apply-ja, `applied` flaggel védve).
   *
   * A PENDING-MENTES, REVIEW-MENTES ÚT VÁLTOZATLAN: ha SOSEM futott review ezen a
   * PR-on, nincs bejegyzés, tehát `false` — a sima `d` bájtra a régi, flag nélküli
   * spawn (ezt is teszt köti).
   */
  const hasAnyFindings = useCallback((pr) => {
    if (pr === null || pr === undefined) return false
    const entry = cacheAiFindings(cache.current, pr)
    return Boolean(entry && Array.isArray(entry.findings) && entry.findings.length > 0)
  }, [])

  /**
   * (wf31/6) VAN-E BE NEM TÖLTÖTT (kifizetett, de a hunkba még nem írt) FINDING?
   *
   * MIÉRT KÜLÖN A `hasAnyFindings`-TŐL, ÉS MIÉRT NEM EGY PREDIKÁTUM MINDKETTŐRE:
   * a két kérdés MÁS döntést szolgál, és épp az `applied` flagben térnek el —
   * egy összevont predikátum az egyik hívási helyen NÉMÁN hibás lenne.
   *   · `hasAnyFindings` → "VAN-E MIT MUTATNI?" (a `d` `--agent-notes`-a): a MÁR
   *     betöltött findingok is látszanak, tehát azok is IGENT adnak;
   *   · `hasUnloadedFindings` → "VAN-E FÉLBEHAGYOTT MUNKA?" (az `r` indítás-tilalma
   *     és a kilépés-figyelmeztetés): a MÁR betöltötteket a user átnézhette, azok
   *     nem tiltják az újraindítást.
   * Az `aiReviewLifecycle` `done` ága UGYANEZT az `applied !== true` feltételt
   * használja — tehát az `r` viselkedése és a lábléc-címke EGY tőről fakad.
   */
  const hasUnloadedFindings = useCallback((pr) => {
    if (pr === null || pr === undefined) return false
    const entry = cacheAiFindings(cache.current, pr)
    return Boolean(entry && entry.applied !== true
      && Array.isArray(entry.findings) && entry.findings.length > 0)
  }, [])

  // (wf31/2) A `release` PARAMÉTER LOAD-BEARING: a menü megnyitása UTÁN AZONNAL
  // elengedjük a lockot ÉS a `busy`-t. A USER LELETE, szó szerint: "Utána megint
  // 'r', ekkor »dolgozom...«, majd visszaáll »megszakítva« feliratra."
  //
  // A MÉRT OK: a `runExclusive` a HÍVÁS ELEJÉN `setBusy(true)`-t állít, és a
  // `finally`-ban engedi el — a `askAiReview` viszont a menü-nyitás UTÁN még egy
  // BLOKKOLÓ `fetchPrFiles`-t (éles PR-on ~1 másodperc `gh`) is végigvár. Az az
  // egy másodperc a status-sorban "dolgozom…"-ként látszott.
  //
  // ÉS EZ NEM CSAK KOZMETIKA: a `busy` alatt a `useInput` LEGELSŐ guardja
  // (`if (actionLock.current || busy) return`) MINDEN gombot megöl — tehát a
  // frissen megnyílt menü SAJÁT kulcsai (`tab`/`m`/`b`/`y`/`Esc`) egy teljes
  // másodpercig NÉMÁN elhaltak. A menü megjelent, de nem reagált; a user
  // "inkonzisztens" lelete pontosan ez.
  //
  // MIÉRT BIZTONSÁGOS ITT ELENGEDNI: a `busy`/lock szerepe a KÖLTŐ, VISSZA NEM
  // VONHATÓ akciók sorosítása (approve/merge/upload/AI-review-indítás). A
  // menü-nyitás EGYIK SEM: statikus UI-váltás, a mérés pedig SZÁNDÉKOSAN a
  // háttérben fut (a UI használható marad — ez a modul kimondott elve). Az
  // `aiHandle` guard (fentebb) és a `y`-ág dwell-kapuja VÁLTOZATLAN, tehát a
  // token-költő út továbbra is védett — a lock nem az ő kapuja volt.
  const askAiReview = useCallback((row) => runExclusive(async (release) => {
    try {
      // FUTÓ REVIEW MELLETT NINCS ÚJ DIALOG. A guard eddig a doAiReview-ban élt
      // (az `y` UTÁN futott), így az `r` megnyitotta a megerősítőt, és az alábbi
      // azonnali-feedback írás FELÜLÍRTA a futó review panel-állapotát — az `N`
      // pedig a 'starting'-ot törölve ELTÜNTETTE a progresszt, miközben a review
      // a háttérben futott tovább (a user mért bug-útja). A guardnak tehát
      // MINDEN state-írás ELŐTT kell állnia.
      if (aiHandle.current) {
        setNotice('már fut egy AI-review a háttérben — várd meg, vagy szakítsd meg (x)')
        return
      }
      // (wf28/1-2) A MENÜ-NYITÁS NEM ÍR `aiReview` STATE-ET. EZ A JAVÍTÁS MAGJA,
      // és EGYSZERRE oldja a user KÉT észrevételét — mert MINDKETTŐ ugyanabból
      // az egy sorból jött (a régi `setAiReview({ status: 'starting' })`):
      //
      //   (1) a PANELBEN megjelent egy "⏳ AI-review indul…" sor
      //       (`aiReviewPanelLines` 'starting' ága), ami LETOLTA a menü-sort. A
      //       user szó szerint: "elütve a user számára létező pozicionális
      //       anchor érzetet a menün";
      //   (2) a LÁBLÉCBEN az `r` szegmens "review fut…"-ra váltott, mert az
      //       `aiReviewLifecycle` a 'starting'-ot `running`-nak számolja. A
      //       user: "Ennek full statikus UI útnak kéne lennie, ilyen átmeneti
      //       legend állapotnak nem is kéne léteznie."
      //
      // A DÖNTÉS (a két lehetőség közül): a 'starting' státusz NEM SZŰNIK MEG,
      // de EZEN AZ ÚTON MEG SEM SZÜLETIK. MIÉRT NEM a "marad a state-ben, csak
      // nem rendereljük" változat: a `'starting'`-nak HÁROM fogyasztója van
      // (MÉRVE) — a panel-sor, a lifecycle→lábléc, ÉS a `spinningPr` sor-spinner
      // —, tehát a puszta render-elhallgatás a másik kettőt bent hagyná (a
      // lábléc továbbra is "review fut…"-ot írna: a (2) észrevétel NEM oldódna),
      // és egy olyan state-et tartana, ami semmit nem jelent. A 'starting'
      // MEGMARAD a VALÓDI indulás útján (`doAiReview`, a `y` UTÁN), ahol a
      // blokkoló session-próba és git-fetch előtt tényleges visszajelzés kell —
      // ott mindhárom fogyasztó IGAZAT állít, mert ott tényleg indul a review.
      //
      // A MENÜ-NYITÁS viszont STATIKUS UI-VÁLTÁS, nem folyamat: nincs mit
      // "indulni", tehát nincs mit jelezni sem.
      //
      // (allapotgep-2) AZ `aiPrevDone` FÉLRETÉTEL IS ELTŰNT ERRŐL AZ ÚTRÓL, és
      // ez nem elhagyás, hanem KÖVETKEZMÉNY: a mentés-visszaadás CSAK azért
      // kellett, mert ez a sor az egy-slotos state-et FELTÉTEL NÉLKÜL felülírta
      // — egy MÁSIK PR kész (done/done-answer) review-ját is beleértve, amit az
      // elvetett megerősítő után vissza kellett kapni (különben az `r` ott újra
      // INDÍTÁS lett volna, és egy új fizetős review indulhatott volna az
      // explicit elvetés friction-je NÉLKÜL). Ha nem írunk, nincs mit
      // felülírni: a másik PR done-állapota HELYBEN MARAD, tehát a védendő
      // invariáns most SZERKEZETILEG teljesül, nem egy mentés-visszaadás
      // körrel — és mivel a refnek így NEM MARADT ÍRÓJA, az egész mechanizmus
      // (ref + visszaállító + a négy hívása) KI IS KERÜLT: lásd a törlés
      // indoklását a `useState`-blokk után. Egy megtartott, örök no-op
      // visszaállító a `doAiReview` VALÓDI 'starting' fázisában nullázta volna
      // egy élő review állapotát — a #904-es "eltűnt a progressz" hibaosztály.
      //
      // A PANEL VISZONT KINYÍLIK (ez az `r` STATIKUS UI-váltása), és a
      // setTimeout(0) engedi a React-flush-t a blokkoló `fetchPrFiles` ELŐTT:
      // a MENÜ így éles PR-on is AZONNAL látszik, nem a gh 1 másodperce után.
      setPanel((cur) => (cur && cur.row?.number === row.number ? cur : panelOpen({ row })))
      // (wf28/1) A MENÜ A MÉRÉS ELŐTT NYÍLIK MEG, MÉRET NÉLKÜL. A `size` a
      // MÁSODIK lépcső figyelmeztetéséhez kell, amit a `y` pillanatában
      // számolunk (`reviewMenuWarning`) — tehát a mérés eredménye UTÓLAG is
      // beérkezhet a menübe. A dwell-horgony (`armedAt`) IS ITT születik: a
      // dwell azt méri, mióta van a döntés a SZEM ELŐTT, és a menü ITT lett
      // látható. (A régi sorrend a horgonyt a mérés UTÁN vette fel, mert a menü
      // is csak akkor nyílt meg — most, hogy a menü előbb látszik, a horgony is
      // előbb kell, különben a gh 1 másodperce a dwellbe SZÁMÍTANA BE, és a
      // typeahead-védelem néma no-op lenne.)
      //
      // ITT SZÁNDÉKOSAN NINCS `setAiReview` — lásd a fenti (wf28/1-2) blokk
      // indoklását. Egy ide visszakerülő `{ status: 'starting' }` írás EGYSZERRE
      // három tesztet buktat: a `wf28/1`-et (panel-sor), a `6`-ost (bent maradó
      // jelzés), ÉS az `allapotgep-2`-t (a MÁS PR done-állapotának elvesztése,
      // token-kockázat) — mert az `aiPrevDone` mentés-visszaadás ennek az
      // írásnak a KÖVETKEZMÉNYEKÉNT lett kivezetve. A kettő EGY döntés: ha ez a
      // sor visszakerül, a védelmet is vissza kell hozni vele.
      const opened = {
        ...reviewMenuOpen({
          armedAt: Date.now(),
          modelEnv: process.env.TUIPR_AI_REVIEW_MODEL,
          budgetEnv: process.env.TUIPR_AI_REVIEW_BUDGET_USD,
        }),
        pr: row.number,
        // A MÉRÉS MÉG NEM FUTOTT LE — és ezt KIMONDJUK (`size: null`), nem
        // nullákkal hazudjuk. Egy `{ fileCount: 0, large: false }` kezdőérték
        // NÉMÁN azt állítaná, hogy a PR kicsi, tehát a `y` a MÁSODIK lépcsőt
        // (a nagy-PR figyelmeztetést) KIHAGYNÁ, ha a user a mérés beérkezése
        // ELŐTT nyomja meg — pontosan az a néma friction-kiürülés, amit a
        // dwell-kapu is tilt. A `y`-ág fail-closed módon kezeli (lásd ott).
        size: null,
      }
      setReviewMenu(opened)
      // (wf31/2) A LOCK/`busy` ELENGEDÉSE ITT — a menü LÁTHATÓ, tehát a kulcsai
      // ÉLNEK. Innentől már csak a MÉRÉS fut (a blokkoló `fetchPrFiles`), ami
      // szándékosan nem blokkolja a UI-t: a `size` UTÓLAG érkezik be a már nyitott
      // menübe (lásd lentebb az identitás-ellenőrzött frissítést).
      //
      // A `runExclusive` `release`-e IDEMPOTENS, tehát a `finally`-ban álló
      // második hívása no-op — nem "engedi el kétszer".
      release()
      // (wf31/42) Ink-flush a `setTimeout(0)` helyett — lásd a `runExclusive` fejét.
      try {
        await waitUntilRenderFlush()
      } catch { /* fail-soft: lásd ott */ }
      const files = fetchPrFiles(row.number)
      // A PLAFON DEFAULTBAN KI VAN KAPCSOLVA: az env csak KEZDŐÉRTÉKET ad. Ha
      // nincs env, a `budget.usd` undefined, tehát a `--max-budget-usd` a hívási
      // úton EL SEM MEGY (lásd a core budgetArgs-át). A régi, PR-mérethez
      // skálázott formula kivezetve: a flag API-költésre való, a user viszont
      // subscription-limitet fogyaszt, ahol nincs mit dollárban vágni — a
      // skálázás egy nem-létező tengelyen finomhangolt.
      //
      // (2) AZ ENV-OLVASÁS ÁTKERÜLT a `reviewMenuOpen`-be (`budgetEnv`): a menü
      // NORMALIZÁLJA is a saját négyes körére (off → 3 → 5 → 10), amit egy külön
      // `aiReviewBudgetState` hívás itt nem tudna — egy env-ből jött 1 USD a
      // körön kívül esne, és a `b` első nyomása kiszámíthatatlan helyre vinne.
      //
      // A SUMMARY-ba SZÁNDÉKOSAN NEM adjuk át a plafont, akkor sem, ha az env
      // bekapcsolta: a plafon EGYETLEN megjelenítője a menü `b:` szegmense.
      //
      // A SUMMARY-T A MÉRETÉRT hívjuk (fileCount / additions / deletions /
      // large) — a `lines` PRÓZÁJA a MEGSZŰNT dialóg tartalma volt, azt már
      // senki nem rendereli. A KÜSZÖB-DÖNTÉS (`large`) viszont továbbra is a
      // core-ban él: a második lépcső figyelmeztetése abból következik, és két
      // küszöb-forrás pont az az elcsúszás, amit a projekt tilt.
      const summary = aiReviewSummary({ pr: row.number, files })
      // (2) A BLOKKOLÓK a MEGERŐSÍTÉS ELŐTT dőlnek el, és ha van, a MENÜ SEM
      // NYÍLIK MEG — HIBA-OVERLAYRE mennek.
      //
      // MIÉRT ÍGY, ÉS MIÉRT NEM A MENÜBEN: a régi modálnak volt "denied" ága (a
      // blockers-lista pirosan, a `y` nem éles). A menü EGY SOR — egy több
      // bekezdéses blokkoló-magyarázat (a `claude` nincs a PATH-on, telepítsd,
      // vagy tedd a PATH-ra…) oda SEMMILYEN terminálon nem fér be, és egy
      // csonkolt blokkoló-üzenet HASZNÁLHATATLAN: a user pont azt nem tudná meg,
      // MIT kell tennie. A hiba-overlay viszont tördel és teljes szöveget ad —
      // az a helye. A GATE ÉRTÉKE VÁLTOZATLAN: blokkoló mellett a token-költő út
      // NEM indul el, csak a jelzés helye lett a megfelelő.
      const blockers = aiReviewBlockers({ claudePath: claudePath(), scope: summary.scope })
      if (blockers.length > 0) {
        // (wf28/1) A MENÜ MÁR NYITVA VAN (a mérés előtt nyílt), tehát a blokkoló
        // most ZÁRJA — a régi kódban itt még nem volt mit zárni. A GATE ÉRTÉKE
        // VÁLTOZATLAN: blokkoló mellett a token-költő út nem indul el, és a
        // `y` nem is érhető el, mert a menü eltűnik a hiba-overlay alól.
        //
        // A ZÁRÁS IDENTITÁS-ELLENŐRZÖTT (`cur?.pr === row.number`): ha a user a
        // mérés ~1 másodperce alatt már bezárta a menüt és egy MÁSIK PR-on
        // nyitott újat, ez a késett blokkoló nem zárhatja be AZT — az idegen
        // menü néma eltűnése pontosan a "megszakadt?" bizonytalanság.
        setReviewMenu((cur) => (cur && cur.pr === row.number ? null : cur))
        showError(row, `AI-review nem indítható:\n${blockers.map((b) => `· ${b}`).join('\n')}`)
        return
      }
      // (wf28/1) A MÉRT MÉRET UTÓLAG ÉRKEZIK BE a MÁR NYITOTT menübe. A menü a
      // mérés ELŐTT nyílt meg (hogy éles PR-on ne kelljen a gh 1 másodpercét
      // visszajelzés nélkül kivárni), tehát itt már nem NYITUNK, hanem
      // FRISSÍTÜNK — és CSAK a `size` mezőt: a user közben állíthatott a
      // `tab`/`m`/`b` váltókkal, és egy teljes felülírás (`reviewMenuOpen`
      // újrahívása) NÉMÁN visszaállítaná a defaultokat. Ugyanígy VÉDETT az
      // `armedAt`: a horgony a MEGNYITÁSKOR született (a dwell azóta ketyeg),
      // egy friss arm itt újraindítaná a kaput.
      //
      // AZ IDENTITÁS-ELLENŐRZÉS ITT IS: a késett mérés nem írhat egy MÁSIK PR
      // menüjébe — az a user egy IDEGEN PR méretével kapná meg a nagy-PR
      // figyelmeztetést (vagy épp nem kapná meg). A `stage`-et sem bántjuk: ha
      // a user a mérés alatt már `y`-t nyomott, a második lépcsőn állhat.
      //
      // A `warning` SZÖVEGE NEM itt dől el: a MÁSODIK LÉPCSŐ a `y` pillanatában
      // kérdezi meg (lásd a useInput menü-ágát), EBBŐL a mért méretből. Így a
      // state nem hordoz elavult figyelmeztetés-szöveget.
      const size = {
        fileCount: summary.fileCount,
        additions: summary.additions,
        deletions: summary.deletions,
        large: summary.large,
      }
      setReviewMenu((cur) => (cur && cur.pr === row.number ? { ...cur, size } : cur))
    } catch (error) {
      // (wf28/1) A MEGHIÚSULT ELŐKÉSZÍTÉS ZÁRJA A MÁR NYITOTT MENÜT (identitásra
      // szűrve, mint a blokkoló-ágon). A régi `restoreAiPrevDone()` hívás
      // KIESETT: ez az út többé nem ír `aiReview` state-et, tehát nincs mit
      // visszaállítani — a másik PR done-állapota érintetlen maradt.
      setReviewMenu((cur) => (cur && cur.pr === row.number ? null : cur))
      showError(row, `AI-review nem indítható: ${error.message}`)
    }
    // (2) Az `openModal` KIESETT a depsből: az AI-review út többé nem modált
    // nyit, hanem a `setReviewMenu` state-settert hívja (ami stabil, tehát nem
    // is kell a listába). A másik három megerősítés (approve/merge/upload)
    // VÁLTOZATLANUL az `openModal`-t használja a saját ágain.
  }), [runExclusive, showError])

  /**
   * (wf31/6) AZ `r` ÚTJA — KÉSZ review mellett NO-OP, egyébként indítás.
   *
   * A GUARD LOAD-BEARING, ÉS MARAD: a `done` állapotban az `r` NEM indíthat újat,
   * mert egy újraindítás a KIFIZETETT, be nem töltött findingokat FELÜLÍRNÁ (a
   * memória-cache-ben ÉS a lemezen is — a `persistReview` ugyanarra a PR-kulcsra
   * ír). Az új indítás előfeltétele VÁLTOZATLANUL az explicit elvetés (dupla-`x`).
   *
   * (wf31/12) A JELZÉS VISZONT KIVEZETVE — a user kérése, szó szerint: "Ez a
   * szöveg teljesen felesleges, nem kell szájbarágni, hogy cache-elt review-t
   * hoztunk be az appba. Ez a statussor felesleges, vedd ki."
   *
   * MIÉRT NEM MARAD MÉGSEM „NÉMA GOMB" (a wf31/6-os indoklás itt ELAVULT): akkor
   * az `r` a `done` állapotban is HIRDETETT kulcs volt (a lábléc `r: elvetés (x)`
   * alakban mutatta), és egy hirdetett, de néma gomb valóban a legrosszabb
   * kimenet — a user nem tudja, a gomb rossz-e vagy a UI fagyott le. MOSTANTÓL a
   * lábléc `x: review elvetése`-t hirdet, tehát az `r` ezen az állapoton NEM
   * HIRDETETT kulcs: a néma elhalása ugyanaz, mint bármely más nem hirdetett
   * gombé. A hibaosztály tehát nem tér vissza — megszűnt az előfeltétele.
   *
   * A KÖVETKEZŐ LÉPÉS SEM VESZETT EL: a `d` (megnyitás) és az `x` (elvetés) is a
   * panel LÁBLÉCÉBEN áll, tehát a user a szem előtt látja őket — nem egy
   * gombnyomásra felvillanó status-sorban, ami amúgy is eltűnik a következő
   * akcióval.
   */
  const rKeyAction = useCallback((row) => {
    if (!row) return
    // A KIFIZETETT, BE NEM TÖLTÖTT FINDINGOK VÉDELME: néma return. Az elvetés
    // (`x`) és a megnyitás (`d`) kulcsát a lábléc hirdeti.
    if (hasUnloadedFindings(row.number)) return
    askAiReview(row)
  }, [askAiReview, hasUnloadedFindings])

  // Az approve a MEGLÉVŐ non-interaktív utat hívja — DE EXPLICIT `--body`-val.
  //
  // MIÉRT NEM A BASH DEFAULTJA (ez a feature legdrágább állítása): a
  // `cmd_approve` `--body` nélkül a
  //     "Reviewed in next queue session <dátum> — next @ <sha>"
  // szöveget teszi fel. Ez ÁLLÍTJA, hogy volt review. Review-nyom nélkül ez
  // HAZUGSÁG a PR AUDIT-TRAILJÉBEN — és a user 1. elvének a magja pontosan ez: a
  // friction azért NEM hard gate, mert az ATTESZTÁCIÓNAK kell igazat mondania,
  // nem a kapunak kikényszerítenie a proxy-nyomot. (Egy hard gate arra tanítana,
  // hogy tokent költsünk hamis attesztációs nyomért.)
  //
  // A NYOM a session-cache-ből jön (markReviewTrace): ebben a sessionben futott-e
  // AI-review vagy ment-e fel hunk-finding EZEN a PR-on. NEM a GitHubról
  // kérdezzük vissza: a `d` (diff-review) átnézés SZÁNDÉKOSAN nem hagy nyomot
  // (megnyitni egy diffet nem review), tehát a nyom TÉNYT állít, nem szándékot.
  //
  // A `runExclusive` ITT IS: a korábbi alak `setBusy(true)`-t állított, majd
  // try/finally NÉLKÜL futott végig. Ha bármi dobott (spawnSync, `showError`, az
  // `approveBody`), a `busy` VÉGLEG bent maradt: "dolgozom…" örökre, és egyetlen
  // billentyű sem élt (a `useInput` `if (busy) return`-nél elhal). Ez a
  // user-jelentett beragadás MÁSODIK, önálló ága — a `d`-től független.
  const doApprove = useCallback((row) => runExclusive(async () => {
    const traces = reviewTraceSources(cache.current, row.number)
    const body = approveBody({
      hasTrace: traces.length > 0,
      traceSources: traces,
      date: new Date().toISOString().slice(0, 10),
      // A `next` SHA-ját a bash-út is beírná; itt NEM mérjük újra (egy második
      // `git rev-parse` az approve kritikus útján fizetne azért, amit a body
      // amúgy sem használ döntésre). A tag KIMARAD, nem `undefined`-ként kerül be
      // — a hamis pontosság rosszabb, mint a hiány (lásd approveBody).
      nextSha: null,
    })
    const res = spawnSync(
      'bash',
      [new URL('tuipr.sh', import.meta.url).pathname, 'approve', String(row.number), '--body', body, '--yes'],
      { encoding: 'utf8' },
    )
    // Az ENOENT-et KÜLÖN vizsgáljuk: spawn-hibánál a `status` null és a stderr
    // ÜRES, tehát a `status === 0` hamis, de a hibaszöveg is üres lenne — a user
    // egy tartalom nélküli "approve hiba:" sort kapna. A res.error mondja meg,
    // hogy a bash/az script maga nem indult el (ez MÁS diagnózis, mint egy
    // elutasított approve).
    if (res.error) showError(row, `az approve nem indítható (${res.error.code ?? 'spawn hiba'}): ${res.error.message}`)
    else if (res.status !== 0) showError(row, `approve hiba: ${(res.stderr || res.stdout || '').trim() || `exit ${res.status}`}`)
    else {
      setNotice(`#${row.number}: approved`)
      // (wf31/25) OPTIMISTA JELÖLÉS: az rmark AZONNAL `✔ approved` — az index-késés
      // miatt a reload különben még a régi `reviewDecision`-t adná.
      setOptimistic((cur) => ({ ...cur, [row.number]: 'approved' }))
    }
    reload()
  }, 'a', row?.number), [reload, runExclusive, showError])

  // A futó mérés lezárása: KILL + a handle elengedése. Minden kilépési úton
  // (Esc, panel-zárás, unmount) ezen keresztül megy — így nem maradhat zombie
  // merge-tree próba a háttérben.
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

  // --- A HÁTTÉR-POLL TICKJE -------------------------------------------------
  //
  // A KAPUKAT a TICK olvassa ki friss `ref`-ekből, NEM a hook dependency-jéből.
  //
  // MIÉRT (ez a lényegi tervezési döntés): ha az `overlayOpen`/`measuring`
  // állapotok a `useEffect` dependency-listáján lennének, akkor MINDEN
  // panel-nyitás és -zárás LEÁLLÍTANÁ és ÚJRAINDÍTANÁ az intervallumot — az
  // esedékesség számlálója nullázódna, és egy aktívan panelező user gépén a
  // poll SOSEM futna le. A kapuk ezért a tick BELSEJÉBEN olvasódnak, az
  // intervallum pedig a komponens életében EGYSZER jön létre.
  const gateRef = React.useRef({ overlayOpen: false, measuring: false })
  gateRef.current = {
    // A `busy` is overlay-nek számít: az akció fut, a UI blokkolt. A PANEL
    // MINDKÉT módja (inline info ÉS modál megerősítés) kapunak számít: a
    // poll-fejezet (a) kapujának indoka szerint nyitott dialógusnál a fókusz a
    // döntésen/olvasáson van, a poll nem szólhat közbe.
    overlayOpen: errorState !== null || panel !== null || busy,
    // A MÉRÉS akkor "fut", ha a panel progress-állapota running. A
    // `diagHandle` nem elég: a child kill-je aszinkron, tehát a handle még ott
    // lehet egy már befejezett mérésnél.
    measuring: panel?.progress?.running === true,
  }

  useEffect(() => {
    const tickMs = pollIntervalMs ?? POLL_INTERVAL_MS
    const timer = setInterval(() => {
      // KÉT PRÓBA SOSEM FUT EGYSZERRE: a fetchStalenessProbe spawnSync-es
      // (blokkoló), és egy átfedő indítás a UI-t kétszer annyit fagyasztaná.
      if (probing.current) return
      const t = now()
      const gates = gateRef.current
      if (!pollDue(poll.current, { ...gates, now: t })) return
      probing.current = true
      try {
        // A PRÓBA. SOSEM DOB (strukturált `{ ok, error }`-t ad) — a poll
        // háttérfolyamat, egy dobás itt unhandled rejectionként végezné, és a
        // TUI-t vinné magával.
        const res = fetchStalenessProbe()
        if (!res.ok) {
          // CSENDES ÚJRAPRÓBÁLÁS (backoff). A nyers hibaszöveg az állapotba
          // kerül (diagnosztikára), a UI-ba NEM — se overlay, se status-sor:
          // egy háttér-művelet hibája nem kérhet nyugtázást a usertől.
          poll.current = pollFailure(poll.current, { now: t, message: res.error })
        } else {
          const changed = stalenessChanged(poll.current.signature, res.signature)
          poll.current = pollProbeResult(poll.current, { changed, signature: res.signature, now: t })
        }
        // A RENDERT KIZÁRÓLAG a LÁTHATÓ jelzés változása váltja ki. A
        // `setPollLabel` csak akkor ír, ha a szöveg TÉNYLEGESEN más — enélkül
        // minden tick újrarenderelné a listát (React bail-outra hagyatkozni
        // itt kockázatos: a state azonos stringre no-op, de a szándékot
        // kimondjuk, mert ez a poll UI-költségének a garanciája).
        const label = pollStatusLabel(poll.current)
        setPollLabel((prev) => (prev === label ? prev : label))
      } finally {
        // FINALLY: egy váratlan dobás sem hagyhatja az őrszemet felhúzva,
        // különben a poll ÖRÖKRE leállna (és némán — pontosan a tiltott ág).
        probing.current = false
      }
    }, tickMs)
    return () => clearInterval(timer)
    // A DEPENDENCY-LISTA SZÁNDÉKOSAN MINIMÁLIS: az intervallum a komponens
    // életében egyszer jön létre. A kapuk és az állapot ref-en jönnek be (lásd
    // a fenti indoklást), tehát nem is kellenek ide.
  }, [pollIntervalMs, now])

  // --- A HÁTTÉR-REVIEW PROGRESSZ-TICKJE (#904) -------------------------------
  //
  // A USER JELENTÉSE: "5 perc alatt se látok semmi feedbacket sehol, még a fenti
  // üzenetet írja az app". A régi kód EGYSZER írt egy statikus status-sort. Ez a
  // ticker az, ami a status-sort MOZGÁSBAN tartja.
  //
  // A HÁROM IDŐZÍTŐ EGYÜTT (a követelmény kimondottan ezt kérte):
  //
  //   1. A HÁTTÉR-POLL (`pollIntervalMs`, élesben 100 s) — a queue elavultságát
  //      méri. ÖNÁLLÓ intervallum, saját `probing.current` őrszemmel és a
  //      `gateRef` kapuival. EZ A TICKER NEM NYÚL BELE, és nem is ütközik vele:
  //      a review `setAiTick`-je egy MÁSIK state, a poll `setPollLabel`-je pedig már ma
  //      is csak VÁLTOZÁSRA ír.
  //   2. A PROGRESSZÍV MÉRÉS (`diagHandle`) — esemény-vezérelt (NDJSON a gyerektől),
  //      nincs intervalluma. Független.
  //   3. EZ A TICKER — csak akkor dolgozik, ha `aiLive.current !== null`, tehát
  //      review nélkül a költsége NULLA (egy `if` ticként).
  //
  // A TICK KÖLTSÉGE MÉRT, NEM TIPPELT (25 PR-soros lista + ticker sor, ink 7.1.1 /
  // node 24.18.0, 20 render warmup kihagyva, 60 mért render): 12.2 ms CPU/render,
  // ami 1 s-os tick mellett ~1.2% egy magon. Kontroll-futás valódi 1 s-tickkel:
  // `cpu_pct_of_wall: 1.97` (indulási költséggel). Elhanyagolható.
  //
  // A FINDING-POLL RITKÁBB, MERT DRÁGÁBB: a `hunk session comment list` MÉRT
  // költsége 0.42 s/hívás ÉLŐ hunk TUI mellett (cold: 0.62 s). 5 s-os ütem mellett
  // ez ~8% duty cycle; 1 s-nál 42% lenne — az sok. Ezért a KÉT ütem KÜLÖN prop.
  useEffect(() => {
    const tickMs = aiTickMs ?? 1000
    const findingMs = aiFindingPollMs ?? 5000
    let lastFindingAt = 0
    // A SZÁMLÁLÓ A TICKER FELÁLLÍTÁSAKOR LÉP — a cleanup csökkenti. Enélkül a
    // szivárgás CSAK process-hangként látszott (MÉRVE: a runner `✖`-et adott,
    // majd BERAGADT, összefoglaló sor nélkül, 120 s után SIGKILL). Lásd az
    // `activeTickers()` fejét.
    tickerCount += 1
    const timer = setInterval(() => {
      const live = aiLive.current
      // NINCS FUTÓ REVIEW → NINCS MUNKA. A ticker költsége ilyenkor egy `if`.
      if (!live) return
      const elapsedMs = Date.now() - live.startedAt
      // A FINDING-SZÁMLÁLÓ RITKÁBBAN: a hunk-hívás blokkoló I/O (spawnSync),
      // tehát minden ticknél meghívva a UI-t 0.42 s-onként fagyasztaná.
      // CSAK ÉLŐ SESSION MELLETT: answer-only módban nincs honnan számolni
      // (a findingok a review VÉGÉN, a válaszból jönnek).
      if (live.sessionAlive && elapsedMs - lastFindingAt >= findingMs) {
        lastFindingAt = elapsedMs
        try {
          // A HALMAZ-DIFF, nem a puszta darabszám: a user a diffben ül és KÖZBEN
          // ő is írhat, tehát a darabszám-növekmény nem az AGENT progressze.
          // Ugyanaz az érv, mint a végső gate-nél.
          const nowIds = hunkAgentNoteIds(live.repoRoot, { context: 'after' })
          live.findings = [...nowIds].filter((id) => !live.before.has(id)).length
        } catch {
          // A POLL HIBÁJA NÉMA — ÉS EZ ITT SZÁNDÉKOS, SZŰK KIVÉTEL.
          //
          // MIÉRT NEM HANGOS (a projekt tiltja a néma hibaelnyelést, tehát ez
          // indoklást igényel): ez a hívás CSAK a progressz-SZÁMLÁLÓT frissíti.
          // A VALÓDI gate a review VÉGÉN fut, ugyanezen a hunk-úton, és ott a
          // hiba HANGOS. Egy háttér-jelzés hibája nem kérhet nyugtázást a
          // usertől, és nem dönthet el egy futó review-t — ugyanaz a szerződés,
          // mint a háttér-poll csendes backoffjánál.
          //
          // AMI NEM TÖRTÉNIK: a régi `findings` érték MEGMARAD (nem nullázzuk),
          // tehát a jelzés nem "esik vissza" egy átmeneti hunk-hibán.
        }
      }
      // EGY TICK, KÉT FOGYASZTÓ (a 4. pont kikötése — nincs külön timer): az
      // `aiTick` lépteti a PANEL eltelt-idő-sorát (aiReviewPanelLines a friss
      // `Date.now()`-val) ÉS a lista-sor Braille-spinnerét (frame-index). A
      // render-költség ugyanaz, mint a régi label-diffes úté: ~1 render/s,
      // KIZÁRÓLAG futó review alatt (enélkül a fenti `if (!live)` korán kilép).
      setAiTick((t) => t + 1)
    }, tickMs)
    // AZ `unref()`: A SZIVÁRGÁS KÖVETKEZMÉNYE TŰNIK EL, NEM A SZIVÁRGÁS.
    //
    // MÉRT INDOK (adverzariális mutáció, MUT8'): a cleanup kiiktatva a
    // teszt-runner `✖`-et adott a leak-tesztre, DE UTÁNA BERAGADT — az
    // összefoglaló sor (`ℹ tests/pass/fail`) sosem íródott ki, 120 s után
    // SIGKILL kellett. CI-ben ez JOB-TIMEOUTKÉNT jelenik meg, nem bukott
    // tesztként, és a beragadás a TÖBBI teszt eredményét is elviszi.
    //
    // Egy unrefelt `setInterval` NEM tartja életben a Node event-loopját, tehát
    // egy bent maradt timer többé nem tud process-hangot okozni — se CI-ben, se a
    // TUI `q`-jánál. A TUI-ra ez NEM funkció-veszteség: az Ink render-loopját a
    // raw-mode stdin tartja életben, nem ez a ticker.
    //
    // AZ `unref` NEM VÁLTJA KI A CLEANUPOT: az továbbra is KELL (különben a
    // ticker egy leszerelt komponens `setAiTick`-jét hívná, és a `tickerCount`
    // sem állna vissza). A kettő MÁS problémát old meg: az `unref` a HANGOT, a
    // cleanup + a számláló a SZIVÁRGÁST MAGÁT (assertionnel mérhetően).
    //
    // Az `?.` az injektálható/nem-Node timer-implementációk miatt (a Node
    // `Timeout` objektumán megvan, egy sima számon nem).
    timer?.unref?.()
    return () => {
      clearInterval(timer)
      tickerCount -= 1
    }
    // A DEPENDENCY-LISTA MINIMÁLIS (mint a pollnál): az intervallum a komponens
    // életében egyszer jön létre, az állapot `ref`-en jön be. Egy `aiLive`-ot
    // tartalmazó lista minden review-indításnál újraindítaná a tickert.
  }, [aiTickMs, aiFindingPollMs])

  // (wf31/53) A STACKELÉS MOST MÁR INNEN IS INDÍTHATÓ — DE CSAK MÉRT FELTÉTELLEL.
  //
  // A user kérése: "a stackelést fel kellene ajánlani az info panel statusában
  // ebben a state-ben (pending UI-jal)". A mérés (`conflictAdvice`) ugyanis MÁR
  // eldönti, hogy van-e stack-cél — eddig csak a PARANCS volt kiírva, a usernek
  // kézzel kellett átgépelnie.
  //
  // A KORÁBBI DÖNTÉS ("MIÉRT NINCS doStack") NEM VOLT TÉVES, ÉS AZ OKA ITT IS ÉL:
  // a `publish --stack-on` a JELENLEGI LOKÁLIS branchen dolgozik (cmd_publish:
  // `${1:-$(current_branch)}` + need_next_work_branch), a TUI kiválasztott sora
  // viszont egy MÁR PUBLIKÁLT, REMOTE PR — a kettő tipikusan NEM ugyanaz. Vakon
  // futtatva azt a branchet publikálná, amin a user épp áll: rossz branch, idegen
  // PR-ra hivatkozó stack-céllal.
  //
  // AMI MEGVÁLTOZOTT: a feltétel MÉRHETŐ. A modell adja a `headRefName`-t, a
  // lokális HEAD-et a git megmondja — ha a kettő EGYEZIK, a művelet pontosan azon
  // a branchen fut, amiről a PR szól, és a régi kifogás nem áll fenn. Ha NEM
  // egyezik, NEM futtatjuk: a hiba KIMONDJA, melyik branchre kell váltani.
  //
  // A `spawnSync` + kimenet-elkapás a `doMerge` MINTÁJA (nem `suspendTerminal`):
  // a publish nem interaktív TUI, csak ír. VISZONT `git rebase`-t futtat, ami
  // CONFLICTBA futhat — és akkor a worktree félbehagyott rebase-ben marad. Ezt a
  // hibaág EXPLICIT kimondja, mert egy néma "nem sikerült" itt a legdrágább:
  // a user a TUI-ban ülne, miközben a repója konfliktusos állapotban áll.
  const doStack = useCallback((row, stackOn) => runExclusive(async () => {
    const want = typeof row?.headRefName === 'string' ? row.headRefName.trim() : ''
    if (want === '') {
      showError(row, 'a PR head branch-neve ismeretlen (adathiány a modellben), ezért a stackelést nem indítom — '
        + 'a parancsot a panel kiírja, futtasd a saját branchedről.')
      return
    }
    const head = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' })
    const at = head.status === 0 ? String(head.stdout ?? '').trim() : ''
    if (at === '') {
      showError(row, 'a lokális branch nem olvasható (git rev-parse), ezért a stackelést nem indítom.')
      return
    }
    // FAIL-CLOSED A BRANCH-ELTÉRÉSRE: nem "megpróbáljuk és majd kiderül" — a
    // publish MÓDOSÍTANÁ azt a branchet, amin a user áll.
    if (at !== want) {
      showError(row, `a stackelés a PR saját branchén fut, te viszont a(z) '${at}' branchen állsz `
        + `(a #${row.number} branche: '${want}'). Válts át rá, majd indítsd innen újra — `
        + 'vagy futtasd a panelben kiírt parancsot.')
      return
    }
    const res = spawnSync(
      'bash',
      [new URL('tuipr.sh', import.meta.url).pathname, 'publish', want, '--stack-on', String(stackOn)],
      { encoding: 'utf8' },
    )
    if (res.error) {
      showError(row, `a stackelés nem indítható (${res.error.code ?? 'spawn hiba'}): ${res.error.message}`)
      return
    }
    if (res.status !== 0) {
      // A BASH ÜZENETE A DIAGNÓZIS (nem a mi tippünk): a `classify_conflict` és a
      // `die`-ok beszédesek. Az UTOLSÓ sorok érdemiek — a fejlécet elhagyjuk.
      const err = String(res.stderr ?? '').trim() || String(res.stdout ?? '').trim()
      const tail = err.split('\n').slice(-3).join(' · ')
      showError(row, `a stackelés nem fejeződött be: ${tail || `exit ${res.status}`} `
        + '— HA REBASE-CONFLICT VOLT, a worktree félbehagyott rebase-ben áll: rendezd a shellben '
        + '(`git status`, majd `tuipr publish --finish`), mielőtt továbbmész.')
      return
    }
    setNotice(`#${row.number}: stackelve a #${stackOn} fölé`)
    await reloadAsync()
    // A `'s'` KULCS A PENDING-JELZÉSHEZ: a legend/lábléc ebből tudja, melyik
    // gomb dolgozik (a user kérése: "pending UI-jal").
  }, 's', row?.number), [reloadAsync, runExclusive, showError])

  // (wf31/73) AI-ASSZISZTÁLT CONFLICT-FELOLDÁS A TUI-BÓL — `v`.
  //
  // A user kérése: "Ne csak az analyze menjen a TUI-ba, hanem a feloldás is,
  // pending UI-jal. […] A resolve közben lehessen navigálni az appban. Resolve
  // előtt legyen confirmation."
  //
  // A VÉGREHAJTÁS A MEGLÉVŐ BASH ÚTON MEGY (`tuipr resolve <PR> --stack-on N
  // --apply`), nem párhuzamos JS-implementációval. Ott élnek azok az invariánsok,
  // amik a biztonságot adják — és egy második lánc garantáltan elcsúszna tőlük:
  //   · az ELDOBHATÓ WORKTREE (a rebase SOHA nem a user munkafáján fut),
  //   · a culprit ÚJRAMÉRÉSE (elavult diagnózisból idegen PR-ral szemben oldanánk),
  //   · a MARKER-ELLENŐRZÉS a végén (mért tény, nem az AI állítása).
  //
  // NAVIGÁLHATÓ PENDING: a `runExclusive` HARMADIK argumentuma a PR-szám, tehát a
  // futó feloldás a SORÁN jelenik meg, és a kurzor közben elmehet máshová (a
  // wf31/72-es minta). A feloldás 1-3 percig tart — ez pont az az eset, amiért a
  // navigálható pending készült.
  //
  // A KIMENET A NOTICE-BA ÉS A PANELBE: a bash a teljes elemzést a stdout-ra írja
  // (funkcionális összefüggés, feloldás-természet, fájlonkénti teendő). Azt NEM
  // parszoljuk itt újra — a részleteket a user a shellben olvassa; a TUI a TÉNYT
  // jelzi (sikerült-e, maradt-e marker), mert a panel nem log-nézet.
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
      showError(row, `a feloldás nem indítható (${res.error.code ?? 'spawn hiba'}): ${res.error.message}`)
      return
    }
    const out = `${String(res.stdout ?? '')}\n${String(res.stderr ?? '')}`
    if (res.status !== 0) {
      // A BASH ÜZENETE A DIAGNÓZIS (nem a mi tippünk): a `die`-ok beszédesek.
      const tail = out.trim().split('\n').filter((l) => l.trim() !== '').slice(-3).join(' · ')
      showError(row, `a feloldás nem fejeződött be: ${tail || `exit ${res.status}`}`)
      return
    }
    // A MARADÉK-MARKER TÉNYE A BASH KIMENETÉBŐL: azt ott MÉRTÜK (grep), tehát a
    // TUI nem újramér, csak közli. A `needs-decision` eset a user dolga.
    const leftover = /MARADT konfliktus-marker/.test(out)
    const clean = /TISZTÁN rebase-elhető/.test(out)
    setNotice(clean
      ? `#${row.number}: tisztán rebase-elhető a #${stackOn} fölé — nem volt mit feloldani`
      : leftover
        ? `#${row.number}: a feloldás EMBERI DÖNTÉST kíván (maradt marker) — a részletek a shellben`
        : `#${row.number}: feloldva a #${stackOn} culprittal (a kód a worktree-ben; nézd át a shellben)`)
    // A `'v'` KULCS + A SOR: a pending a során látszik, a kurzor közben szabad.
  }, 'v', row.number), [runExclusive, showError])

  // A merge a MEGLÉVŐ non-interaktív utat hívja (`tuipr merge <PR> --yes`).
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

    // A KÉT GUARD EGYÜTT, és MINDKETTŐ kell:
    //
    //   `actionLock.current` — a SZINKRON, RENDER-FÜGGETLEN igazság. Ez az, ami
    //     a SUSPEND ALATT is érvényes: az Ink ilyenkor ELDOBJA a rendereket
    //     (ink.js `onRender`: korai return `isSuspended`-en), tehát a lenti
    //     `busy` a closure-ben a SUSPEND ELŐTTI értéket hordozza. Enélkül a
    //     `d` alatt leütött `r`/`d` LEFUTOTT, a második `suspendTerminal` DOBOTT
    //     ("The terminal is already suspended"), és a `busy` beragadt.
    //   `busy` — a MEGJELENÍTETT állapot. Megtartjuk: a lock elengedése és a
    //     busy-render között van egy tick, és abban a résben a `busy` a helyes
    //     válasz (a UI még blokkoltnak látszik).
    // (wf31/72) A NAVIGÁCIÓ ÁTMEGY A PENDING-GUARDON — a user kérése.
    //
    // MIÉRT BIZTONSÁGOS, PEDIG A GUARD MÉRT BUGBÓL SZÜLETETT: az eredeti oka az
    // volt, hogy egy MÁSODIK AKCIÓ ne induljon a futó mellé (a `suspendTerminal`
    // dobott, a `busy` beragadt). A kurzormozgás viszont NEM akció: nem indít
    // processzt, nem nyúl a githubhoz, nem használ terminált — csak a `selectable`
    // indexét lépteti. A veszélyes halmaz változatlanul zárva marad.
    //
    // AZ ESC IS ÁTMEGY: a panel zárása szintén állapot-változás, nem akció.
    const navKeyOnly = input === 'j' || input === 'k'
      || key.downArrow || key.upArrow || key.escape
    if ((actionLock.current || busy) && !navKeyOnly) return

    // Megerősítés-mód: csak y/n értelmes.
    //
    // A 'y' a confirmAccepts TYPEAHEAD-KAPUJÁN megy át, nem közvetlenül. Ok: az
    // askAiReview blokkoló gh-hívása (~1s) alatt leütött 'y' az Ink raw-mode
    // pufferében megül, és a confirm ekrán mountolása UTÁN csapódik be — tehát a
    // megerősítő ekrán ELOLVASÁSA nélkül indítana token-költő `claude -p`-t. A
    // `busy` guard ezt strukturálisan nem tudja elkapni (a setBusy(true/false)
    // ugyanabban a szinkron blokkban fut, így soha nem renderel busy állapotot).
    // A HIBA-OVERLAY zárása MINDEN MÁS ELŐTT. Ok: amíg hiba van a képernyőn, a
    // többi kulcs (a 'y' is!) nem élhet — különben a pufferelt/vaktában leütött
    // gomb egy MÁSIK akciót indítana el azon a PR-on, aminek épp most hasalt el
    // egy művelete. BÁRMELY gomb zár (az Esc/q is): a nyugtázás ingyen van, és
    // egy "nem tudom, melyik gombbal lépek ki" állapot rosszabb, mint a korai
    // zárás. A hiba szövege a status-sorban ott marad.
    if (errorState) {
      setErrorState(null)
      return
    }

    // === A PANEL MODÁL MÓDJA: várakozó DÖNTÉS ===============================
    //
    // A user 2. elve: modálban a fel/le a VÁLASZTÁST lépteti, NEM a listát. A
    // `d`/`r`/`a`/`m` itt SZÁNDÉKOSAN nem éles (panelKeys mondja ki): egy
    // pufferelt vagy elgépelt gomb a döntés fölött egy MÁSIK visszavonhatatlan
    // akciót indítana el ugyanazon a PR-on.
    if (modal) {
      const confirm = modal
      // A REVIEW-ÚT váltása (Tab) NEM megerősítés és NEM megszakítás: az ekrán
      // nyitva marad, és az armedAt-ot SEM nullázzuk — a dwell azt méri, mióta
      // van az ekrán a szem előtt, és az út-váltás épp azt bizonyítja, hogy a
      // user olvassa. (Újra-armolás itt egy Tab-nyomkodással kikerülhetővé tenné
      // a kaput az ellenkező irányban: minden váltás újraindítaná a 250 ms-ot.)
      // A user kérése: NYÍLLAL váltsunk utat, ne Tabbal. A Tab MEGMARAD
      // alternatívaként (a muscle memory miatt), de a lábléc a nyilat hirdeti.
      //
      // EGY ÁGON él mind a három gomb, szándékosan: külön ágban a wrap-szabály
      // és az armedAt-kezelés szétcsúszhatna (az egyik armol, a másik nem — és a
      // dwell-kapu épp az, ami így kikerülhetővé válna). A léptetés a TESZTELT
      // stepIndex-en megy át, nem inline modulón.
      //
      // A 'b' (plafon be/ki) UGYANEZEN az ágon van, ugyanezért: ez sem
      // megerősítés és nem megszakítás, tehát az armedAt-hoz NEM nyúlhat. Ha
      // armolna, a plafon nyomkodásával a 250 ms-os kapu végtelenül újraindulna
      // — a védelem kikerülhetővé válna azon az úton, amit épp most adtunk hozzá.
      if (confirm.kind === 'ai-review' && input === 'b' && confirm.budget) {
        patchModal({ budget: budgetToggle(confirm.budget) })
        return
      }
      // (5b) AZ `m` A MODELL-VÁLTÓ — MIÉRT PONT AZ `m`, ÉS MIÉRT CIKLIKUS:
      //   - a megerősítés-módban az `m` SZABAD kulcs: a merge `m`-je a LISTÁN
      //     és az INLINE panelen él, ide (panelKeys szerint) el sem jut — a
      //     mnemonika (modell) pedig pontosan illik;
      //   - a közvetlen kulcsok (`o`/`s`/`f`) elvetve: az `f` a feltöltés
      //     hirdetett kulcsa (két jelentés egy betűn zavar), és három betű
      //     égetése egy háromelemű választékra aránytalan — a Tab-mintájú
      //     ciklikus váltó (mint a review-útnál) egy kulcsból megoldja;
      //   - az `armedAt`-hoz NEM nyúlunk (ugyanaz az érv, mint a 'b'/Tab
      //     ágnál: a váltó nem armolhatja újra a dwell-kaput).
      if (confirm.kind === 'ai-review' && input === 'm' && confirm.model) {
        patchModal({ model: modelStep(confirm.model, +1) })
        return
      }
      // (5) A REVIEW-ÚT VÁLTÁSA NYILAK NÉLKÜL (user: "zavar, hogy jobbra-balra
      // nyilat kell használnom"; az `R` nem használható — az a refresh):
      //   - Tab: CIKLIKUS váltó. Miért a Tab: eddig is működött (muscle memory),
      //     egyetlen billentyű, és nem ütközik a modál fel/le választó-listájával;
      //   - 1..N: KÖZVETLEN, determinisztikus választás (a legenda hirdeti).
      // A NYÍL a BUDGET-lépcsőé marad, amikor a plafon be van kapcsolva — így
      // egyik funkció sem oszt billentyűt a másikkal némán. Kikapcsolt plafon
      // mellett a nyíl NEM zárja a modált (az egy véletlen gesztusra eldobott
      // döntés lenne), hanem kimondja az új utat.
      // Az `armedAt`-hoz EGYIK ág sem nyúl: a váltó nem armolhatja újra a
      // dwell-kaput (meglévő invariáns, teszt védi).
      if (confirm.kind === 'ai-review' && (key.leftArrow || key.rightArrow)) {
        if (confirm.budget?.enabled === true) {
          patchModal({ budget: budgetStep(confirm.budget, key.leftArrow ? -1 : +1) })
          return
        }
        setNotice('a review-utat a Tab (váltás) vagy az 1/2 (közvetlen) választja — a nyíl nem')
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
        // A tartományon kívüli szám NEM zárja a modált (nem megszakítás-szándék).
        setNotice(`csak ${confirm.paths.length} review-út van — 1..${confirm.paths.length}`)
        return
      }
      // A NYILAS VÁLASZTÁS LÉPTETÉSE (a user 2. elve). A fel/le itt SOSEM a
      // listát mozgatja: a kurzor elmozdulása egy várakozó, visszavonhatatlan
      // döntés alól fegyver (ugyanaz a kockázat, amiért a háttér-poll sem tölt
      // újra magától).
      //
      // Az `armedAt`-hoz NEM nyúlunk: a léptetés nem megerősítés és nem
      // megszakítás, tehát a dwell-kaput nem indítja újra (ugyanaz az érv, mint a
      // 'b'/Tab ágnál — újra-armolás a nyíl nyomkodásával kikerülhetővé tenné).
      // A `modalHasChoices` KÖZÖS forrás a lábléccel és a body-val: ahol nincs
      // lista, a nyíl NEM lop billentyűt (és nem is hirdetjük — dead key lenne).
      // (wf31/69) A BALRA/JOBBRA IS LÉPTET — a user kérése, és a megjelenítés
      // iránya ezt kívánja (`▸ Nem   Igen` egy sorban). A fel/le MEGMARAD: a
      // korábbi izommemóriát nem törjük, csak a hirdetés vált vízszintesre.
      // A LÉPTETÉS IRÁNYA a képhez illik: jobbra/le = előre, balra/fel = vissza.
      if ((key.downArrow || key.upArrow || key.leftArrow || key.rightArrow)
        && modalHasChoices(confirm.kind)) {
        setChoiceIndex((i) => modalChoiceStep(i, key.downArrow || key.rightArrow ? +1 : -1))
        return
      }
      // AZ ENTER a KIVÁLASZTOTT ágat hajtja végre — DE NEM SAJÁT ÚTON.
      //
      // A 'NEM'-en zár (nincs hatás), és ez a NYITÓ állapot: egy vaktában leütött
      // Enter SOSEM indít semmit. Az IGEN-en pedig a `y`-ra NORMALIZÁLJUK, és a
      // továbbiakban a MEGLÉVŐ 'y'-út fut le.
      //
      // MIÉRT NORMALIZÁLÁS ÉS MIÉRT NEM KÜLÖN ÁG: egy önálló Enter-ág MEGKERÜLNÉ
      // a dwell-kaput, ha valaha kimaradna belőle a `confirmAccepts` — vagyis a
      // nyilas választás bevezetése egy KERÜLŐUTAT nyitna a legdrágább
      // (token-költő, illetve GitHubra posztoló) akciókhoz. Így a kapu-hívás és a
      // "túl korai" jelzés is EGY helyen él, és a source-invariáns tesztek
      // (verify-silent) egyetlen elfogadó pontot látnak.
      let effective = input
      if (key.return) {
        if (MODAL_CHOICES[choiceIndex]?.id !== 'yes') {
          // (wf28/1) A régi `restoreAiPrevDone()` hívás KIESETT. Kétszeresen is
          // halott volt: a `kind === 'ai-review'` modál MÁR NEM NYÍLIK MEG (lásd
          // az indító-ág fejét lentebb), és a mentés-visszaadás mechanizmus maga
          // is megszűnt (a menü-nyitás többé nem ír `aiReview` state-et).
          setPanel(panelToInline)
          setNotice('megszakítva')
          return
        }
        effective = 'y'
      }
      if (confirmAccepts(confirm, effective) && confirm.blockers.length === 0) {
        const { kind } = confirm
        const row = panel.row
        // VISSZA A PANELRE, nem a listára: a mért diagnózis ott marad, tehát az
        // akció után a user ugyanazt a képet látja, amiből döntött.
        setPanel(panelToInline)
        if (kind === 'approve') doApprove(row)
        if (kind === 'merge') doMerge(row)
        // (wf31/73) A CONFLICT-FELOLDÁS INDÍTÁSA — CSAK INNEN, a megerősítés után.
        //
        // A CÉL A MODÁLBÓL jön (`resolveModalProps` tette bele), NEM a render-időben
        // számolt `stackOffer`-ből: a modál nyitása és a `y` között a user
        // navigálhatott, és a mérés is befuthatott — egy render-időben újraolvasott
        // cél MÁS PR-ra indíthatná a feloldást, mint amit a kérdés megnevezett.
        // A modálba zárt érték ezt strukturálisan kizárja.
        if (kind === 'resolve' && Number.isInteger(confirm.stackOn)) doResolve(row, confirm.stackOn)
        // A GitHubra POSZTOLÓ feltöltés is CSAK innen indul (lásd az 'f' ágat).
        if (kind === 'upload') doUpload(row)
        // (2) AZ `ai-review` ÁG INNEN KIVEZETVE. A token-költő út MOSTANTÓL a
        // REVIEW-CASCADE-MENÜ `y`-ágán indul (lásd a useInput menü-ágát), a saját
        // dwell-kapu-hívásával — a bőbeszédű megerősítő modál megszűnt, tehát ez
        // az ág DEAD CODE volt (a `kind === 'ai-review'` modál már nem nyílik meg).
        //
        // MIÉRT TÖRÖLTEM, ÉS NEM HAGYTAM OTT "biztos, ami biztos": egy elérhetetlen
        // indító ág a legdrágább akcióhoz pont az a hely, ahol egy későbbi
        // módosítás NÉMÁN kerülőutat nyithat — és a source-invariáns tesztek is
        // ezt az ágat számolták az "egy elfogadó pont" bizonyítékának. A KÖTELEM
        // MEGMARADT, csak EGY helyre került: minden akcióhoz PONTOSAN EGY,
        // dwell-kapuval védett indító út tartozik.
        return
      }
      // A túl korai 'y'-t NEM tekintjük megszakításnak: az ekrán nyitva marad, és
      // EGY RÖVID sor jelzi, hogy nyomja meg újra. Ha itt bezárnánk, a user azt
      // hinné, hogy megszakadt, és újra elindítaná az egészet.
      //
      // MIÉRT NINCS ITT HOSSZABB MAGYARÁZAT: a mechanizmus indoklása (Ink
      // raw-mode puffer, typeahead) a fejlesztőt érdekli, nem a felhasználót — az
      // a kódkommentekben él (fentebb + core/confirmAccepts). A user kifogása
      // pontosan az volt, hogy a UI-ban ez a próza érthetetlen.
      // Az `effective` (nem a nyers `input`): a NORMALIZÁLT Enter-igen is ide
      // esik, ha a dwell még nem telt le — enélkül az Enter-út a "bármely más
      // gomb" ágra futna, tehát NÉMÁN BEZÁRNÁ a modált, és a user azt hinné,
      // megszakadt. Ez pont a fenti indoklás fordítottja, ugyanazon a jelzésen.
      if (effective === 'y') {
        setNotice('túl korai — nyomd meg újra')
        return
      }
      // BÁRMELY MÁS GOMB (az Esc és a q is): a MODÁL zárul, a TUI NEM lép ki.
      // A megszakítás sosem késleltetett (lásd a dwell aszimmetriáját): ingyen
      // van, tehát a pufferelt keypress is elvégezheti — az a fail-closed irány.
      // A 'q'/Esc itt szándékosan NEM kilépés: nyitott overlaynél a kilépés-ág
      // elérhetetlen (ez az ágsorrend teszt alatt van).
      //
      // A ZÁRÁS A PANELRE VISZ VISSZA (`panelToInline`), nem a listára — ez a
      // konszolidáció lényege: a "megnézem → cselekszem → meggondolom magam →
      // visszanézem" kör a panelen BELÜL zárul, és a mért diagnózis nem veszik el
      // egy meggondolt-magam gesztus miatt.
      // (wf28/1) A régi `restoreAiPrevDone()` hívás KIESETT — ugyanaz a két ok,
      // mint az Enter-normalizálás ágán: az `ai-review` modál nem nyílik meg, és
      // a mentés-visszaadás mechanizmus megszűnt.
      setPanel(panelToInline)
      setNotice('megszakítva')
      return
    }

    // === A PANEL INLINE MÓDJA: info + mérés + A KÖVETKEZŐ LÉPÉSEK ===========
    //
    // EZ A KONSZOLIDÁCIÓ LÉNYEGE. A régi kódban a `d`/`r`/`a`/`m` itt a "bármely
    // más gomb" ágra futott: NÉMÁN bezárta a panelt, és semmit nem indított — a
    // usernek ki kellett lépnie, hogy cselekedhessen ("megnézem → visszalépek →
    // cselekszem" hurok). Most a négy akció a panelen BELÜL él, ugyanazokkal a
    // gate-ekkel és megerősítésekkel, mint a listáról.
    //
    // Esc/q a FUTÓ mérést MEGSZAKÍTJA és bezár; a részeredményt a status-sor
    // jelzi ("mérés megszakítva 3/7 jelöltnél"). A j/k a panelen belül is
    // NAVIGÁL — átvált a szomszédos sorra és ott újraindítja a mérést. Ez a
    // "ne blokkolja a UI-t" követelmény konkrét alakja: a mérés alatt is lehet
    // mozogni, és a régi mérés eredménye nem szivárog át (a stale-védelem a
    // sor-számhoz köti a választ).
    // === (2) A REVIEW-CASCADE-MENÜ: az `r` ALOPCIÓI ==========================
    //
    // A MENÜ-ÁG A PANEL-ÁG ELŐTT ÁLL, és ez load-bearing: a menü a panel INLINE
    // módjában él, tehát a `panel` igaz — ha a panel-ág futna előbb, a menü
    // kulcsai (`tab`/`m`/`b`/`y`) a panel saját ágaira esnének. Konkrétan: az `m`
    // MERGE-MEGERŐSÍTÉST nyitna a modell-váltás helyett, a `y` pedig a "bármely
    // más gomb" ágra futva NÉMÁN BEZÁRNÁ a panelt. Az elsőbbség tehát nem
    // stílus: a menü nyitva LÉTE az, ami átveszi a kulcs-készletet.
    //
    // A MÁSIK HÁROM MEGERŐSÍTÉS (approve/merge/upload) ÉRINTETLEN: azok a
    // `modal` ágon futnak, ami MÉG ELŐBB van (a `modal` a `panel.mode`-ból jön).
    // Menü és modál egyszerre nem lehet nyitva: a menüt csak az inline panel `r`-je
    // nyitja, és a modál-nyitó ágak (`a`/`m`/`f`) a menü alatt nem élnek.
    if (reviewMenu) {
      const menu = reviewMenu
      // A MENÜ SORÁHOZ KÖTÖTT PR. Ha a panel közben MÁS sorra került (poll,
      // reload, egy race), a menü ELAVULT: bezárjuk, és NEM indítunk semmit.
      // FAIL-CLOSED, ugyanaz az elv, mint a mérés-callbackek `row.number !== pr`
      // guardjánál — egy sorhoz nem kötött menü egy MÁS PR-ra költene tokent.
      const mrow = panel && panel.row?.number === menu.pr ? panel.row : null
      if (mrow === null) {
        setReviewMenu(null)
        setNotice('a review-menü sora elmozdult — a menü bezárult, nyomj újra `r`-t')
        return
      }
      // AZ `esc`: az ELSŐ lépcsőn ZÁR, a MÁSODIKON VISSZALÉP (a user: "Esc: vissza").
      // A `q` IS zár — nyitott menünél a kilépés-ág elérhetetlen, ugyanaz a
      // szerződés, mint a modálnál (a `q` ott sem lép ki a TUI-ból).
      if (key.escape || input === 'q') {
        const back = reviewMenuBack(menu)
        setReviewMenu(back === null ? null : { ...menu, ...back })
        // (wf31/2) A "megszakítva" STATUS-JELZÉS KIVEZETVE. A USER LELETE, szó
        // szerint: "Info dobozban nyomogatom az r-t és az esc-et odavissza, a
        // képernyő alján »megszakítva« van. Utána megint 'r', ekkor
        // »dolgozom...«, majd visszaáll »megszakítva« feliratra. Elég
        // inkonzisztens."
        //
        // A HIBAOSZTÁLY: a "megszakítva" azt ÁLLÍTJA, hogy egy FUTÓ MUNKA
        // szakadt meg. A menü megnyitása és elvetése viszont SEMMIT nem indított
        // el (a token-költő út a `y`-ágon kezdődik) — nincs mit megszakítani.
        // Ez ugyanaz a HAZUG-JELZÉS osztály, mint a #904-es gyűjtőág-
        // "megszakítva": a szöveg olyan eseményt mond ki, ami nem történt meg.
        //
        // ÉS A KÁR NEM CSAK PONTATLANSÁG: a status-sor BERAGAD (a következő
        // valódi jelzésig ott áll), tehát a user egy statikus UI-váltás után
        // MINDVÉGIG egy hamis "megszakítva"-t lát a képernyő alján — épp azt az
        // inkonzisztenciát, amit bejelentett.
        //
        // A MENÜ-NYITÁS/ZÁRÁS TEHÁT NÉMA: az `Esc` egyszerűen visszaáll. A
        // gesztus eredménye MAGÁN A KÉPEN látszik (a menü eltűnik) — egy
        // status-sor nem tud hozzátenni semmit, csak zavarni.
        //
        // AMI VÁLTOZATLAN: a VALÓDI megszakítások TOVÁBBRA IS jeleznek (a futó
        // AI-review `x`-e, a mérés Esc-e a `mérés megszakítva N/M jelöltnél`
        // szöveggel) — ott a jelzés IGAZ, mert tényleg futott valami.
        return
      }
      // A CIKLIKUS VÁLTÓK. Az `armedAt`-hoz EGYIK SEM nyúl — a `reviewMenuStep`
      // gépileg őrzi (teszt alatt), tehát a dwell-kapu itt nem armolható újra.
      if (key.tab) { setReviewMenu(reviewMenuStep(menu, 'path', +1)); return }
      if (input === 'm') { setReviewMenu(reviewMenuStep(menu, 'model', +1)); return }
      if (input === 'b') { setReviewMenu(reviewMenuStep(menu, 'budget', +1)); return }
      // AZ `r` A MENÜT ZÁRJA (toggle): a hirdetett kulcs a helyén marad, tehát a
      // második nyomásra változást KELL adnia — enélkül a user nem tudná, hogy a
      // gomb nem működik, vagy a UI fagyott le.
      if (input === 'r') {
        // (wf28/1) A TOGGLE-ZÁRÁS SEM TAKARÍT ÁLLAPOTOT: a nyitás nem írt
        // `aiReview` state-et (a régi `restoreAiPrevDone()` hívás kiesett).
        setReviewMenu(reviewMenuToggle(menu))
        return
      }
      // A `y`: A DWELL-KAPUN ÁT. A kapu VÁLTOZATLANUL a core `confirmAccepts`-e —
      // NEM írtunk rá második elfogadó pontot, mert a source-invariáns tesztek
      // (verify-silent) egyetlen elfogadó pontot látnak, és egy önálló ág
      // MEGKERÜLHETNÉ a kaput, ha valaha kimaradna belőle a hívás.
      //
      // A KAPU AZ ELSŐ `y`-ON él (a user kötelme). A második lépcső ugyanazt az
      // `armedAt`-ot hordozza, tehát ott a kapu MÁR ÁTMENT — nem kér új 250 ms-ot.
      if (input === 'y') {
        if (!confirmAccepts({ armedAt: menu.armedAt }, 'y')) {
          // A túl korai `y` NEM megszakítás: a menü nyitva marad, és EGY rövid
          // sor jelzi, hogy nyomja meg újra. Ha itt bezárnánk, a user azt hinné,
          // hogy megszakadt, és újra elindítaná az egészet.
          setNotice('túl korai — nyomd meg újra')
          return
        }
        // (wf28/1) MÁSODIK VONAL A MÉG BE NEM ÉRKEZETT MÉRÉSRE — ÉS AMI MÉRVE AZ
        // ELSŐ VONAL. A menü mostantól a blokkoló `fetchPrFiles` ELŐTT nyílik meg
        // (hogy éles PR-on ne kelljen a gh ~1 másodpercét visszajelzés nélkül
        // kivárni), tehát a `size` egy ideig `null`.
        //
        // MÉRT TÉNY, AMIT NEM SZABAD ELHALLGATNI: ez az ág KEZELÉSSEL SEM
        // ÉRHETŐ EL a billentyűzetről. Az `askAiReview` a `runExclusive` LOCKJA
        // alatt fut, és a mérés VÉGÉIG nem engedi el (nincs korai `release`), a
        // `useInput` pedig a legelső guardján (`if (actionLock.current || busy)
        // return`) MINDEN leütést eldob. A `size: null` ablak tehát pontosan
        // egybeesik azzal az idővel, amíg gomb sem jut el ide. MÉRVE: egy
        // lassított gh-val (`slowPrFilesSec`) írt teszt NEM tudta kiváltani a
        // jelzést — ezért NINCS rá teszt, és ezt itt KIMONDJUK, nem hagyjuk egy
        // ál-zöld tesztre bizonyítani.
        //
        // AKKOR MIÉRT VAN ITT: mert a védendő kár NÉMA és DRÁGA. Ha a lock-guard
        // valaha lazul (korai `release`, vagy a menü-ág a `busy` elé kerül), a
        // `reviewMenuWarning({})` `large:false`-ot látna, `null` figyelmeztetést
        // adna, és a `reviewMenuAdvance` AZONNAL `run`-ra menne — egy 45 fájlos
        // PR-on a nagy-PR figyelmeztetés NÉMÁN KIMARADNA, és a token-költés a
        // MÁSODIK lépcső friction-je NÉLKÜL indulna. A mérés HIÁNYA nem
        // jelenthet "nincs mire figyelmeztetni"; ez az ág ezt szögezi le a
        // TÍPUS szintjén (`null` ≠ "kicsi PR"), a lockra való hagyatkozás
        // helyett.
        if (menu.size === null || menu.size === undefined) {
          setNotice('a PR méretének mérése még tart — nyomd meg újra a y-t')
          return
        }
        // A FIGYELMEZTETÉS a MÉRT méretből, A `y` PILLANATÁBAN — nem a state-ben
        // tárolt (elavulható) szövegből. A küszöb-döntés (`large`) a core
        // `aiReviewSummary`-jából jött, a tömörítés a `reviewMenuWarning`-é.
        const warning = reviewMenuWarning(menu.size)
        const step = reviewMenuAdvance(menu, { warning })
        if (step.action === 'advance') {
          // MÁSODIK LÉPCSŐ: a figyelmeztetés + `y`/`esc`. Nem indul semmi.
          setReviewMenu({ ...menu, ...step.state })
          return
        }
        if (step.action !== 'run') return
        // INDÍTÁS. A menü ZÁRUL, és a MENÜBEN LÁTOTT paraméterek mennek át —
        // `reviewMenuSelection` EGY forrásból, tehát a megjelenített és az élő
        // paraméter nem tud szétcsúszni (a mért lelet, amiből a modell-választó
        // született: a user egy Fable-futáson vesztette el a teljes keretét).
        const sel = reviewMenuSelection(menu)
        setReviewMenu(null)
        doAiReview(mrow, sel.maxBudgetUsd, sel.reviewPath, sel.model)
        return
      }
      // BÁRMELY MÁS GOMB: a MENÜ NYITVA MARAD, és a status-sor kimondja, mi éles.
      //
      // MIÉRT NEM ZÁR (szemben a panel "bármely más gomb" ágával): a menü egy
      // VÁRAKOZÓ, token-költő döntés, és a `j`/`k`/`d`/`a`/`f` itt SZÁNDÉKOSAN
      // nem éles — ugyanaz az érv, amiért a modál `panelKeys`-e sem engedte át
      // őket: egy pufferelt vagy elgépelt gomb a döntés fölött egy MÁSIK akciót
      // indítana ugyanazon a PR-on. A néma zárás viszont pont az a "megszakadt?"
      // bizonytalanság, amit a túl-korai-`y` ágnál is kizárunk.
      setNotice('a review-menüben a tab/m/b vált, a `y` indít, az `esc` visszalép')
      return
    }

    if (panel) {
      const prow = panel.row
      if (key.escape || input === 'q') {
        const wasRunning = panel.progress?.running === true
        stopDiagnosis()
        // A megszakított mérés RÉSZeredményét kimondjuk a status-sorban: a
        // néma bezárás azt a képet adná, hogy a mérés lefutott.
        // A SZÖVEG a progressLabel-ből jön, nem itt épül újra: két forrásból a
        // panel és a status-sor elcsúszhatott volna (a "0/0 jelöltnél" hazug
        // alakját is csak az egyik helyen javítottuk volna).
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
      // A NÉGY AKCIÓ A PANELEN BELÜL. Ugyanazokat a helpereket hívják, mint a
      // listáról — NEM másolt ágak: egy duplikált gate (pl. a canApproveRow
      // kihagyása itt) NÉMÁN engedne át egy tiltott approve-ot.
      //
      // A MÉRÉS LEÁLLÍTÁSA az AKCIÓ-ágakon: a `d` átveszi a terminált (hunk), az
      // `r` és a modál pedig blokkoló I/O-t végez. Egy háttérben futó merge-tree
      // próba ezek alatt vagy zombiként maradna hátra, vagy egy már lecserélt
      // panel state-jébe írna. A `stopDiagnosis` mindkettőt kizárja.
      // (wf31/6) A `d` A KÉSZ REVIEW MEGNYITÓJA IS — az `r` HELYETT.
      //
      // A USER LELETE, szó szerint: "érkezett review esetén ne az 'r' nyissa meg
      // a review-t, hanem a 'd'. hunk-ban úgyis el lehet rejteni a notes-okat,
      // tehát sokkal értelmesebb."
      //
      // MIÉRT JOBB, ÉS MIÉRT NEM VESZÍT SEMMIT: a `d` MINDIG a diff-nézetet
      // nyitja — a findingok jelenléte ezen nem VÁLTOZTAT, csak GAZDAGÍTJA
      // (`--agent-notes`). A "csak a diffet akarom" igény is kielégített, mert a
      // hunk maga tudja elrejteni a note-okat. Az `r` ezzel VISSZANYERI az
      // EGYETLEN jelentését: "review-t INDÍTOK" — a korábbi alakban ugyanaz a
      // gomb az életciklustól függően INDÍTOTT vagy NYITOTT, ami két ellentétes
      // költség-profilú műveletet mosott össze (ingyen vs. tokenköltő).
      if (input === 'd') {
        stopDiagnosis()
        void openReview(prow, { agentNotes: hasAnyFindings(prow.number) })
        return
      }
      // (wf31/72) A PENDING SORON NINCS PARANCS — a user kikötése: "a pending PR
      // info panelje maradjon pending (ne fogadjon parancsot)".
      //
      // A NAVIGÁCIÓ (`j`/`k`) ÉS A ZÁRÁS (`Esc`/`⏎`) FÖLÖTTE ÁLL ebben az ágban,
      // tehát azok élnek — csak az AKCIÓK esnek ki. A panel a futó approve alatt is
      // lapozható, de a hátrahagyott PR-on nem indítható semmi.
      //
      // A FELTÉTEL A SORRA NÉZ, NEM A GLOBÁLIS `busy`-ra: egy MÁSIK PR-on állva a
      // parancsok élnek (a `runExclusive` lockja úgyis egyszerre egy akciót enged).
      if (pendingPr !== null && prow?.number === pendingPr) return
      // (wf31/10) A `c` A CONFLICT-MÉRÉST INDÍTJA — a panel-nyitás már NEM méri.
      // A `stopDiagnosis` NEM kell ide: a `measureConflict` maga zárja le a
      // futó mérést (egy mérés fut egyszerre), és a cache-találatot is kezeli.
      if (input === 'c') { measureConflict(prow); return }
      // AZ `r` CSAK INDÍT (vagy hangosan jelzi, miért nem) — lásd `rKeyAction`.
      if (input === 'r') { stopDiagnosis(); rKeyAction(prow); return }
      if (input === 'a') { openModal(prow, approveModalProps(prow)); return }
      if (input === 'm') { openModal(prow, mergeModalProps(prow)); return }
      if (input === 'f') { openModal(prow, { kind: 'upload', blockers: [] }); return }
      // (wf31/53) AZ `s` A STACKELÉS — CSAK AKKOR ÉLES, HA A MÉRÉS AJÁNLATOT ADOTT.
      //
      // A forrás UGYANAZ, amiből a lábléc hirdeti (`stackOffer`), tehát a kulcs és a
      // címke nem tud szétcsúszni — ez a projekt MÉRT hibaosztálya (hirdetett, de
      // halott gomb). Ajánlat nélkül a leütés NEM esik a "bármely más gomb" ágra
      // (az zárná a panelt), hanem NÉMÁN elnyelődik: a `panelKeys` az `s`-t élesnek
      // jelöli, tehát a panel a sajátjának tekinti.
      if (input === 's') {
        if (stackOffer !== null) doStack(prow, stackOffer)
        return
      }
      // (wf31/73) A `v` A CONFLICT-FELOLDÁS — MEGERŐSÍTÉS UTÁN.
      //
      // A forrás UGYANAZ, amiből a body hirdeti (`stackOffer` → a mért, EGYETLEN
      // culprit), tehát a hirdetés és a kulcs nem tud szétcsúszni. Ajánlat nélkül
      // a leütés NÉMÁN elnyelődik (a `panelKeys` élesnek jelöli, tehát a panel a
      // sajátjának tekinti — nem esik a "bármely más gomb" záró ágra).
      //
      // MODÁL, NEM KÖZVETLEN INDÍTÁS: a feloldás AI-t hív (token) ÉS kódot ír —
      // ugyanaz a kapu, mint az approve/merge előtt (a user kérése: "Resolve előtt
      // legyen confirmation").
      if (input === 'v') {
        if (stackOffer !== null) openModal(prow, resolveModalProps(prow, stackOffer))
        return
      }
      // Az `x` (megszakítás / elvetés, DUPLA nyomással) a NYITOTT PANELEN IS él
      // — a progressz-sor (és vele a hirdetett `x`) a panelben lakik, tehát a
      // gombnak ott kell működnie, ahol hirdetjük. Enélkül az `x` a "bármely
      // más gomb" ágra futna, és a panelt zárná a review helyett (mérve).
      if (input === 'x') { xKey(prow); return }
      // (wf31/30) AZ ENTER A PANELT ZÁRJA — TOGGLE. A user kérése: "Info panel:
      // Enter is zárja be (tehát az Enter önmagában toggle-ként viselkedik).
      // Ettől még az esc is bezárhatja, de Enter legyen az infó legendben is".
      //
      // MIÉRT HELYES (a korábbi „drill in" érv felülvizsgálva): a LISTÁN az Enter
      // NYITJA a panelt, tehát ugyanaz a gomb a ZÁRÁSRA a legkisebb tanulási
      // teher — egy gomb, egy fogalom („részletek ki/be"). A korábbi alak (Enter
      // = caveat-toggle) azt kívánta, hogy a user KÉT jelentést tartson észben
      // ugyanarra a kulcsra, attól függően, hol áll.
      //
      // A KULCS AZÁLTAL SZABADULT FEL, hogy a caveat-toggle MEGSZŰNT: a mérési
      // részletek mostantól mindig látszanak (két állapot: van mérés / nincs).
      //
      // AZ ÁG EXPLICIT, nem a lenti „bármely más gomb"-ra hagyva: a `panelKeys`
      // hirdeti a `'return'`-t, és egy hirdetett kulcsnak a kezelője is látszódjon
      // — különben a következő olvasó nem találja meg, mi történik Enterre.
      if (key.return) {
        stopDiagnosis()
        setPanel(panelClose)
        return
      }
      // Bármely MÁS gomb: bezárás. A futó mérés itt is kill-elődik — a panel
      // nélkül nincs hova beilleszteni az eredményt.
      stopDiagnosis()
      setPanel(panelClose)
      return
    }

    // 'x' = A FUTÓ HÁTTÉR-REVIEW MEGSZAKÍTÁSA (#904).
    //
    // MIÉRT KELL LÁTHATÓ MEGSZAKÍTÁSI ÚT: a user 5 percig várt, és NEM TUDTA,
    // hogy leállíthatja-e. A `q` ugyan megölte volna, de az a TUI-t is bezárja —
    // a "csak a review-t állítom le, a listán maradok" gesztusra NEM volt út.
    //
    // MIÉRT `x` ÉS NEM Escape: az Escape a listán ma KILÉPÉS (lásd lentebb), és a
    // két jelentés (megszakítás vs. kilépés) ugyanazon a gombon összecsúszna. Az
    // `x` a PANEL progressz-sorának VÉGÉN HIRDETVE van (aiReviewPanelLines), tehát a
    // user pontosan ott látja, ahol a várakozás zajlik.
    if (input === 'x') {
      // A DUPLA-nyomásos közös kezelő (xKey): futó review-n abort, kész
      // review-n elvetés — az első `x` mindkét úton csak ÉLESÍT. A `'user'`
      // OK-szemantika (aborted vs. killed-by-exit vs. timeout) az xKey-ben él.
      xKey(current ?? null)
      return
    }

    // A KILÉPÉS MINDKÉT HÁTTÉR-CHILDOT lezárja: a merge-tree mérőt ÉS a
    // háttér-review claude-ját. Enélkül a `q` után egy futó `claude -p` írna egy
    // olyan hunk-sessionbe, amit már senki nem néz át.
    //
    // A FIGYELMEZTETÉS ELŐRE (#904) — A KILL ELKERÜLHETETLEN, TEHÁT KIMONDJUK.
    //
    // A `claude -p` a hunk sessionbe ÍR, ezért detachelni NEM lehet (a hazug
    // provenance indoklása a `stopAiReview` fejénél). A kilépés tehát MEGÖLI a
    // futó review-t — és a #904-es user esetében ez volt a legvalószínűbb valódi
    // vég: a review órákkal korábban meghalt, a user meg csak a resume utáni
    // full redraw-ban látta a szöveget. Ha a kill elkerülhetetlen, akkor legalább
    // a KILÉPÉS PILLANATÁBAN kérdezzük meg — utólag közölni már késő.
    // A MEGERŐSÍTÉS ÁLLAPOTA ELŐBB DÖNT, mint bármely más billentyű: amíg a
    // kérdés nyitva van, a lista kulcsai NEM élnek (különben egy `j` némán
    // elnyelné a kérdést, és a user azt hinné, kilépett).
    if (exitConfirm) {
      // CSAK a 'y' (és a nagy 'Y') lép ki. A fail-closed irány a MARADÁS: egy
      // pufferelt keypress ne vigye el a futó review-t.
      if (input === 'y' || input === 'Y') {
        stopDiagnosis()
        // A `'exit'` OK: a `killed-by-exit` végállapot ebből lesz. (A TUI ugyan
        // leszerel, tehát a szöveget itt már nem látjuk — a HELYE viszont az
        // állapotgépben van, és a core `reason`-je MÉRT tény.)
        stopAiReview('exit')
        exit()
        return
      }
      setExitConfirm(null)
      // (wf31/9) EGY OK, EGY VISSZAJELZÉS: a kérdés már csak a futó review miatt
      // jelenhet meg (a pending-ág kivezetve), tehát a `kind`-ra ágazás is
      // megszűnt. Egy megtartott ternária itt HOLT ÁG lenne — és a következő
      // olvasó azt hinné, hogy a pending-út még él.
      setNotice('a kilépés elvetve — az AI-review tovább fut')
      return
    }
    if (input === 'q' || key.escape) {
      if (aiHandle.current) {
        // (wf31/9) A `kind` MEZŐ KIVEZETVE: a kérdésnek MÁR CSAK EGY oka van (futó
        // review), tehát egy megkülönböztető mező holt információ lenne — a
        // következő olvasónak azt sugallná, hogy több ág is él. A state így sima
        // `true`: a "van-e nyitott kilépés-kérdés" az EGYETLEN tény, amit hordoz.
        setExitConfirm(true)
        return
      }
      // (wf31/9) A BETÖLTETLEN FINDINGOK MIATT NINCS KILÉPÉS-KÉRDÉS.
      //
      // A USER DÖNTÉSE, szó szerint: "Ez a prompt NEM kell. A cache maradjon
      // automatikus default, nem kell erről tájékoztatni a usert."
      //
      // MIÉRT HELYES EZ (és miért volt a régi kérdés hibás): a guard a
      // memória-only cache korából maradt, amikor a kilépés TÉNYLEGESEN eldobta a
      // kifizetett findingokat — ott a kérdés valódi adatvesztést előzött meg. A
      // disk-cache (review-store) óta a findingok a `/tmp`-ben megvannak, és az
      // indulás visszaolvassa őket. A guard tehát MÁR NEM adatvesztést előzött
      // meg, csak a CACHE MŰKÖDÉSÉRŐL tájékoztatott — egy implementációs
      // részletről, ami a usernek nem döntés. Egy kérdés, amire a válasz
      // gyakorlatilag mindig `y`, nem friction, hanem súrlódás.
      //
      // AMI MEGMARAD: a FUTÓ review kilépés-guardja (fentebb, `kind: 'running'`).
      // Az MÁS hibaosztály — ott a kilépés egy FOLYAMATBAN LÉVŐ, tokent költő
      // futást szakít meg, tehát valódi, visszafordíthatatlan veszteség a tét.
      stopDiagnosis()
      stopAiReview('exit')
      exit()
      return
    }
    if (input === 'j' || key.downArrow) { setIndex((i) => Math.min(selectable.length - 1, i + 1)); return }
    if (input === 'k' || key.upArrow) { setIndex((i) => Math.max(0, i - 1)); return }
    // 'R' = GLOBÁLIS REFRESH + TELJES cache-invalidálás.
    //
    // A NAGY 'R' azért szabad, mert az AI-review a kis 'r'-re került. A KÉT
    // FUNKCIÓ SZÉTVÁLASZTVA: a refresh a KÉP frissítése (queue + main-SHA +
    // cache-dobás), az AI-review token-költés — a régi kis-r/nagy-R pár (hunk vs.
    // AI) tipográfiailag túl közel volt ahhoz, hogy egy elgépelés ne kerüljön
    // pénzbe.
    //
    // A refresh a SOR-KIVÁLASZTÁST is megőrizheti-e? NEM garantáljuk: a queue
    // tartalma változhatott (egy PR landolt), és egy megőrzött index MÁS sorra
    // mutatna, mint amire a user nézett. Az index clampelése (lásd lentebb) a
    // fail-safe; a kurzor átrendezését maga a refresh EXPLICIT user-gesztus
    // igazolja — épp ezért NEM csinálja ezt magától a háttér-poll.
    if (input === 'R') {
      // A NYITOTT MÉRÉST le kell állítani: a refresh utáni cache-dobás után a
      // befutó eredménynek nincs hova beilleszkednie (és a horgonya is a régi).
      stopDiagnosis()
      setPanel(panelClose)
      // (wf31/26) AZ `R` IS PENDING-JELZÉST KAP (`R: refresh (fut…)`) — a user
      // kérése: "Global »R: refresh«-en nincs pending, legyen".
      //
      // MIÉRT NEM A `runExclusive`-BA TETTEM (ami a `busy`-t és a jelzést együtt
      // adja): a `reload` NEM exkluzív akció — hívja a `d` utáni puha újratöltés,
      // a poll és a merge/approve utáni frissítés is. Ha az `R` foglalná a lockot,
      // egy háttér-reload alatt leütött `R` NÉMÁN elhalna (a `runExclusive` első
      // guardja `false`-szal visszatér). A jelzést tehát KÖZVETLENÜL állítjuk, a
      // lock nélkül.
      //
      // A `setTimeout(0)` LOAD-BEARING, ugyanaz a hibaosztály, amit a
      // `runExclusive` fejénél már kimértünk: a `reload` SZINKRON spawnSync-eket
      // futtat (mérve ~2,5 s), tehát a `setBusy(true)` és a `finally`-beli
      // `setBusy(false)` UGYANABBAN a szinkron blokkban futna le — a React sosem
      // jutna render-flush-hoz, és a jelzés NEM JELENNE MEG. A tick engedi a
      // fát kirenderelni, MIELŐTT a blokkoló hívások indulnak.
      //
      // A `finally` KÖTELEM: ha a `reload` dob (nem-git cwd, gh-hiba), a jelzés
      // BERAGADNA — a legend örökre `(fut…)`-ot mutatna egy nem futó akcióra.
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

    // 'd' = DIFF-review: a lokális hunk-diff, ingyen. A mnemonika a 'd' (diff),
    // és ez szabadítja fel a kis 'r'-t az AI-review-ra — a korábbi kis-'r' /
    // nagy-'R' pár (hunk vs. AI) tipográfiailag túl közel volt egymáshoz.
    //
    // (wf31/6) A `d` A KÉSZ REVIEW MEGNYITÓJA IS — az `r` helyett.
    if (input === 'd') { void openReview(current, { agentNotes: hasAnyFindings(current.number) }); return }
    // 'r' = AI-REVIEW ÉLETCIKLUS-KULCS. Külön billentyű a 'd'-től, mert MÁS a
    // költség-profilja: a 'd' ingyen van (lokális diff), az 'r' a fejlesztő
    // Claude-tokenjét fogyasztja. NYUGALMI állapotban az ág CSAK a megerősítő
    // ekrányt nyitja meg — claude-ot innen SOSEM indítunk (lásd a confirm y-ágát).
    //
    // (wf31/6) A `done` ÁG MINT MEGNYITÓ MEGSZŰNT: a megnyitás a `d` dolga.
    //
    // AZ `r` KÉSZ ÁLLAPOTBAN VISZONT NEM INDÍTHAT ÚJAT SEM, ÉS EZ NEM
    // ELHAGYHATÓ: az `askAiReview` guardja CSAK a FUTÓ review-t zárja ki
    // (`aiHandle`), a be nem töltött, KIFIZETETT findingokat NEM — egy ide
    // eresztett `askAiReview` tehát némán egy MÁSODIK fizetős review-t nyitna, és
    // az elsőnek a findingjait a következő betöltés felülírná. Az új indítás
    // előfeltétele VÁLTOZATLANUL az EXPLICIT elvetés (dupla-`x`), amit a
    // `done`-címke (`x: review elvetése`) hirdet is.
    if (input === 'r') { rKeyAction(current); return }
    // (wf31/10) A `c` A LISTÁN IS ÉL: megnyitja a panelt ÉS elindítja a mérést.
    //
    // MIÉRT NYIT PANELT IS: a mérés EREDMÉNYE a panelben látszik (a mért sáv), egy
    // panel nélküli mérés tehát a listán csak a `⋯` jelzőt adná, és a user nem
    // tudná, hova nézzen. A `c` így EGY gesztusban adja a szándékot: "mutasd meg,
    // és mérd is meg".
    //
    // A SORREND KÖTÖTT: `openInfo` ELŐBB (az állítja be a panel state-jét, amibe a
    // `measureConflict` a progresszt írja), a mérés UTÁNA. Fordítva a
    // `setPanel((cur) => …)` frissítés egy MÉG NEM LÉTEZŐ panelre futna, és a
    // progressz némán elveszne.
    if (input === 'c') { openInfo(current); measureConflict(current); return }
    // ENTER (+ 'i' csendes alias) = INFO/MIÉRT — EGY panel a korábbi 'c' + 'i'
    // helyén. A gyors rész azonnal látszik, a merge-tree mérés háttérben,
    // progresszíven töltődik be, és Esc-cel megszakítható. NINCS `busy`: a UI
    // szándékosan használható marad.
    //
    // MIÉRT AZ ENTER AZ ELSŐDLEGES (user-kérés: "a lenyíló »i« helyett lehetne
    // Enterre"): a panel a kiválasztott sor KINYITÁSA — és listában az „nyisd ki
    // ezt a sort" gesztus univerzálisan az Enter. Az `i` egy betű-mnemonika volt
    // ("info"), ami a panel EGYESÍTÉSE után (info + mérés + lépések) már nem is
    // fedi a tartalmat.
    //
    // AZ 'i' CSENDES ALIASKÉNT MARAD, de a legenda NEM hirdeti. Két hirdetett
    // kulcs ugyanarra a funkcióra zajt ad a szűk láblécben; a megtartása viszont
    // ingyen van, és nem hasal el némán annak, akinek a keze már megtanulta.
    //
    // AZ ENTER NEM LOP KULCSOT: a modál-ág (`if (modal)`) ELŐBB fut, és a
    // `key.return`-t ott a NYITÓ „Nem" választásra képezi le, majd `return`-nel
    // elvágja — egy várakozó, visszavonhatatlan döntés fölött tehát SOSEM nyílik
    // meg innen panel. A panel-ág (`if (panel)`) szintén előbb áll: nyitott
    // panelen az Enter a MÉRÉSI CAVEAT lábjegyzetét nyitja/csukja (saját ág, a
    // az Enter a panelt zárja) — tehát ez a sor CSAK zárt panel mellett fut, és
    // ott a panel megnyitása a dolga.
    //
    // A SZEMANTIKA EGYIRÁNYÚ, ÉS EZ SZÁNDÉKOS: az Enter MINDIG "nyisd ki a
    // következő szintet" (lista → panel, panel → caveat-lábjegyzet). A korábbi
    // alak a panelen ZÁRT, tehát ugyanaz a gesztus két ellentétes irányba
    // mutatott; a zárás az `Esc`/`q` dolga, amit a lábléc is hirdet.
    if (key.return || input === 'i') { openInfo(current); return }
    // 'f' = a MEGMARADT hunk-findingok FELTÖLTÉSE GitHubra. Megerősítés-köteles,
    // mint az 'r'/'a'/'m': ez egy KÍVÜLRŐL LÁTHATÓ, visszavonhatatlan akció — a
    // PR-on megjelenik egy review a te nevedben, a szerző értesítést kap. Egy
    // pufferelt vagy elgépelt 'f' azonnal posztolt volna (a 'd' melletti
    // billentyű!). A kapu ugyanaz a dwell-kapu (confirmAccepts), tehát a
    // pufferelt gombnyomás sem tud átcsúszni rajta.
    //
    // A darabszámot MÉG NEM tudjuk (azt a doUpload olvassa ki a hunkból) — és
    // szándékosan nem is mérjük itt: a hunkComments blokkoló I/O, ami dobhat is
    // (pozíció-hiba), és egy megerősítő ekrány, ami maga elhasal, rosszabb, mint
    // a doUpload hangos hibája a status-sorban.
    if (input === 'f') { openModal(current, { kind: 'upload', blockers: [] }); return }
    // AZ APPROVE/MERGE BLOKKOLÓI EGY forrásból (approveModalProps/mergeModalProps).
    // A listáról és a PANELRŐL is ugyanaz az ág fut — egy másolt gate itt NÉMÁN
    // engedne át egy tiltott approve-ot azon az EGY úton, amit elfelejtettünk.
    if (input === 'a') { openModal(current, approveModalProps(current)); return }
    if (input === 'm') { openModal(current, mergeModalProps(current)) }
  })


  // AZ OVERLAY-ÁLLAPOT: a confirm ÉS az info EGY fogalom a render szempontjából.
  // Sorrend: a confirm nyer, mert az VÁRAKOZÓ DÖNTÉS (a megerősítés nélkül a
  // token-költő/posztoló akció nem indul el), az info pedig csak olvasás.
  //
  // MIÉRT NEM KORAI RETURN (ez a refaktor lényege): a régi kód `if (info) return
  // h(...)` / `if (confirm) return h(...)` alakban az EGÉSZ képernyőt lecserélte,
  // tehát a dialog megnyitásakor a user elvesztette a listát — nem látta, MELYIK
  // PR-ról szól a kérdés. Most a lista TOMPÍTVA végig renderelve marad, és az
  // overlay a KERETÉVEL ül rá.
  //
  // A SORREND: a hiba nyer MINDENNÉL. Ok: a hiba az a tény, ami épp most
  // meghiúsult, és amit a usernek nyugtáznia kell; ha egy alatta nyitva maradt
  // info-panel elnyomná, a hiba némán elveszne — pontosan az a csend, amit ez a
  // pont megszüntet. (A confirm-ot a hiba-ágak amúgy is zárták már.)
  const overlayState = errorState
    ? { kind: 'error', row: errorState.row, message: errorState.message }
    : modal
    ? { ...modal, row: panel.row }
    : panel
    ? { kind: 'info', row: panel.row }
    : null
  // A KERET a core tiszta függvényétől jön: cím, lábléc, keret-szín és a CELLÁBAN
  // mért szélességek. A `width` sosem lépi túl a terminált — a keret és a padding
  // is bele van számolva —, különben az Ink tördelné a keretet.
  // A KERET A `width`-re épül, ami a wf31/33 óta MÁR a három forrás legkisebbje
  // (lásd ott) — nincs szükség külön clampre.
  // (wf31/65) A LEBEGŐ PANEL — KÍSÉRLETI, ENV FLAG MÖGÖTT.
  //
  //     TUIPR_NEXT_FLOAT=1 pnpm exec tuipr queue
  //
  // A user kérése: az info panel NE tolja a lista többi elemét, hanem lebegjen
  // FELETTE — és balról ne a szélen, hanem kicsit beljebb.
  //
  // A MECHANIZMUS az Ink `position: 'absolute'`-ja (mérve, ink 7.1.1): az
  // absolute node KIESIK a flow-ból (nem tolja a testvéreit), az `Output` pedig
  // 2D cella-buffer — a KÉSŐBB írt node felülírja a korábbit, tehát a "z-index"
  // a fa-sorrend. A panel ezért a gyökér `Box` UTOLSÓ gyereke float módban.
  //
  // (wf31/67) A FLOAT A DEFAULT — a user döntése a mérés után ("Ez jó irány.
  // Innentől ez a default"). A kapcsoló iránya megfordult: a RÉGI, listát toló
  // viselkedés kérhető vissza:
  //
  //     TUIPR_NEXT_NOFLOAT=1 pnpm exec tuipr queue
  //
  // A DEKLARÁCIÓ ITT, A `frame` ELŐTT ÁLL — TDZ (mérve, a user crashe:
  // "Cannot access 'PANEL_FLOAT' before initialization"): a `frame` számítása
  // már olvassa a flaget, tehát a flagnek ELŐBB kell születnie. Ugyanez a
  // hibaosztály bukott meg a `hasFooter`-nél is (wf31/49).
  const PANEL_FLOAT = !/^(1|true|yes)$/i.test(String(process.env.TUIPR_NEXT_NOFLOAT ?? '').trim())
  // (wf31/67) A BAL BEHÚZÁS A PR-SZÁM OSZLOP MÖGÉ — a user kérése: "a takart
  // sorok PR számai látszódjanak". A sor eleje MÉRT szélességű: kurzor (2) +
  // `#NNNNN ` (7) = 9 cella; a 10. cellától indulva a szám ÉS egy leheletnyi rés
  // is látszik. (A stacked sorok behúzott száma részben takarásba eshet — azok
  // a talapzatuk alatt élnek, a szám ott másodlagos.)
  const PANEL_FLOAT_LEFT = 10
  // (wf31/65) FLOAT MÓDBAN A KERET A BEHÚZÁSSAL SZŰKEBB MÉRTÉKET KAP: a bal
  // inset + a keret EGYÜTT sem lóghat túl — egy túllógó sor tördelne, és a
  // tördelés az Ink törlés-számítását csúsztatja el (a resize-flicker gyökere).
  //
  // (wf31/67) A JOBB SZÉL A TÁBLÁÉ, NEM A VIEWPORTÉ — a user kérése, és ugyanaz
  // az elv, amit a fejléc notice-a és a legend pendingje már követ (wf31/46): a
  // `layout.width` a TARTALOMBÓL számolt tábla-szél, a panel jobb széle ehhez
  // igazodik, nem a monitoréhoz. Üres listán (layout.width 0) a viewport marad.
  // Egy forrás, nem utólagos vágás.
  const frame = overlayFrame({
    state: overlayState,
    columns: PANEL_FLOAT
      ? Math.max(20, (layout.width > 0 ? layout.width : width) - PANEL_FLOAT_LEFT)
      : width,
  })

  // (wf31/56) A TOMPÍTÁS FADE-JE — VÉGES TICKER, NEM FOLYAMATOS ANIMÁCIÓ.
  //
  // A user kérése: a dim ne ugorjon, hanem fade-eljen; input esetén az animáció
  // AZONNAL végállapotba.
  //
  // MIÉRT VÉGES A TICKER (és miért nem egy `setInterval`, ami mindig fut): a
  // wf31/36 óta MINDEN FRAME FULLSCREEN — az Ink `shouldClearTerminalForFrame`-je
  // `clearTerminal`-t ír a friss kimenettel együtt, tehát egy fade-frame a TELJES
  // képernyő újrarajzolása (nagyságrendileg 15-20 KB egy 200×50-es terminálon), nem
  // egy sor átszínezése. Egy örökké futó animációs ticker ezt másodpercenként
  // termelné akkor is, amikor semmi nem történik. A ticker ezért CSAK az átmenet
  // alatt él, és a végállapotban leáll.
  //
  // MIÉRT NINCS TEARING: az Ink minden frame-et `bsu`/`esu` (`\u001B[?2026h/l`,
  // synchronized output) közé zár, ha a stdout TTY — a terminál tehát ATOMIKUSAN
  // rajzolja ki a képet. A korábbi villanások NEM Ink-frame-ek voltak, hanem nyers
  // escape-írások a suspend körül (wf31/46-51), és pont ez a különbség.
  // AZ ÜTEM VÉGLEGES (a user hangolta be): 3 × 20 ms = 60 ms.
  //
  // (wf31/64) A `SLOW` DIAGNOSZTIKAI ENV KIVEZETVE — a hangolási fázis lezárult,
  // a mechanizmus jóváhagyva ("OK, most jó"). Ami marad, az a TILTÁS:
  //
  //     TUIPR_NEXT_NOANIM=1 pnpm exec tuipr queue
  //
  // — a fade teljesen kikapcsol (azonnali végállapot). Ez USER-beállítás, nem
  // diagnosztika: aki nem kér animációt (pl. képernyőolvasó, lassú SSH-kapcsolat,
  // vagy egyszerű preferencia), annak a tompítás egy lépésben történik.
  const FADE_NOANIM = /^(1|true|yes)$/i.test(String(process.env.TUIPR_NEXT_NOANIM ?? '').trim())
  const FADE_STEPS = 3
  const FADE_MS = 20
  // A KIINDULÓ SZÍN: A TÉMA SZÖVEGSZÍNE — MÉRT ÉRTÉKKEL, NEM TALÁLGATÁSSAL.
  //
  // (wf31/59) A user kérése: "számold a témából a dimig, én nem akarok
  // színkódokkal szórakozni" — és a lelete adja meg a mérést is: "FEHÉREK voltak
  // a betűk". A TUI témájának szövegszíne tehát fehér, vagyis a fade
  // kezdőpontja `#ffffff`.
  //
  // MIÉRT MŰKÖDIK EZ, MIKÖZBEN A KORÁBBI KÉT KÍSÉRLET NEM:
  //   · `#c8ccd4` (wf31/56) — VILÁGOSÍTOTT az első frame-en, mert sötétebb volt a
  //     valódi fehérnél. Ezt látta a user "felélénkülésnek".
  //   · `#8a919e` (wf31/57) — a helyes IRÁNYBA indult, de az átmenet 60-78%-a egy
  //     nem animált UGRÁSBAN történt meg (mérve): a fade így láthatatlan maradt.
  //   · `#ffffff` (MOST) — a nyugalmi színnel EGYEZŐ kezdet: nincs ugrás ÉS nincs
  //     világosítás, mert az első frame ugyanaz a fehér, ami eddig is ott volt.
  //
  // ÉS A NYUGALMI KÉP ÉRINTETLEN: a `Row` szín nélkül (`undefined` = téma) rajzolja
  // a nem tompított sorokat — a fehéret NEM MI írjuk ki, csak az átmenet indul
  // onnan. A wf31/58-as `baseColor` (ami a nyugalmi képet is átírta) kivezetve.
  //
  // A FEHÉR MINT FELTEVÉS: ha egy téma szövegszíne nem fehér, az első frame ugrik
  // egy kicsit — de a `dim`-es TUI-k gyakorlatilag mind világos-fehér fg-t
  // használnak sötét háttéren, és a user MÉRT esete is ez.
  // (wf31/62) A KEZDŐPONT A MÉRT ELŐTÉRSZÍN, ha a terminál megmondta — a fehér
  // csak fallback. A user lelete ("a fejléc jobb felső szövege fehérre villan")
  // pont a találgatás ára volt.
  const FADE_FROM = themeColors?.fg ?? '#ffffff'

  const [fadeStep, setFadeStep] = useState(FADE_STEPS)
  // AZ IRÁNY A CÉLÁLLAPOT: overlay nyitva a lista TOMPUL (a `FADED_COLOR` felé),
  // zárva visszaélesedik. A `frame` a kiváltó — ugyanaz a jel, amiből a `dimmed`
  // prop is dől el, tehát a fade és a végállapot nem tud szétcsúszni.
  const fadeTarget = frame ? 1 : 0
  const fadeTargetRef = React.useRef(fadeTarget)
  // (wf31/60) AZ IRÁNYVÁLTÁS-RESET RENDER KÖZBEN, NEM useEffect-BEN — MÉRT SAJÁT
  // HIBA JAVÍTÁSA.
  //
  // A user lelete: "rossz irányba fade-el, alulról felfelé" — és "még mindig nem
  // lassú".
  //
  // AZ OK MINDKETTŐRE: a reset useEffect-ben volt, az pedig a COMMIT UTÁN fut. A
  // panel nyitásának ELSŐ KIRAJZOLT frame-je tehát a régi `fadeStep`-pel ment ki —
  // ami a VÉGÁLLAPOT (a zárás oda állítja) —, vagyis a lista AZONNAL teljes dimre
  // ugrott (ezért "nem lassú"), majd az effect visszaállt 0-ra, a kép FELVILLANT
  // fehérre, és onnan indult lefelé (ezért "alulról felfelé").
  //
  // A JAVÍTÁS a React dokumentált "adjust state during render" mintája: a setState
  // render közben (guard-dal!) ELDOBJA ezt a rendert és azonnal újrafuttatja — a
  // commit MÁR a friss steppel történik, tehát az első kirajzolt frame a fehér
  // kezdőpont, nem a végállapot. useEffect itt STRUKTURÁLISAN nem tud jó lenni:
  // bármit csinál, egy frame-mel elkésik.
  //
  // NYITÁSKOR INDUL A FADE (step 0), ZÁRÁSKOR AZONNAL VÉGÁLLAPOT — a záró irányban
  // nincs mit animálni (a `fadeColor` fejénél áll, miért), és a 0-ra állítás ott
  // csak üres újrarajzolásokat termelne.
  if (fadeTargetRef.current !== fadeTarget) {
    fadeTargetRef.current = fadeTarget
    // NOANIM: a nyitás is azonnal a végállapotba ugrik — a ticker el sem indul
    // (a step sosem megy FADE_STEPS alá), tehát nincs köztes frame és nincs
    // felesleges újrarajzolás sem.
    setFadeStep(fadeTarget === 1 && !FADE_NOANIM ? 0 : FADE_STEPS)
  }
  useEffect(() => {
    if (fadeStep >= FADE_STEPS) return undefined
    const timer = setTimeout(() => setFadeStep((n) => n + 1), FADE_MS)
    // Az `unref` a többi timer mintája: egy futó fade NE tartsa életben a
    // processzt a kilépésnél (mérve: a beragadt ticker némán fagyó exitet adott).
    timer?.unref?.()
    return () => clearTimeout(timer)
  }, [fadeStep])
  // AZ INPUT VÉGÁLLAPOTBA UGRASZT — a user kikötése. A `useInput` ága ezt hívja:
  // egy `j`/`k` vagy bármely gomb közben a fade NEM versenyezhet a kurzor
  // mozgásával ugyanazon a felületen (a hunk-váltásnál mért "kiszámíthatatlan"
  // élmény pont ebből a fajta versenyből jött).
  const finishFade = useCallback(() => {
    setFadeStep((n) => (n >= FADE_STEPS ? n : FADE_STEPS))
  }, [])

  // A FADE AKTUÁLIS SZÍNE — CSAK A TOMPULÁS IRÁNYÁBAN.
  //
  // (wf31/57) A FADE-OUT (élesedés) ÁGA KIVEZETVE — MÉRVE HALOTT KÓD VOLT: a
  // `Row` tompítása a `dimmed: frame !== null` propból dől el, tehát a panel
  // zárásának pillanatában a `faded` AZONNAL false lesz, és a `fadeColor`-t a
  // renderelő MEG SEM NÉZI (`seg.color ?? (faded ? fadeColor : …)`). Az
  // "élesedés visszafelé" tehát sosem jelent meg a képen — egy nem létező
  // átmenetet animáltunk.
  //
  // ÉS EZ ÍGY HELYES IS: a panel zárása FÓKUSZ-VISSZAVÉTEL, ami azonnali
  // esemény — a lista ott van, ahol volt. A tompulás az, ami fokozatot érdemel
  // (valami MÁS lép előre), nem a visszatérés.
  // A TOMPULÁS ELŐREHALADÁSA (0..1) — a `Row` ebből szegmensenként tweenel
  // (wf31/61). A fejlécnek kész szín megy (ott nincs szemantikus színű szegmens).
  const fadeT = fadeProgress(fadeStep, FADE_STEPS).t
  const fadeColor = lerpHex(FADE_FROM, FADED_COLOR, fadeT)
  // (wf31/62) A FEJLÉC DIM SZEGMENSEI (poll-jelzés, notice) NYUGALOMBAN `dim`
  // attribútummal állnak — a képük tehát NEM az fg, hanem annak ~fele (SGR 2). A
  // user lelete ("a fejléc jobb felső szövege fehérre villan") abból jött, hogy
  // ezek is az fg-ről induló `fadeColor`-t kapták: dim-szürke → VILÁGOS fg →
  // vissza. A tween nekik a dim-közelítésből indul. A 0.5 a SGR 2 tipikus
  // renderelése; közelítés, de a tévedés lokális és kicsi — a villanás strukturális
  // volt.
  const fadeColorDim = lerpHex(lerpHex(FADE_FROM, '#000000', 0.5), FADED_COLOR, fadeT)

  // (wf31/53) A STACK-AJÁNLAT EGYETLEN FORRÁSA — a nyitott panel MÉRT diagnózisa.
  //
  // Innen dől el MINDKETTŐ: hogy a lábléc hirdesse-e az `s`-t, és hogy a leütése
  // csináljon-e bármit. Egy forrás, tehát a kettő nem tud szétcsúszni (hirdetett,
  // de halott gomb — a projekt mért hibaosztálya).
  //
  // A `null` a "nincs ajánlat": vagy nincs mérés, vagy a mérés szerint nem
  // stackelhető (nulla vagy több culprit — egy PR head egyszerre EGY bázisra tud
  // mutatni, lásd a `conflictAdvice` több-culpritos ágát).
  //
  // A FORRÁS A `buildInfoModel`, NEM A NYERS `panel` STATE: a `slow.advice` a
  // MÉRÉSBŐL (`panel.progress.diag`) SZÁMOLÓDIK (`conflictAdvice`), nem a
  // state-ben tárolódik — a nyers `panel.slow` NEM LÉTEZIK. Ugyanaz a tiszta
  // függvény, amiből az `infoBody` is dolgozik, tehát a lábléc és a body
  // UGYANARRÓL a mérésről beszél.
  const stackOffer = (() => {
    if (!panel || panel.mode !== 'inline' || !panel.row) return null
    const adv = buildInfoModel({ row: panel.row, progress: panel.progress ?? null })?.slow?.advice ?? null
    if (!adv || adv.offerStack !== true) return null
    const on = Number(adv.stackOn)
    return Number.isInteger(on) && on > 0 ? on : null
  })()
  // (wf31/49) VAN-E EGYÁLTALÁN LÁBLÉC? — AZ ALSÓ VONAL FELTÉTELE.
  //
  // A user lelete: "amikor nyitva az info panel, akkor a global alsó status sor nem
  // jelenik meg. Ilyenkor az alsó separator indokolatlan." Pontos: egy elválasztó
  // vonal, ami alatt nincs mit elválasztani, csak keretet rajzol.
  //
  // A HÁROM LÁBLÉC-FORRÁS, ugyanabban a sorrendben, ahogy a fa alább rendereli:
  //   · `exitConfirm` — a kilépés-kérdés MINDENT megelőz (overlay alatt is látszik);
  //   · `loadedAt === null` — a betöltés-felirat (ott a felső vonal sem megy ki);
  //   · `!frame` — a globális legend, ami overlay nyitva SZÁNDÉKOSAN elmarad (a
  //     nyitott dialógus kulcsai MÁSOK, lásd a legend feltételét).
  //
  // A FELSŐ VONAL FELTÉTELE VÁLTOZATLAN (`visibleRows.length > 0`): az a fejléctől
  // választ el, ami MINDIG ott van.
  const hasFooter = Boolean(exitConfirm) || loadedAt === null || !frame


  // --- A DIALÓGUS-TIPOLÓGIA A RENDERBEN (5a UTÁN) ---------------------------
  //
  // A MEGERŐSÍTÉS IS A PANELBEN ÉL. A korábbi modell — a megerősítés a LISTA
  // HELYÉN — a user élő tesztjén bukott meg (szó szerint): "a review prompt
  // ablak még mindig 'modal', és külön van az info panelből … ténylegesen
  // _minden_ az info panelbe kerül. Az info panel az egyetlen dialog útvonal a
  // PR műveletekhez." A RENDER tehát MINDEN frame-re ugyanaz: a panel a
  // KIVÁLASZTOTT SOR ALATT ül, a lista tompítva látható marad.
  //
  // AMI A TIPOLÓGIÁBÓL MEGMARAD (mert az a DÖNTÉS védelme, nem a képé): a
  // megerősítés-módban a fel/le a VÁLASZTÁST lépteti, a d/r/a/m nem él
  // (panelKeys), és a dwell-kapu változatlanul őrzi az y-t. A lista elrejtése
  // ehhez nem kellett — a kulcs-készlet zárja ki a kurzor-elmozdulást, nem a
  // lista hiánya.
  const isInline = frame !== null

  // A REVIEW-NYOM az AKTUÁLIS PR-on: a friction-sáv és az attesztációs body
  // KÖZÖS bemenete. A cache-ből (session-nyilvántartás) jön — lásd a doApprove
  // fejét arról, miért nem kérdezzük vissza a GitHubról.
  const panelTrace = panel ? hasReviewTrace(cache.current, panel.row.number) : false

  // (wf31/17) VAN-E MIT FELTÖLTENI — a lábléc `f` szegmensének kapuja.
  //
  // A user lelete: "»review feltöltése« parancs nem lehetséges, amíg nincs
  // review." Review nélkül az `f` DEAD KEY volt: a modál megnyílt, a `doUpload`
  // pedig hangos hibával elhasalt ("nincs élő hunk-session … NINCS MIT
  // FELTÖLTENI") — holott a művelet ELVBŐL nem volt lehetséges.
  //
  // A KÉT JEL, ÉS MIÉRT ÉPP EZ A KETTŐ (a `doUpload` KÉT forrását tükrözi):
  //   · `hasAnyFindings` — van CACHE-ELT finding (a fallback-forrás). Ez a
  //     render-úton INGYEN olvasható (tiszta Map-lookup), és a `cacheVersion`
  //     dependency frissíti;
  //   · `panelTrace` — futott REVIEW ezen a PR-on ebben a sessionben, tehát
  //     VALÓSZÍNŰLEG van anyag a hunk-sessionben is (az elsődleges forrás).
  //
  // MIÉRT NEM MÉRJÜK A HUNK-SESSIONT KÖZVETLENÜL: az `hunk session comment list`
  // egy spawnSync — a render-úton MINDEN képkockán lefutna. Ez pontosan az a
  // hibaosztály, amit a cache-modul NULLA-I/O invariánsa gépileg tilt.
  //
  // A KÖZELÍTÉS IRÁNYA SZÁNDÉKOS (fail-open): ha BÁRMELYIK jel igent mond,
  // hirdetjük az `f`-et. Egy tévesen hirdetett `f` a `doUpload` hangos, cselekvésre
  // alkalmas hibáját adja (ott a hunk-session MÉRVE van) — egy tévesen ELREJTETT
  // `f` viszont azt jelentené, hogy a user nem tudja feltölteni a MEGLÉVŐ
  // review-ját, és nincs is jelzés arról, miért. A hiányzó opció a drágább hiba.
  const panelCanUpload = panel
    ? (hasAnyFindings(panel.row.number) || panelTrace)
    : false

  // AZ `r` ÁLLAPOTFÜGGŐ LÁBLÉC-CÍMKÉJE — a globális KEYS és a panelFooter KÖZÖS
  // forrásból (core rKeyLabel) kapja, a KURZOR (ill. a nyitott panel) sorára
  // számolt életciklusból. A `cacheVersion` a render-inputok között van (a
  // cache-olvasás tiszta Map-lookup), tehát ez nem I/O a render-úton.
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

  // A TARTALOM SOR-LEÍRÓKÉNT: a hibánál az üzenet, a modálnál a döntés adatai, az
  // inline-nál a két sáv + az akció-sor. A sorrend EGYEZIK az overlayState-tel —
  // ha szétcsúszna, egy 'error' keretben modál-tartalom jelenne meg. Az
  // innerWidth MINDHÁROM body-nak megy: a branch-név a keret belső szélességéhez
  // csonkolódik, és az a mérték csak itt ismert.
  // AZ AI-REVIEW PANEL-SZEKCIÓJÁNAK BEMENETE. A futó ág a `aiLive` ref friss
  // finding-számát/tool-jelzését kapja (a ref-írás renderfüggetlen — a rendert
  // a ticker `aiTick`-je hajtja), a többi állapot a state-ből jön.
  // A DUPLA-`x` élesítése a megjelenítésben SZÁRMAZTATOTT: a futó ágon az
  // abort-arm, a kész ágon az adott PR-ra kötött discard-arm számít — egy
  // elavult (más kindű / más PR-ú) arm címkét sem válthat.
  //
  // A LEMEZRŐL VISSZAÁLLÍTOTT REVIEW IS MEGJELENIK — EZ A USER LELETÉNEK MÁSODIK
  // FELE. MI VOLT A HIBA: a hidratálás CSAK a memória-cache-be írt findingokat,
  // `aiReview` state-et NEM. Az `r: elvetés` lábléc-címke és a lista-glifje tehát
  // helyesen mutatta, hogy VAN kész review — a PR-PANEL review-szekciója viszont
  // ÜRES volt, mert az KIZÁRÓLAG az `aiReview` state-ből épül. A user a panelben
  // keresi a review-t (ott olvassa a findingokat és a verdictet), ezért a
  // "nincs betöltve a TUI-ban" lelet a fix nélkül a coreSha-javítás UTÁN IS állna.
  //
  // MIÉRT ITT (SZÁRMAZTATVA), ÉS MIÉRT NEM A HIDRATÁLÁS ÍR `aiReview`-t: az
  // `aiReview` az AKTUÁLIS, SORHOZ KÖTÖTT review-állapot (egyszerre EGY PR-é), a
  // visszaállítás viszont EGYSZERRE SOK PR-t érint. Egy hidratálás-időben beírt
  // `aiReview` tehát önkényesen KIVÁLASZTANA egy PR-t (az utolsót a ciklusban),
  // és a panel MÁS sorokon némán üres maradna — ugyanaz a hibaosztály, csak
  // nehezebben észrevehető. A SZÁRMAZTATÁS a nyitott panel SORÁRA válaszol,
  // tehát MINDEN visszaállított PR-on helyes.
  //
  // A PRECEDENCIA: az ÉLŐ `aiReview` MINDIG erősebb. Ha ebben a sessionben futott
  // (vagy fut) review ezen a PR-on, azt látjuk — a lemezes másolat elavult
  // ahhoz képest, és egy régi összegző a friss findingok fölött hazug verdict lenne.
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
    // A VISSZAÁLLÍTOTT REVIEW `done-answer`-KÉNT jelenik meg, és ez PONTOS, nem
    // közelítés: az az állapot azt jelenti, hogy "a findingok megvannak, de a
    // hunkba még nincsenek betöltve" — hidratált review-ra ez SZÓ SZERINT igaz,
    // hiszen a hunk-session nem élte túl az előző processzt (ezért nem is
    // perzisztálódik az `applied` flag, lásd a review-store fejét).
    //
    // A FINDINGOK A MEMÓRIA-CACHE-BŐL jönnek, nem a `restoredMeta` bejegyzésből: az
    // ELVETÉS (dupla-`x`) a cache-ből törli őket, és ha itt a lemezes másolatot
    // rajzolnánk, az elvetett review VISSZATÉRNE a panelre. A `restoredMeta` csak azt
    // hordozza, amit a cache NEM tud (összegző + drift-jelzés).
    : restoredPending !== null
      && Array.isArray(restoredPending.findings)
      && restoredPending.findings.length > 0
    ? {
        pr: panel.row.number,
        status: 'done-answer',
        added: restoredPending.findings.length,
        findings: restoredPending.findings,
        summary: restoredMeta.summary,
        // A FENNTARTÁS KIMONDVA (a store `tool-drift` állapota): a findingok a
        // diffről szólnak, ami áll — de MÁS core-verzió mérte őket. A `caveat`
        // csatorna a degradált review-utak MEGLÉVŐ mintája, ugyanarra a
        // fogalomra: "látszik, de a fenntartást nem hallgatjuk el".
        caveat: restoredMeta.toolDrift
          ? 'ezt a review-t MÁS core-verzió mérte, mint ami most fut — a findingok a PR '
            + 'változatlan diffjéről szólnak, de egy mostani review mást is találhat'
          : null,
        // A BETÖLTÉS-AJÁNLAT az `applied` flagből: ha a findingok már a hunkban
        // vannak (ebben a sessionben megnyitottuk), az ajánlatot NEM hirdetjük
        // újra — a `d` útjának `offer:false` frissítése ugyanezt teszi.
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
        // A CAVEAT-LÁBJEGYZET állapota (progresszív disclosure). A `bodyLines`
        // KÖZVETLENÜL a `clipBodyLines` bemenete, tehát a nyitás/csukás
        // MAGASSÁG-VÁLTOZÁSA is ugyanazon a mért úton megy át, mint minden más
        // sor — a viewport nem tud elcsúszni a valóságtól (ez a
        // `estimatePanelRows`-nál MÉRT hibaosztály).
      )
  // A TÖRZS TELJES MAGASSÁGA (tördeléssel!) + a keret fix költsége = amennyit a
  // panel KÉRNE. Ugyanaz a `clipBodyLines`, ami később vágni is fog: a `maxRows`
  // itt szándékosan gyakorlatilag korlátlan (Infinity nem jó — a core Math.floor-t
  // használ), tehát a `rows` a MÉRT teljes magasság.
  // (2) A REVIEW-CASCADE-MENÜ SORAI — a lábléc HELYÉN (lásd a panelNode-ot).
  //
  // A menü CSAK akkor jelenik meg, ha a NYITOTT PANEL SORA egyezik a menü
  // PR-jával. MIÉRT: a menü egy PR-ra vonatkozó, token-költő döntés — ha a panel
  // közben más sorra került (poll, reload), a menü LÁTSZANA egy MÁS PR alatt, és
  // a user azt hinné, arra fog indítani. Ugyanaz a sorhoz-kötés, ami a
  // `reviewForPanel`-nél és a mérés-callbackeknél is él. (A KULCS-ág ugyanezt a
  // guardot fail-closed módon zárja: elavult sornál bezárja a menüt.)
  const menuLines = frame && !errorState && !modal && reviewMenu && panel?.row?.number === reviewMenu.pr
    ? reviewMenuLines(reviewMenu, { innerWidth: frame.innerWidth })
    : []
  // A MAGASSÁG-BECSLÉS a MENÜT IS SZÁMOLJA. A `PANEL_CHROME_ROWS` (6) EGY soros
  // lábléccel számol; a menü KÉT sor (lábléc + menü-sor — az üres sor a wf28/3
  // észrevétellel kivezetve), tehát a különbözetet hozzá kell adni — enélkül a
  // viewport a panelt egy sorral rövidebbre méretezné, mint amennyit renderel,
  // és a FEJLÉC csúszna ki
  // (pontosan a `estimatePanelRows`-nál MÉRT hibaosztály: a becslés és a
  // valóság elcsúszása).
  const menuExtraRows = menuLines.length > 0 ? menuLines.length - 1 : 0
  const wantedPanelRows = frame
    ? clipBodyLines(bodyLines, { width: frame.innerWidth, maxRows: Number.MAX_SAFE_INTEGER }).rows
      + PANEL_CHROME_ROWS + menuExtraRows
    : 0
  // --- A VIEWPORT: a panel + lista nem lóghat ki a MAGASSÁGBÓL --------------
  //
  // A LISTA NEM VIRTUALIZÁLT: eddig minden sor renderelődött, és amíg a dialógus
  // teljes képernyős volt, ez nem látszott (a lista nem volt ott). Az INLINE panel
  // viszont a lista ALÁ kerül, tehát a lista + panel + chrome együtt túllépheti a
  // terminált. Az Ink ilyenkor FELFELÉ tolja a tartalmat: ELŐBB a FEJLÉC csúszik
  // ki (az, ami a betöltés idejét és az elavultság-jelzést hordozza), majd a lista
  // teteje — vagyis pont az, amiért a fejléc-fejezet készült.
  //
  // A `useWindowSize().rows` a mérték; nem-TTY-n / resize közben 0/undefined lehet,
  // ezért a core `panelViewport`-ja FAIL-SOFT (24-re esik vissza).
  // (wf31/36) A SOROK IS HÁROM FORRÁSBÓL, A LEGKISEBB NYER — a `width` mintájára.
  //
  // MIÉRT KELL A SAJÁT MÉRÉS: a full screen mód a gyökér `Box`-nak FIX magasságot
  // ad, és ha az a valódi terminálnál NAGYOBB, a fa túllóg — a terminál görget, a
  // lista teteje kicsúszik (pont az, amit a full screen megszüntetni akar). A
  // resize-résben az Ink `useWindowSize`-a egy tickkel késik, a
  // `process.stdout.rows` viszont a KERNELTŐL jön.
  //
  // A LEGKISEBB azért nyer, mint a szélességnél: egy ALULMÉRT magasság néhány sort
  // kihagy (kozmetikai), egy FELÜLMÉRT viszont GÖRGETÉST okoz — és a görgetés a
  // scrollbackbe szórja a frame-eket, ami a javítandó hibaosztály.
  const { rows: inkRows } = useWindowSize()
  // (wf31/38) A MAGASSÁG AZONNALI CAPJE — a szélesség mintájára.
  //
  // MIÉRT KELL: a gyökér `Box` FIX magasságot kap (full screen mód). Ha az a
  // valódi terminálnál NAGYOBB, a fa túllóg, a terminál GÖRGET, és a lista teteje
  // kicsúszik. Szűkítéskor tehát a magasságnak is AZONNAL csökkennie kell — a
  // debounce-olt érték itt ugyanazt a tördelés-osztályt adná, csak vertikálisan.
  const capRows = process.stdout.rows || 0
  const rowCandidates = [measuredSize.rows, inkRows, process.stdout.rows]
    .filter((n) => typeof n === 'number' && n > 0)
  const termRows = rowCandidates.length > 0 ? Math.min(...rowCandidates) : 24
  // A TÉNYLEGES MAGASSÁG: az AZONNALI cap (ha mérhető) és a debounce-olt érték
  // közül a KISEBB. Ezt kapja MINDKETTŐ — a gyökér `Box` fix mérete ÉS a
  // tartalom-ablak (`panelViewport`) —, mert a kettőnek EGYEZNIE kell: egy
  // nagyobb ablak sorai a `Box`-on túlra esnének, ahol az Ink vág, tehát némán
  // eltűnnének.
  const boxRows = capRows > 0 ? Math.min(capRows, termRows) : termRows
  // A CHROME fix költsége: fejléc (1) + üres (1) + status (1) + legenda (1, csak
  // ha nincs overlay). Overlay nyitva a legenda elmarad — a nyitott dialógus
  // kulcsai MÁSOK, és a kettő egymás mellett hazug affordance lenne.
  const chromeRows = frame ? 3 : 4
  const viewport = panelViewport({
    rowCount: rows.length,
    // A KURZOR a MEGJELENÍTETT sorok indexe (nem a selectable-é): a viewport a
    // renderelt listán vág, tehát a behúzott (nem választható) stacked sorok is
    // beleszámítanak. A `current` a selectable-ből jön; itt a helyét keressük meg.
    cursor: current ? Math.max(0, rows.findIndex((r) => r.number === current.number)) : 0,
    // (wf31/38) A VIEWPORT IS A `boxRows`-T KAPJA: a tartalom-ablak nem lehet
    // NAGYOBB a fa fix magasságánál, különben a lista alja a `Box`-on túlra
    // esik — az Ink ott vág, tehát a sorok NÉMÁN eltűnnének (a viewport azt
    // hinné, kirajzolta őket, a `panelViewport` kurzor-követése pedig egy nem
    // látható sorra állna).
    height: boxRows,
    // A PANEL MAGASSÁGA a MÉRT törzsből, NEM kézzel számolt becslésből.
    //
    // MÉRT BUG: az első változat egy `estimatePanelRows` heurisztikával számolt
    // (sávonként "kb. ennyi sor"), ami a TÖRDELÉST nem vette figyelembe — egy
    // hosszú advice-bekezdés 3-4 sort foglal, a becslés 1-et adott, és a frame
    // TÚLLÓGOTT (12 soros terminálon 29 sor, a fejléc kicsúszott). Most ugyanaz a
    // `clipBodyLines` méri a magasságot, ami később vágni is fog — EGY mérték,
    // tehát a becslés és a valóság strukturálisan nem tud elcsúszni.
    // (wf31/65) FLOAT MÓDBAN A LISTA A TELJES HELYET KAPJA: a panel nem a
    // flow-ban ül, tehát nem is kell helyet hagyni neki — pont ez a float lényege
    // (a lista nem csúszik el a panel nyitásakor).
    panelHeight: isInline && !PANEL_FLOAT ? wantedPanelRows : 0,
    chrome: chromeRows,
  })
  // A LISTA MINDEN frame mellett renderelődik (5a): a megerősítés is a panelben
  // él, tehát a lista-sorok a viewport-ablak szerint MINDIG látszanak. A régi
  // "modál a lista helyén" lista-kiürítés kivezetve — a döntés védelme a
  // kulcs-készletben (panelKeys) van, nem a kép cseréjében.
  const visibleRows = rows.slice(viewport.first, viewport.first + viewport.visibleRows)
  // A PANEL BESZÚRÁSI PONTJA: a KIVÁLASZTOTT SOR UTÁN, a látható ablakon belül.
  // Ha a kurzor sora (bármi okból) nincs az ablakban, a panel a lista VÉGÉRE
  // kerül — fail-soft: a panel akkor is látszik, csak nem a sor alatt. (A
  // viewport szerződése garantálja, hogy ez ne fordulhasson elő; ez a védőháló.)
  const cursorAt = current ? visibleRows.findIndex((r) => r.number === current.number) : -1
  const insertAfter = cursorAt >= 0 ? cursorAt + 1 : visibleRows.length

  // A PANEL (keretes overlay). EGY hely: a cím, a tartalom és a lábléc innen
  // megy ki, akár inline ül, akár modálként. A `width` explicit: enélkül az Ink a
  // tartalomhoz méretezné a keretet, és egy hosszú belső sor túllógna a
  // terminálon (a négyszer bejelentett tördelés-osztály). A belső sorok a
  // `frame.innerWidth`-hez igazodnak, tehát cellában is beférnek.
  //
  // A CSONKOLÁS KIMONDVA: ha a viewport a panelt rövidebbre szabta, mint amennyit
  // a tartalom kér, EGY sor jelzi. Némán elvágni ugyanaz a hibaosztály, mint a
  // némán elnyelt hiba: a user nem tudja, hogy van még.
  // A TÖRZS ELVÁGÁSA a viewport által MEGENGEDETT magasságra.
  //
  // A `panelRows` a KERETET IS tartalmazza (a becslés a `PANEL_CHROME_ROWS`-szal
  // számol), tehát a törzs annyit kap, amennyi a chrome után marad. Az 5a óta a
  // MEGERŐSÍTÉS is inline ül (a lista mellett), tehát UGYANAZT a viewport-adta
  // helyet kapja — a régi "modálban a teljes terminál a miénk" ág kivezetve.
  // (2) A MENÜ EXTRA SORAIT a TÖRZS helyéből vonjuk le, nem a listáéból: a
  // `PANEL_MIN_LIST_ROWS` fejezete szerint szűk terminálon a PANEL rövidül, NEM
  // a lista tűnik el — a lista a döntés KONTEXTUSA. A menü pedig maga a döntés,
  // tehát nem csonkolható (a `y`/`esc` nélkül a menü használhatatlan).
  // (wf31/65) FLOAT MÓDBAN A PANEL BÜDZSÉJE A TELJES MAGASSÁG (a viewport nem
  // tart neki helyet, tehát a `viewport.panelRows` ott 0 — abból a body üres
  // lenne). A klampolás a `boxRows`-ra: a lebegő panel sem lóghat ki a fából.
  const panelRowsBudget = PANEL_FLOAT && isInline
    ? Math.min(wantedPanelRows, boxRows)
    : viewport.panelRows
  const bodyRoom = Math.max(0, panelRowsBudget - PANEL_CHROME_ROWS - menuExtraRows)
  const clipped = frame ? clipBodyLines(bodyLines, { width: frame.innerWidth, maxRows: bodyRoom }) : { kept: [], truncated: false }
  // (wf31/65) A LEBEGŐ PANEL POZÍCIÓJA: a kurzor sora ALÁ, klampolva a fa aljára.
  //
  // A KÉPLET: fejléc (1) + felső elválasztó (1) = a lista a 2. sortól indul; a
  // kurzor látható indexe `cursorAt`; a panel a KÖVETKEZŐ sortól. Ha nem fér ki
  // lefelé, a klamp FELJEBB tolja (átfedheti a kurzor sorát is — az első
  // iteráció tudatos egyszerűsítése; a "flip a kurzor fölé" akkor jön, ha a
  // kísérlet beválik).
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
          // (wf31/65) FLOAT: kiesik a flow-ból, a lista fölött lebeg. A left a
          // user kérte behúzás — a lista bal széle kilátszik a panel mellett.
          // (wf31/66) A HÁTTÉR EXPLICIT — A PANEL OPAQUE. A user lelete: "a
          // floating panel szabad területén átüt a táblázat". Az Ink cella-buffere
          // csak oda ír, ahol KARAKTER van — a padding, a rövid sorok utáni rés és
          // az üres sorok cellái érintetlenek maradnak, alattuk a lista látszik. A
          // `backgroundColor` a teljes tartalom-rectet festi (renderBackground:
          // szóköz-sorok a keret belsejében), tehát a panel takar.
          //
          // A SZÍN A MÉRT TÉMA-HÁTTÉR (OSC 11) — a kitöltés így láthatatlan: a
          // panel "háttere" ugyanaz, mint a képernyőé, csak most már ÍRVA van, nem
          // átlátszóan üresen hagyva. Fallback fekete: nem válaszoló terminálon a
          // sötét témák túlnyomó esetén ez a jó irány.
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
        // A CSONKOLÁS KIMONDVA — és MOST TÉNYLEG MEG IS TÖRTÉNIK.
        //
        // MÉRT BUG: az első változat a `viewport.panelTruncated`-ból írta ki ezt a
        // sort, DE A TARTALMAT NEM VÁGTA EL. A frame 12 soros terminálon 29 sorra
        // hízott, a FEJLÉC kicsúszott, és a UI olyat állított, ami nem történt meg.
        // A jelzés forrása ezért MOST a tényleges vágás eredménye (`clipped`), nem
        // a szándék — így a sor és a valóság strukturálisan nem tud elcsúszni.
        ...(clipped.truncated
          ? [h(Text, { dimColor: true }, '… a panel csonkolva — nagyobb terminál-magasságon több látszik')]
          : []),
        h(Text, null, ' '),
        // A LÁBLÉC — A VEZÉRLÉS A KERET ALJÁN, DIMMELVE (a user 3. elve).
        //
        // A PANEL kulcsait a core `panelFooter`-e adja (nem az `overlayFrame`-é):
        // az inline módban a NÉGY AKCIÓT hirdeti (a konszolidáció látható
        // eredménye), a modálban pedig a `y/N` MELLETT a `↑/↓`-t is — a nyilas
        // választás új affordance, amit az `overlayFrame` lábléce nem ismer. Az
        // AI-review ekránjának SAJÁT extra kulcsai (review-út, budget) viszont
        // ott vannak kimondva, ezért azon az EGY ágon a frame lábléce megy.
        // (2) A REVIEW-CASCADE-MENÜ A LÁBLÉC HELYÉN — ha nyitva van.
        //
        // A user specifikációja: "a legend minden más opciója tűnjön el, a review
        // legend tartsa meg a pozícióját (tehát a d: diff helyén kihagyás
        // legyen), és alatta jelenjen meg egy sor kihagyással a review menü."
        //
        // A MENÜ TEHÁT A LÁBLÉCET VÁLTJA FEL, nem a body-hoz jön: a lábléc a
        // keret ALJÁN ül (a user 3. elve), és a menü annak a helyére kerül — így
        // a "pozíció-megtartás" kérése egyáltalán értelmezhető. Ha a body végére
        // tettem volna, a menü FÖLÖTT ott maradt volna a teljes normál lábléc
        // (`d: diff · r: review · …`), tehát pont a kért eltűnés nem történne meg.
        //
        // A SOROK a core tiszta függvényétől jönnek (reviewMenuLines), cellában
        // mérve és degradálva — a szélesség-döntés ott van indokolva és tesztelve.
        ...(menuLines.length > 0
          ? renderLines(menuLines)
          : [(() => {
              if (errorState || modal?.blockers?.length > 0) {
                return h(Text, { key: 'lc', dimColor: true }, frame.footer)
              }
              // Az `r` címkéje ÁLLAPOTFÜGGŐ (rKeyLabel — futó/kész review más
              // szerepet hirdet), a többi kulcs a core panelFooter-éből jön.
              // (wf31/17) A `canUpload` a FELTÖLTHETŐSÉG mért ténye: `f` nélkül
              // a szegmens kiesik (a user lelete: "»review feltöltése« parancs
              // nem lehetséges, amíg nincs review").
              //
              // (wf31/45) A PENDING ITT IS A JOBB SZÉLRE, INVERZ KIEMELÉSSEL — a
              // globális legenddel EGYEZŐ mintán. Az `f` (feltöltés) és a `d`
              // ugyanis a PANEL láblécében is hirdetve van, tehát a jelzésnek ott
              // is meg kell jelennie, ahol a kulcsot látod.
              //
              // A MÉRTÉK a `frame.innerWidth` (a keret BELSŐ szélessége), nem a
              // terminál `width`-e: a lábléc a kereten BELÜL ül, és egy
              // terminál-szélességre igazított pending a keret `│` oszlopán TÚLRA
              // csúszna.
              const footerText = panelFooter(panel, frame.innerWidth, {
                rLabel,
                canUpload: panelCanUpload,
                // A CÍMKE MEGNEVEZI A CÉLT (`s: stackelés #904-re`), nem csak az
                // akciót: a stackelés IRÁNYA a lényeg, és a user a láblécből
                // ellenőrizni tudja, hogy arra a PR-ra megy, amit a verdict mond.
                stackLabel: stackOffer === null ? '' : `s: stackelés #${stackOffer}-re`,
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
      // (wf31/36) FULL SCREEN MÓD — A LISTA MINDIG A KÉPERNYŐ TETEJÉN, FIX
      // MAGASSÁGGAL. A user kérése: "szerintem »full screen« módra kéne mennünk,
      // tehát képernyő tetején a lista mindig."
      //
      // ÉS EZ NEM CSAK ESZTÉTIKA — EZ AKTIVÁLJA AZ INK MŰKÖDŐ TÖRLÉS-ÚTJÁT.
      // A `shouldClearTerminalForFrame` (ink 7.1.1) akkor ír `clearTerminal`-t a
      // friss kimenettel EGYÜTT, ha a frame magassága eléri a viewportot:
      //     const isFullscreen = nextOutputHeight >= viewportRows
      // Ilyenkor az Ink NEM a sorszám-alapú `eraseLines`-t használja (ami tördelt
      // sorok mellett ALULMÉR — ez volt az egész glitch gyökere), hanem
      // teljes-képernyő-törlést + újrarajzolást.
      //
      // A USER MÉRT MINTÁJA, amit ez megszüntet: "layoutnál szűkebbre méretnél van
      // render, tágabb ablakra resize-ra üres képernyő". A magyarázat: szűkítésnél
      // az Ink nullázza a `lastOutput`-ot (tehát a diff átengedi a rendert),
      // szélesítésnél NEM — ott a saját `2J`-nk törölt, és nem volt mi
      // visszarajzoljon. Fix magasságú fánál ez a KÜLÖNBSÉG ELTŰNIK: minden frame
      // fullscreen, tehát minden frame teljes újrarajzolást kap.
      //
      // A MAGASSÁG A TERMINÁL SORAI (fail-soft 24-re, mint a `panelViewport`): a
      // `height` a Yoga-node fix mérete, tehát a fa MINDIG ennyi sor — a lista
      // ablaka (`panelViewport`) amúgy is erre a mértékre vág, tehát a tartalom
      // nem lóg túl, csak a maradék hely marad üresen.
      height: boxRows,
    },
    // A FEJLÉC KIMONDJA, MIKOR TÖLTÖTTÜNK UTOLSÓ (user-kérés) ÉS hogy a kép
    // AZÓTA ELMOZDULT-E (a háttér-poll jelzése). Enélkül a képernyőn álló lista
    // nem különböztethető meg a 20 perccel korábbitól, és a döntés (approve /
    // merge) elavult képen születik. A HELYI idő HH:MM:SS alakban: a dátum itt
    // zaj (a session ma van), a másodperc viszont nem — a refresh HATÁSA (hogy
    // tényleg most töltött) csak abból látszik.
    //
    // A SOR ÖSSZEÁLLÍTÁSA a core TISZTA, CELLÁBAN MÉRŐ függvényétől jön: a
    // fejléc négy elemet hordoz, és egy naiv konkatenáció a szűk terminálon
    // tördelne (a négyszer bejelentett hibaosztály). A degradáció sorrendje ott
    // van kimondva és unit-tesztelve a teljes columns-tartományon.
    //
    // A SZÍNEZÉS itt marad (a core tiszta függvénye szöveget ad, nem Ink-fát): a
    // poll-jelzés a SOR VÉGÉN áll, ezért két Text-re vágjuk. A jelzés NEM
    // sárga: a user 3. elve szerint a sárga CSAK valódi figyelmeztetésre való
    // (költség, blokkolók) — az elavultság teendő, nem veszély.
    h(
      Box,
      null,
      ...(() => {
        const line = headerLine({
          loadedAt: loadedAt ? loadedAt.toLocaleTimeString('hu-HU', { hour12: false }) : null,
          // (1a) A BETÖLTÖTT CORE SHA-JA. A hívás a renderben áll, de MEMOIZÁLT
          // (fetchCoreSha) — a spawn EGYSZER fut a session életében, nem
          // frame-enként. Ez load-bearing: a fejléc minden keyfelütésre, minden
          // poll-tickre és minden spinner-frame-re újraszámolódik.
          coreSha: fetchCoreSha(),
          pollLabel,
          // (wf31/44) A REBUILD-JELZÉS: a bash `Next rebuild: …` sora a shellben
          // maradt, ami a fullscreen-módban azonnal elveszett — a user kérdése
          // ("ennek nem a fullscreenben kéne megjelennie?") pontosan ez volt. A
          // `null` (sikeres rebuild) esetén a `headerLine` nem szül szegmenst.
          rebuild,
          // (wf31/27) A FEJLÉC IS A TÁBLA SZÉLÉIG ér: a jobbra igazított `notice`
          // különben a MONITOR jobb szélére került volna, elszakadva a listától.
          // A `layout.width` a tartalomból jön; betöltés alatt (üres lista) 0, ott
          // a terminál-szélességre esünk vissza — különben a fejléc eltűnne.
          // A FEJLÉC a TÁBLA szélességéig ér (a `notice` így a listához igazodik,
          // nem a monitor széléhez). A `layout.width` a `width`-ből származik, ami
          // a wf31/33 óta a három forrás legkisebbje — nincs szükség külön clampre.
          columns: layout.width > 0 ? layout.width : width,
          // (wf31/23) A VISSZAJELZÉS A FEJLÉC JOBB SZÉLÉN (a user pontosítása:
          // "Inkább akkor a fejlécbe tedd, ki jobbra.."). A kivezetett globális
          // status-sor EREDMÉNY- és INPUT-üzenetei kerültek ide; a pending NEM
          // (az a legendbe, a triggerelő kulcs mellé).
          notice,
        })
        // A JELZÉSEKET A SOR VÉGÉRŐL vágjuk le, hogy önálló (dimmelt) Textet
        // kapjanak. A sorrend a `headerLine` felépítését követi: a `notice` a
        // LEGVÉGÉN áll (jobbra igazítva), a `pollLabel` a bal oldali blokk utolsó
        // szegmense. Ha a degradáció valamelyiket kihagyta, a `lastIndexOf`
        // `-1`-et ad, és az a rész egyszerűen nem kap külön Textet.
        // (wf31/35) KEMÉNY PLAFON A FEJLÉCRE IS — EZ VOLT A MARADÉK GLITCH OKA.
        //
        // A user paste-elt képe adta meg a nyomot: a lista sorai MÁR szűkek voltak
        // (a `Row` `clampCells`-e vág), a fejléc `20 PR a queue-ban`-ja viszont a
        // RÉGI, szélesebb pozícióban ragadt. Vagyis a fejléc volt az EGYETLEN sor,
        // ami nem esett át kemény vágáson: a `layout.width`-et kapta, ami a TÁBLA
        // mérete — és a resize-résben az nagyobb lehet a valódi terminálnál.
        //
        // A JOBBRA IGAZÍTÁS EZT FELERŐSÍTI: a `headerLine` a `notice`-t
        // whitespace-padlással tolja a sor végére. Ha a mérték 20 cellával nagyobb
        // a valóságnál, a padding is 20-cal hosszabb — a szöveg tehát a terminál
        // JOBB SZÉLÉN TÚLRA kerül, a terminál tördeli, és a karakterek ott
        // maradnak (az Ink sorszáma stimmel, tehát nem törli).
        //
        // A VÁGÁS A `width`-re megy (a három mérés legkisebbje), NEM a
        // `layout.width`-re: a tábla-mérték a TARTALOMRÓL szól, a plafon a
        // FIZIKAI korlátról. A kettő különbözik, és itt az utóbbi a döntő.
        // (wf31/38) A FEJLÉC IS AZ AZONNALI CAP-RE vág (nem a debounce-olt
        // `width`-re): szűkítéskor a jobbra igazított `notice` különben a terminál
        // jobb szélén TÚLRA kerülne, és a tördelt maradék ott ragadna.
        const hardLine = clampCells(line, capWidth > 0 ? Math.min(capWidth, width) : width)
        const nAt = notice !== '' ? hardLine.lastIndexOf(notice) : -1
        const beforeNotice = nAt >= 0 ? hardLine.slice(0, nAt) : hardLine
        const noticeText = nAt >= 0 ? hardLine.slice(nAt) : ''
        const at = pollLabel !== '' ? beforeNotice.lastIndexOf(pollLabel) : -1
        const head = at >= 0 ? beforeNotice.slice(0, at) : beforeNotice
        const tail = at >= 0 ? beforeNotice.slice(at) : ''
        return [
          // (wf31/55) NYITOTT OVERLAY ALATT A FEJLÉC IS A FAKÓ SZÍNT KAPJA, nem csak
          // a `dim` attribútumot — az egy fix fokozat, és a színtelen alapszövegen
          // alig látszik. A lista sorai ugyanezt a `FADED_COLOR`-t használják,
          // tehát a kép EGY szintre tompul, nem kettőre.
          // A `dim` KIESIK, AHOL A SZÍN TOMPÍT: a `FADED_COLOR` + `dim` egymáson egy
          // egész fokozattal túl sötét (a három lépcső a `FADED_COLOR` fejénél áll).
          h(Text, {
            key: 'h',
            bold: true,
            color: frame ? fadeColor : undefined,
          }, head),
          ...(tail !== ''
            ? [h(Text, { key: 'p', color: frame ? fadeColorDim : undefined, dimColor: frame ? undefined : true }, tail)]
            : []),
          // A NOTICE DIMMELT, mint a poll-jelzés: EFEMER visszajelzés, nem a
          // rendszer-azonosság része. A `⚠`/`✓` prefixet a hívó adja, ha kell.
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
    // A LISTA + A BESZÚRT PANEL, SAJÁT BOXBAN, VÁLASZTÓVONALAK KÖZÖTT.
    //
    // A PANEL A KIVÁLASZTOTT SOR UTÁN kerül be, tehát a "melyik PR-ról szól" kérdés
    // a POZÍCIÓBÓL is látszik, nem csak a fejlécből. Az 5a óta a MEGERŐSÍTÉS is így
    // ül — a lista sosem tűnik el.
    //
    // A TÁBLÁT KÉT VÍZSZINTES VONAL FOGJA KÖZRE (a user kérése: előbb "vertical
    // padding a táblához", majd "vízszintes vonal a mostani üres sorokban"). A
    // vezérlés így nem tapad a lista utolsó sorához, és a tábla mint egység
    // látszik.
    //
    // A KÖLTSÉGE NULLA A VIEWPORTBAN: a `chromeRows` (4) MÁR két olyan sorral
    // számol, ami a fában nem volt benne — a saját kommentje szerint "fejléc (1) +
    // üres (1) + status (1) + legenda (1)", miközben a globális status-sor a
    // wf31/23-ban kivezetődött, az "üres" pedig sosem került be. A két vonal tehát
    // azt a helyet foglalja el, amit a becslés eddig is lefoglalt: a listából
    // egyetlen sor sem esik ki.
    //
    // A FULL SCREEN INVARIÁNS SEM MOZDUL: a gyökér `Box` fix `height: boxRows`-t
    // kap, tehát a fa MINDIG kitölti a terminált (a maradék hely üresen áll) — az
    // Ink `shouldClearTerminalForFrame`-je minden frame-en teljesül, függetlenül a
    // tartalom magasságától. Egy TARTALOMBÓL méretezett fánál ez a beszúrás
    // elmozdíthatná a fullscreen-határt, és visszahozná a resize-flickert.
    //
    // CSAK AKKOR, HA VAN TÁBLA: betöltés alatt (üres lista) a két vonal a
    // "betöltés…" feliratot keretezné körbe — ott nincs mit elválasztani.
    // (wf31/51) OVERLAY NYITVA CSAK HELYKIHAGYÁS: a panel SAJÁT kerete már
    // elválaszt, egy vonal FÖLÖTTE csak vonalat halmoz. A hely viszont marad, hogy
    // a lista ne ugorjon — lásd a `tableSeparator` `line` flagjének indoklását.
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
          // OVERLAY NYITVA → a lista tompított KONTEXTUS, nem a fókusz.
          dimmed: frame !== null,
          // (wf31/27) A TÁBLA szélessége, NEM a terminálé — a kurzor-háttér a tábla
          // jobb széléig megy, nem a monitor széléig. A user lelete: "csak odáig
          // menjen a highlight is". A `layout.width` a TARTALOMBÓL számolódik (lásd a
          // `listLayout` width-ágának indoklását).
          columns: layout.width,
          // (wf31/38) A VÁGÁS PLAFONJA AZ AZONNALI MÉRÉS (`capWidth`), NEM a
          // debounce-olt `width`. Szűkítéskor így a sor a KÖZTES frame-ekben is
          // befér (csonkoltan, de nem tördelve) — a tördelés az, ami az Ink
          // törlés-számítását elcsúsztatja, és a flickert adja.
          //
          // A `Math.min` a `layout.width`-tel: a tábla-szélesség a TARTALOMRÓL szól
          // (rövidebb címeknél szűkebb a terminálnál), a cap a FIZIKAI korlátról. A
          // kisebb nyer — a `Row` háttér-kitöltése így nem lóg túl egyiken sem.
          terminalColumns: capWidth > 0 ? Math.min(capWidth, layout.width || capWidth) : layout.width,
          // (wf31/56) A FADE FRAME-SZÍNE. A végállapot a `FADED_COLOR`, tehát a
          // nyugalmi kép azonos a wf31/55-össel — az animáció csak az ÁTMENETET adja.
          fadeT,
          fadePalette: themeColors,
        })
        // A PANEL BESZÚRÁSA a kurzor sora UTÁN. `flatMap`, hogy a panel a lista
        // GYEREKEI KÖZÉ kerüljön — egy külön Box a lista után a sor ALÁ helyezés
        // követelményét nem tudná teljesíteni.
        // (wf31/65) FLOAT MÓDBAN NINCS BESZÚRÁS: a panel a gyökér utolsó
        // gyerekeként lebeg (a fa-sorrend a "z-index"), a lista érintetlen.
        if (isInline && !PANEL_FLOAT && i + 1 === insertAfter) {
          return [rowNode, h(React.Fragment, { key: `panel-${row.number}` }, panelNode)]
        }
        return [rowNode]
      }),
      // FAIL-SOFT: ha a kurzor sora nincs a látható ablakban (a viewport
      // szerződése ezt kizárja — ez a védőháló), a panel a lista VÉGÉRE kerül.
      // Némán elhagyni ROSSZABB: a user `i`-t nyomott, és semmi nem történne.
      ...(isInline && !PANEL_FLOAT && cursorAt < 0 ? [panelNode] : []),
    ),
    ...(visibleRows.length > 0 && hasFooter ? [tableSeparator(separatorWidth, 'sep-bottom')] : []),
    // A STATUS-SOR KÉT FORRÁSA: `busy` (blokkoló akció fut) és `status` (a
    // legutóbbi akció eredménye). Az AI-REVIEW JELZÉSEI NINCSENEK ITT TÖBBÉ
    // (a user 3. pontja: "a statusüzenet a képernyő lenti részén nem jó hely,
    // mutálja a layoutot") — a progressz, a végállapotok és a hibák a
    // PR-PANELBEN élnek (aiReviewPanelLines), a futás tényét a lista-sor
    // Braille-spinnere jelzi.
    // A KILÉPÉS-KÉRDÉS MINDENT MEGELŐZ, és NEM dimmelt: ez az EGYETLEN hely, ahol
    // a status-sor DÖNTÉST kér, nem tájékoztat. A `busy` alatt is látszania kell,
    // mert a kérdés a futó review-ról szól.
    // (wf31/9) A KILÉPÉS-KÉRDÉS EGYETLEN OKA A FUTÓ REVIEW. A betöltetlen
    // findingok pending-ága KIVEZETVE (lásd a `q` kulcs ágát): a disk-cache óta
    // ott nem volt veszteség, csak tájékoztatás a cache működéséről — a user
    // döntése szerint az automatikus default, amiről nem kell szólni.
    // (wf31/23) A GLOBÁLIS STATUS-SOR KIVEZETVE.
    //
    // A user döntése, szó szerint: "Van az appon lent egy mini feedback, pl.
    // »megszakítva« […] nem kérek ilyen global statust, vedd ki, hülyén is néz ki
    // ott lent. De máshol se legyen. Amikor pending állapotra van szükség, azt
    // mindig a triggerelő legendnél tedd be […] tehát kontextuális legyen."
    //
    // A HÁROM ÜZENET-OSZTÁLY ÚJ HELYE:
    //   · PENDING (`⏳ approve…`)     → a LEGEND-be, a triggerelő kulcs mellé
    //     (`a: approve (fut…)`) — kontextuálisan, ahogy a user kérte;
    //   · EREDMÉNY (`#895: merged`)  → a FEJLÉCBE, jobbra igazítva (a user
    //     pontosítása: "Inkább akkor a fejlécbe tedd, ki jobbra..");
    //   · INPUT-VÁLASZ (`megszakítva`) → ugyanoda, a fejléc jobb szélére.
    //
    // AMI ITT MARAD: KIZÁRÓLAG a kilépés-kérdés. Az nem status, hanem VÁRAKOZÓ
    // DÖNTÉS — a `y`/`n` amíg nyitva van, minden más kulcsot elnyel, tehát a
    // képernyőn kell lennie. A `betöltés…` is marad: az az EGYETLEN állapot,
    // amikor még nincs se lista, se legend, amihez a jelzést kötni lehetne.
    exitConfirm
      ? h(Text, { color: 'yellow' },
          'fut egy AI-review — a kilépés megszakítja (a hunk sessionbe írt findingok '
          + 'megmaradnak). Kilépsz? [y/N]')
      // BETÖLTÉS ALATT (loadedAt még nincs): üres sor + önálló felirat — a
      // rendes status-sor nem látszik (a user: "a szó körül is lehetne
      // kihagyás… a status sort nem jeleníteném meg, amíg betöltés van").
      : loadedAt === null
      ? h(React.Fragment, null, h(Text, null, ' '), h(Text, { dimColor: true }, 'betöltés…'))
      : null,
    // A globális legendát overlay nyitva NEM mutatjuk: a nyitott overlay kulcsai
    // MÁSOK (a lábléce hirdeti őket), és a kettő egymás mellett azt sugallná,
    // hogy a lista kulcsai is élnek — holott a fókusz az overlayen van.
    // A lábléc-legenda BETÖLTÉS ALATT sem látszik (a user jelzése): nincs még
    // mit vezérelni — betöltés után tér vissza.
    // (wf31/11) A LEGENDA MOSTANTÓL STATIKUS: a PR-szintű, állapotfüggő kulcsok
    // (`c`/`d`/`r`/`f`) a PANEL láblécébe kerültek, ahol a döntés is születik —
    // itt csak a lista-szintű kulcsok maradtak.
    // (wf31/45) A PENDING A LEGEND JOBB SZÉLÉN, INVERZ KIEMELÉSSEL. A bal oldal
    // (a kulcs-lista) BÁJTRA változatlan, tehát nincs layout jump — az indoklás a
    // `legendWithPending` fejénél áll.
    //
    // HÁROM TEXT, mert az `inverse` attribútum Text-enként él: a `left` dim, a
    // `gap` semleges (csak hely), a `right` inverz. Egy összefűzött string ezt nem
    // tudná kifejezni.
    ...(frame || loadedAt === null
      ? []
      : [(() => {
          // (wf31/46) A TÁBLA SZÉLESSÉGE, NEM A VIEWPORTÉ. A user lelete: "megint a
          // viewport jobb szélére vitted a table jobb széle helyett. Ezt a
          // fejlécben már megoldottad."
          //
          // A `layout.width` a TARTALOMBÓL számolt tábla-szél (lásd a `listLayout`
          // width-ágát) — a fejléc `notice`-a is ehhez igazodik (wf31/27). A legend
          // pending-jének UGYANIDE kell: a három efemer jelzés (fejléc-notice,
          // legend-pending) így EGY vonalban áll a lista jobb szélével, nem a
          // monitor széléhez tapadva.
          //
          // A `width`-re esünk vissza, ha a tábla még nincs (üres lista, betöltés) —
          // ott a `layout.width` 0, és egy 0-s mérték minden jelzést elnyelne.
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
    // (wf31/65) A LEBEGŐ PANEL — UTOLSÓ GYEREKKÉNT, mert az Ink Output-bufferében
    // a KÉSŐBB írt node fedi a korábbit: ez teszi a panelt "legfelülre". Az
    // absolute pozíció a flow-ból kiveszi, tehát a fenti sorokat nem tolja el.
    ...(isInline && PANEL_FLOAT ? [panelNode] : []),
  )
}

export async function runTui() {
  // A TUI-nak valódi TTY kell — nem-TTY-n a hívó (tuipr.sh) a listát adja,
  // ide nem is jutunk el. Defenzíven mégis ellenőrizzük.
  if (!process.stdout.isTTY) {
    process.stderr.write('a TUI-hoz TTY kell — használd az `tuipr queue --list`-et\n')
    process.exitCode = 1
    return
  }
  // (wf31/34) ALTERNATE SCREEN — A RESIZE-GLITCH SZERKEZETI MEGOLDÁSA.
  //
  // A HÁROM ELŐZŐ KÍSÉRLET ÉS A BUKÁSUK OKA (mind MÉRVE, a user leletein):
  //   · wf31/28-29: kemény cella-plafon minden kiírt soron. A sorok tényleg nem
  //     lógnak túl (mérve 190/100/60/40/20 cellán) — a glitch MEGMARADT;
  //   · wf31/31: saját `2J/3J/H` a resize-eventben. A képernyő KIÜRÜLT és NEM jött
  //     vissza, mert az Ink `onRender`-je a `output === lastOutput` diffen kilép:
  //     a state-bump a KIMENETET nem változtatta meg;
  //   · wf31/33: a szélesség három forrásból, a legkisebb nyer. A sorok már az
  //     első resize-renderben helyes mértékkel épülnek — a glitch MEGMARADT.
  //
  // A TANULSÁG: a hiba NEM a mi szélesség-számításunkban van. Az Ink `resized`
  // handlere a `log-update` SORSZÁM-ALAPÚ törlésére épül (`eraseLines(previousLineCount)`),
  // és szélesítésnél egyáltalán nem töröl. Ezt kívülről nem tudjuk megjavítani: a
  // `lastOutput`/`lastOutputHeight` privát, a publikus `clear()` pedig
  // SZINKRONIZÁLJA a `lastOutput`-ot, tehát utána a következő render „változatlannak"
  // látja a fát.
  //
  // AZ ALTERNATE SCREEN EZT SZERKEZETILEG KERÜLI MEG: a TUI a MÁSODLAGOS
  // terminál-bufferbe rajzol, aminek nincs scrollbackje. A resize-kor keletkező
  // maradék tehát nem tud FELHALMOZÓDNI — a buffer mérete maga a viewport, és a
  // terminál a saját újrarajzolását végzi. Ez a `vim`/`less`/`htop` bejáratott
  // mintája, nem trükk.
  //
  // AMIT MÉG MEGOLD (a wf31/28-as kérésed): a kilépés `exitAlternativeScreen`-t ír,
  // tehát a PROMPTOD ÉRINTETLENÜL visszatér — a lista NEM marad ott a scrollbackben.
  // A saját `2J/3J/H` takarításom ezzel FELESLEGESSÉ vált, és ki is vezettem: két
  // mechanizmus ugyanarra a célra azt jelentené, hogy az egyik némán elavul.
  //
  // A HUNK-MEGNYITÁS (`suspendTerminal`) SZIMMETRIKUS: az Ink `beginSuspend`-je
  // `exitAlternativeScreen`-t ír (a hunk a PRIMARY bufferben fut, ahogy kell), az
  // `endSuspend` pedig visszalép — ellenőriztem a forrásban (ink 7.1.1).
  //
  // FAIL-SOFT: a `resolveAlternateScreenOption` maga zárja ki a nem-TTY és CI
  // környezetet, tehát az opció ott némán no-op — nem kell külön guard.
  //
  // (wf32) A STDIN EXPLICIT A `stdinWrapper`-EN KERESZTÜL — lásd a
  // `DelegatingStdin` fejezetét. Az Ink így SOHA nem látja a valódi
  // `tty.ReadStream`-et, tehát a hunk-megnyitás (`openHunkView`) bármikor
  // kicserélheti a wrapper mögötti targetet, anélkül hogy az Ink erről tudna —
  // ez oldja meg a hunk-zárás utáni shell-en-ragadást (a stdin fd blokkoló
  // olvasásának stream-szintről visszavonhatatlan mivoltát).
  // (wf31/62) A TERMINÁL SZÍNEINEK EGYSZERI KIKÉRDEZÉSE — MÉG A RENDER ELŐTT.
  //
  // A válasz a stdin-en jön, ezért CSAK itt biztonságos, amikor az Ink (és a
  // stdinWrapper mögötti target) még nem olvas. Fail-safe: nem válaszoló
  // terminálon `null`, és a fade a beépített közelítésekkel megy tovább.
  // (indulási-fagyás) A KILL-SWITCH a diagnosztika A/B-karja: ha a fagyás a
  // színkérdezés kiiktatásával is előjön, a gyanú másra terelődik. Élesben is
  // ártalmatlan menekülőút (a fade a beépített közelítésekkel megy tovább).
  const themeColors = process.env.TUIPR_NEXT_TUI_NO_COLOR_QUERY
    ? null
    : await queryTerminalColors().catch(() => null)
  // (indulási-fagyás) A stdin-forward csatolása CSAK MOST — így a query alatt
  // az fd 0-n tényleg nem olvasott senki (lásd a DelegatingStdin konstruktorát).
  stdinWrapper.engage()
  const app = render(h(App, { themeColors }), { stdin: stdinWrapper, alternateScreen: true })
  await app.waitUntilExit()
}
