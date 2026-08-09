#!/usr/bin/env node

// tui — the ENTRY POINT of the Ink-based review workstation.
//
// This file is deliberately thin: the logic lives in the core (tui-core.mjs),
// the React/Ink layer lives in the app (tui-app.mjs). Its only job is to
// start the TUI when run as the entry, and — for backward compatibility — to
// pass through the core's public surface (bin/tuipr.sh and the
// test/next-tui-*.test.ts files reference this file).
//
// WHY THE LOGIC CANNOT LIVE HERE: if app.mjs imports back into the entry
// point, that's a CIRCULAR ESM import. Run as the entry, the cycle can never
// close (the module is still being evaluated when the app imports back into
// it), so the dynamic import's top-level await below never settles: node
// dies with exit 13 and EMPTY output. In production this meant the TTY
// `tuipr queue` was a silent no-op (`exec` even masked the exit 13 down to
// 0), and runTui()'s defensive TTY check never ran either. The dependency
// direction is therefore STRICTLY one-way: both the entry and the app import
// ONLY from the core, and the core imports from neither of them.
//
// ERROR-HANDLING CONTRACT (the silent-exit bug class is eradicated):
//   - the TUI fails to even start because ink isn't resolvable → a clear
//     explanation + install instructions to stderr, exit
//     EXIT_TUI_UNAVAILABLE (3), which bin/tuipr.sh falls back to the list
//     view on;
//   - any OTHER error → thrown loudly, with a full stack trace (never
//     swallowed);
//   - no branch returns with 0 bytes of output and exit 0.

import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export {
  agentReviewCommand,
  applyProgressToInfo,
  aiFindingsSchema,
  aiReviewBlockers,
  aiReviewBudgetState,
  aiReviewCommand,
  AI_REVIEW_ALLOWED_TOOLS,
  AI_REVIEW_ALLOWED_TOOLS_ARGS,
  AI_REVIEW_DISALLOWED_TOOLS,
  AI_REVIEW_DISALLOWED_TOOLS_ARGS,
  AI_REVIEW_SETTING_SOURCES,
  AI_REVIEW_SETTING_SOURCES_ARGS,
  // Model selection (5b): always explicit --model, default opus, TUI toggle.
  AI_REVIEW_DEFAULT_MODEL,
  AI_REVIEW_MODELS,
  aiReviewModelState,
  modelLine,
  modelStep,
  deniedCommandList,
  denialMessage,
  budgetLine,
  budgetStep,
  budgetToggle,
  BUDGET_STEPS_USD,
  aiReviewScope,
  aiReviewSummary,
  approveBlockers,
  buildRows,
  canApproveRow,
  canMergeRow,
  aiReviewGate,
  anchorsEqual,
  cacheAnchor,
  cacheEntryState,
  cacheGet,
  cacheIndicatorFlag,
  cacheInvalidateAll,
  cacheMarkMeasuring,
  cachePut,
  cacheState,
  CACHE_GLYPHS,
  createCache,
  hasReviewTrace,
  markReviewTrace,
  reviewTraceSources,
  REVIEW_TRACE_GLYPH,
  reviewTraceFlag,
  branchLabel,
  buildInfoModel,
  claudePath,
  confirmAccepts,
  CONFIRM_DWELL_MS,
  conflictAdvice,
  depExplanation,
  displayWidth,
  fetchDiagnosis,
  fetchMainSha,
  fetchMainShaAsync,
  fetchPrFiles,
  fetchPrRefs,
  fetchQueue,
  fetchQueueAsync,
  fetchStalenessProbeAsync,
  hunkCommentCount,
  hunkComments,
  hunkCommentsCommand,
  hunkSessionAlive,
  hunkSessionReloadCommand,
  reviewSpawnOptions,
  makeStuckViewWatchdog,
  openReviewView,
  fetchRepoRoot,
  // (wf24/4) The memoized root's test anchor (against leakage between
  // fixtures).
  resetRepoRootCache,
  // (dev-trunk switch) The trunk name from ONE source (env → package.json
  // tuipr.trunk → 'main') + the memoization test anchor. The bash side
  // (tuipr.sh MAIN=) follows the same precedence.
  trunkBranch,
  resetTrunkBranchCache,
  // (1a) The LOADED CORE's identifier for the header + the memoization test
  // anchor. The user's measured cost: today they repeatedly couldn't tell
  // which code was running.
  fetchCoreSha,
  resetCoreShaCache,
  probeHunkSession,
  reloadHunkSession,
  waitForHunkSession,
  hunkSessionListCommand,
  hunkAgentNoteIds,
  hunkLiveSessionId,
  aiReviewGateByIds,
  startAgentReview,
  // BACKGROUND-REVIEW VISIBILITY (#904): elapsed-time formatter, progress
  // indicator, the SEVEN end states and the `stream-json` line reader.
  AI_REVIEW_LONG_MS,
  AI_REVIEW_P90_MS,
  AI_REVIEW_TIMEOUT_MS,
  AI_REVIEW_TYPICAL_MS,
  aiReviewAgentAdditions,
  aiReviewOutcome,
  aiReviewProgressLabel,
  formatElapsed,
  parseStreamProgressLine,
  HUNK_SESSION_HINT,
  isNoActiveSession,
  noActiveSessionMessage,
  clampCells,
  listLayout,
  // (1b) The STEPPED stacked-marker indent prefix — the SHARED source for
  // the renderer and the title budget (two calculations on the same measure
  // drift apart).
  stackIndent,
  STACK_MARK,
  overlayFrame,
  wrapCells,
  stepIndex,
  parseHunkAgentComments,
  parseProgressEvent,
  progressAbort,
  progressInit,
  progressLabel,
  progressReducer,
  fetchRebuildStatus,
  fetchStalenessProbe,
  headerLine,
  pollDue,
  pollFailure,
  pollGateReason,
  pollInit,
  pollNoteInput,
  pollProbeResult,
  pollStatusLabel,
  POLL_BACKOFF_MS,
  POLL_FAILURES_BEFORE_WARNING,
  POLL_IDLE_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  stalenessChanged,
  stalenessSignature,
  startProgressDiagnosis,
  reviewPathOptions,
  reviewPathWarning,
  runAgentReview,
  MARKS,
  mergeBlockers,
  mergeWarnings,
  mergePlan,
  // The PANEL layer (dialog consolidation): one PR panel, inline info + modal
  // confirmation, viewport limit, friction text and the attestation body.
  applyProgressToPanel,
  approveBody,
  clipBodyLines,
  frictionLines,
  modalChoiceStep,
  modalHasChoices,
  MODAL_CHOICES,
  MODAL_CHOICE_KINDS,
  panelClose,
  panelFooter,
  panelKeys,
  panelOpen,
  panelSections,
  panelToInline,
  panelToModal,
  panelViewport,
  PANEL_MIN_LIST_ROWS,
  injectHunkComments,
  // The HYBRID FINDINGS layer (double bookkeeping): parsing the response
  // JSON, the PR-keyed findings cache, and batch-loading into the hunk + the
  // row spinner.
  AI_PANEL_FINDINGS_SHOWN,
  // (wf24/2) The AI-summary panel row limit — render and test from ONE
  // source.
  AI_PANEL_SUMMARY_LINES,
  aiReviewPanelLines,
  answerFindingsNeedApply,
  answerFindingsPayload,
  applyAnswerFindings,
  cacheAiFindings,
  cacheMarkAiFindingsLoaded,
  cacheStoreAiFindings,
  // The `r` lifecycle key + the double-`x` discard (the user's 4th live
  // test).
  aiReviewLifecycle,
  cacheDiscardAiFindings,
  // The exit-guard input (silent-loss-1): PRs with unloaded findings.
  cacheUnappliedAiFindingPrs,
  rKeyLabel,
  parseAnswerFindings,
  REVIEW_SPINNER_FRAMES,
  reviewSpinnerFlag,
  parseAgentReviewEnvelope,
  parseAiReviewResult,
  parseAttribution,
  reviewBody,
  runAiReview,
  reviewCommand,
  RMARKS,
  // (2) The REVIEW-CASCADE MENU: in place of the verbose AI-review
  // confirmation MODAL, a HORIZONTAL, two-stage sub-option menu under the
  // footer. The dwell gate, the re-arm ban on the toggles, and the
  // budget-leak ban are UNCHANGED.
  REVIEW_MENU_STAGES,
  reviewMenuAdvance,
  reviewMenuBack,
  reviewMenuLines,
  reviewMenuOpen,
  reviewMenuSelection,
  reviewMenuStep,
  reviewMenuToggle,
  reviewMenuWarning,
  // (1d) The DISK CACHE (/tmp) for review results — the user's request:
  // "it's tiring to always restart". The memory cache stays on the render
  // path; this layer ONLY persists the paid-for review result, keyed to an
  // anchor.
  REVIEW_STORE_DIR_NAME,
  REVIEW_STORE_SCHEMA,
  reviewStoreAnchor,
  reviewStoreDelete,
  reviewStoreDir,
  reviewStoreEntryState,
  reviewStoreLoadAll,
  reviewStorePath,
  reviewStoreRead,
  reviewStoreStateLoadable,
  reviewStoreWrite,
  // (1d) The cache root's test anchor. DELIBERATELY not on TMPDIR: rewriting
  // the global env diverted OTHER tests' stub directories (MEASURED: 31
  // tests failed).
  setReviewStoreBase,
  titleBudget,
  toGithubComments,
  uploadFindings,
} from './tui-core.mjs'

// The DEDICATED exit code for "TUI unavailable". The caller (bin/tuipr.sh)
// uses THIS to know that no generic error occurred, but that TUI mode simply
// didn't run, so it should fall through to the list view. Not 1 for that
// reason: 1 is the TTY guard and every other error branch, and those must
// NOT fall back.
export const EXIT_TUI_UNAVAILABLE = 3

// Are we running as the entry?
//
// WATCH OUT, THIS WAS THE SILENT-EXIT BUG: the naive
//   import.meta.url === new URL(`file://${process.argv[1]}`).href
// comparison ALWAYS came out false on a SYMLINKED consumer path, because
// process.argv[1] is the symlink path (…/<repo>/node_modules/tuipr/bin/…),
// while import.meta.url is the path REALPATH-ed by node's ESM loader
// (…/packages/tuipr/bin/…). Mobile and web consume the core through a
// symlink, so in production the two NEVER matched: the TUI block was
// skipped, the module only re-exported, and the process returned with 0
// bytes of output and exit 0. It wasn't a "swallowed error" — simply nothing
// ran at all.
//
// The fix: we realpath process.argv[1] too, so we compare on the same
// normal form the loader uses. (On the bash side, SCRIPT_DIR uses the
// logical pwd, so the symlink path stays valid there — the normalization
// belongs here, on the node side.)
const isMain = (() => {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href
  } catch {
    // Nonexistent/unreadable argv[1]: fall back to the naive comparison, we
    // lose nothing by it.
    return import.meta.url === new URL(`file://${argv1}`).href
  }
})()

// The React/Ink part only loads if we're actually running as the TUI — this
// way the unit tests (which only import the pure functions) don't require
// ink to be installed.
//
// WHY A FUNCTION, AND NOT JUST AN `if (isMain)` BLOCK: the installed command
// (`bin/tuipr.mjs`) is NOT this file, so `isMain` would be false there, and
// the TUI would return as a silent no-op — exactly the bug class the
// realpath fix above already eradicated once. The bin therefore calls
// `main()` directly, rather than relying on the entry heuristic. The
// `isMain` branch stays so the file also works when run directly
// (development, tests).
export async function main() {
  // The app module's path can be overridden from env — this is the test
  // handle for covering the "dependency not resolvable" branch (don't use it
  // for anything else).
  const appModule = process.env.TUIPR_NEXT_TUI_APP || './tui-app.mjs'

  // Ink resolution follows the pattern of pkl.sh (scripts/pkl.sh): the
  // consumer's tree isn't guaranteed to have ink (pnpm hoisting, vendored
  // installs), but the core's checkout does. We prepend the core's own
  // node_modules to NODE_PATH so the bare import resolves from there too —
  // Node designed this for CommonJS, but the ESM loader also honors the
  // `createRequire`-based resolve if it's set at process start. Hence: if
  // the node_modules here (in the core) exists AND the bare 'ink' can't be
  // resolved from it, we respawn ourselves with NODE_PATH set.
  const coreNodeModules = new URL('../node_modules/', import.meta.url)
  const coreNmPath = fileURLToPath(coreNodeModules)
  if (!process.env.TUIPR_NEXT_TUI_NO_RESPAWN && existsSync(coreNmPath)) {
    let inkResolvable = true
    try {
      createRequire(import.meta.url).resolve('ink')
    } catch {
      inkResolvable = false
    }
    if (!inkResolvable) {
      // A single respawn (the guard env prevents an infinite loop), with the
      // core's node_modules prepended to NODE_PATH.
      const nodePath = process.env.NODE_PATH ? `${coreNmPath}:${process.env.NODE_PATH}` : coreNmPath
      const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: { ...process.env, NODE_PATH: nodePath, TUIPR_NEXT_TUI_NO_RESPAWN: '1' },
      })
      process.exit(res.status ?? EXIT_TUI_UNAVAILABLE)
    }
  }

  let runTui
  try {
    ;({ runTui } = await import(appModule))
  } catch (error) {
    // We only handle the "module/package not found" error gracefully —
    // anything else (a syntax error, a runtime throw in the module body) is
    // a REAL bug, and must be seen loudly, with a full stack trace. No
    // silent swallowing.
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    process.stderr.write(
      'The review TUI cannot start: the `ink` (React terminal) dependency is not resolvable.\n' +
        `  (${error.message.split('\n')[0]})\n` +
        '\n' +
        'What to do:\n' +
        '  • on a dev machine: run `pnpm install` (workspace root or the app package)\n' +
        "    — ink is a *dependency* of tuipr, so the consumer's install pulls it too.\n" +
        "  • if you can't install right now: the list view always works:\n" +
        '    `tuipr queue --list` (or `--json`).\n' +
        '\n' +
        'Falling back to the list view for now.\n',
    )
    process.exitCode = EXIT_TUI_UNAVAILABLE
  }
  installEscapeTrace()
  if (runTui) await runTui()
}

if (isMain) await main()

/**
 * DIAGNOSTICS — ESCAPE-SEQUENCE TRACE, opt-in, OFF by default.
 *
 * WHY IT EXISTS: the flashes in the hunk↔TUI switch are caused by three
 * actors' escape writes together (Ink's `beginSuspend`/`endSuspend`, our own
 * compensations, and the hunk's delayed sequences from the `script` PTY).
 * Their order CANNOT be guessed — three fix rounds proved that. This tracer
 * is the MEASUREMENT: it logs, with a timestamp, which write went out when.
 *
 * WHAT IT DOESN'T SEE: the hunk's OWN writes. The child writes to the raw fd
 * via `stdio: 'inherit'`, which doesn't pass through `process.stdout.write`.
 * The hunk's sequences therefore DON'T appear in the log — but their ABSENCE
 * is just as informative: the TIME GAP between our own writes shows the
 * window where the shell is visible.
 *
 * Usage:
 *   TUIPR_NEXT_TRACE=/tmp/tuipr-trace.log pnpm exec tuipr queue
 */
function installEscapeTrace() {
  const target = process.env.TUIPR_NEXT_TRACE
  if (!target) return
  const { appendFileSync } = require_fs()
  const t0 = process.hrtime.bigint()
  const ms = () => Number((process.hrtime.bigint() - t0) / 1000n) / 1000
  // The NAMED SEQUENCES: only the ones that matter for the flash.
  const NAMES = [
    ['\u001B[?1049h', 'ENTER_ALT'],
    ['\u001B[?1049l', 'EXIT_ALT'],
    ['\u001B[?25l', 'CURSOR_HIDE'],
    ['\u001B[?25h', 'CURSOR_SHOW'],
    ['\u001B[2J', 'CLEAR_SCREEN'],
    ['\u001B[3J', 'CLEAR_SCROLLBACK'],
  ]
  // MEMORY BUFFER, NOT A PER-LINE FILE WRITE — A MEASURED REASON, FROM THE
  // FIRST RUN'S FINDING.
  //
  // `appendFileSync` cost ~7-9 ms per line: measured, 8.8 ms elapsed between
  // the `CHILD_EXIT` marker and the `write` DIRECTLY after it, even though
  // they're two consecutive statements in the code. For inspecting an
  // escape-sequence flash this is fatal — the tracer ITSELF was inflating
  // the very windows we wanted to measure. Buffered, the cost of a log call
  // is ~a microsecond, so the timestamps show the REAL order and gaps.
  const buf = []
  const flush = () => {
    if (buf.length === 0) return
    try {
      appendFileSync(target, `${buf.join('\n')}\n`)
      buf.length = 0
    } catch { /* the trace's own error must NEVER crash the app */ }
  }
  const log = (kind, detail) => {
    buf.push(`${ms().toFixed(3).padStart(10)}ms  ${kind}${detail ? `  ${detail}` : ''}`)
    // The CEILING guards against memory, but is large enough that a `d`+`q`
    // round SURELY fits — otherwise the file-write delay would hit exactly
    // the section under inspection.
    if (buf.length >= 5000) flush()
  }
  process.on('exit', flush)
  // The MARKERS are called by the app (`globalThis.__tuiprTrace?.(…)`) —
  // deliberately through a global, so the diagnostics DON'T leak into the
  // module graph.
  globalThis.__tuiprTrace = (marker) => log(`>>> ${marker}`)
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => {
    try {
      const str = typeof chunk === 'string' ? chunk : String(chunk)
      const hits = NAMES.filter(([seq]) => str.includes(seq)).map(([, name]) => name)
      if (hits.length > 0) log(hits.join('+'), `(${str.length} bytes)`)
    } catch { /* see above */ }
    return orig(chunk, ...rest)
  }
  log('TRACE_START', `pid=${process.pid}`)
}

// `createRequire` is already imported at the top of the file; the tracer
// only needs fs.
function require_fs() {
  return createRequire(import.meta.url)('node:fs')
}
