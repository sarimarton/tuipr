#!/usr/bin/env node

// tui — az Ink alapú review-munkaállomás BELÉPÉSI PONTJA.
//
// Ez a fájl szándékosan vékony: a logika a core-ban (tui-core.mjs), a
// React/Ink réteg az app-ban (tui-app.mjs) él. Az egyetlen dolga, hogy
// entryként elindítsa a TUI-t, és — visszafelé kompatibilitásból — továbbadja a
// core publikus felületét (a bin/tuipr.sh és a test/next-tui-*.test.ts
// fájlok ezt a fájlt hivatkozzák).
//
// MIÉRT NEM lakhat itt a logika: ha az app.mjs visszaimportál a belépési pontra,
// az KÖRKÖRÖS ESM-import. Entryként futtatva a ciklus nem tud bezáródni (a modul
// még kiértékelés alatt van, amikor az app visszaimportál rá), így a lenti
// dinamikus import top-level await-je sosem settle-el: a node exit 13-cal, ÜRES
// kimenettel hal meg. Élesben ez azt jelentette, hogy a TTY-s `tuipr queue`
// néma no-op volt (az `exec` még a 13-as exitet is elfedte 0-ra), és a runTui()
// defenzív TTY-checkje sem futott le. A függőségi irány ezért SZIGORÚAN
// egyirányú: az entry és az app is CSAK a core-ból importál, a core viszont
// egyikükből sem.
//
// HIBAKEZELÉSI SZERZŐDÉS (a néma exit osztálya ki van irtva):
//   - a TUI el sem indul, mert az ink nem resolválható → érthető magyarázat +
//     telepítési utasítás a stderr-re, exit EXIT_TUI_UNAVAILABLE (3), amire a
//     bin/tuipr.sh a lista-nézetre esik át;
//   - bármi MÁS hiba → hangosan, teljes stack trace-szel dobódik (nem nyeljük el);
//   - nincs olyan ág, ami 0 bájt kimenettel, exit 0-val visszatérne.

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
  // A modell-választás (5b): mindig explicit --model, default opus, TUI-váltó.
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
  // (wf24/4) A memoizált gyökér teszt-horgonya (a fixtúrák közti szivárgás ellen).
  resetRepoRootCache,
  // (dev-trunk átállás) A trunk-név EGY forrásból (env → package.json tuipr.trunk
  // → 'main') + a memoizálás teszt-horgonya. A bash oldal (tuipr.sh MAIN=)
  // ugyanezt a rangsort követi.
  trunkBranch,
  resetTrunkBranchCache,
  // (1a) A BETÖLTÖTT CORE azonosítója a fejléchez + a memoizálás teszt-horgonya.
  // A user mért költsége: ma többször nem tudta megállapítani, melyik kód fut.
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
  // A HÁTTÉR-REVIEW LÁTHATÓSÁGA (#904): eltelt-idő formázó, progressz-jelzés,
  // a HÉT végállapot és a `stream-json` sor-olvasó.
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
  // (1b) A LÉPCSŐS stacked-jelölés behúzás-prefixe — a renderelő és a
  // title-büdzsé KÖZÖS forrása (két számítás ugyanarra a mértékre elcsúszik).
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
  // A PANEL-réteg (dialógus-konszolidáció): egy PR-panel, inline info + modál
  // megerősítés, viewport-korlát, friction-szöveg és az attesztációs body.
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
  // A HIBRID FINDINGS réteg (dupla könyvelés): a válasz-JSON parse-olása, a
  // PR-ra kulcsolt findings-cache és a hunkba batch-betöltés + a sor-spinner.
  AI_PANEL_FINDINGS_SHOWN,
  // (wf24/2) Az AI-összegző panel-sorkorlátja — a render és a teszt EGY forrásból.
  AI_PANEL_SUMMARY_LINES,
  aiReviewPanelLines,
  answerFindingsNeedApply,
  answerFindingsPayload,
  applyAnswerFindings,
  cacheAiFindings,
  cacheMarkAiFindingsLoaded,
  cacheStoreAiFindings,
  // Az `r` életciklus-kulcs + a dupla-`x` elvetés (a user 4. élő tesztje).
  aiReviewLifecycle,
  cacheDiscardAiFindings,
  // A kilépés-guard bemenete (nema-veszteseg-1): betöltetlen findingos PR-ok.
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
  // (2) A REVIEW-CASCADE-MENÜ: a bőbeszédű AI-review megerősítő MODÁL helyén egy
  // HORIZONTÁLIS, két lépcsős alopció-menü a lábléc alatt. A dwell-kapu, a
  // váltók újra-armolás-tilalma és a budget-szivárgás-tilalom VÁLTOZATLAN.
  REVIEW_MENU_STAGES,
  reviewMenuAdvance,
  reviewMenuBack,
  reviewMenuLines,
  reviewMenuOpen,
  reviewMenuSelection,
  reviewMenuStep,
  reviewMenuToggle,
  reviewMenuWarning,
  // (1d) A REVIEW-EREDMÉNYEK DISZK-CACHE-E (/tmp) — a user kérése: "fárasztó
  // mindig újraindítani". A memória-cache marad a render-úton; ez a réteg
  // CSAK a kifizetett review-eredményt perzisztálja, horgonyhoz kötve.
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
  // (1d) A cache-gyökér teszt-horgonya. SZÁNDÉKOSAN nem a TMPDIR-en: a globális
  // env átírása MÁS tesztek stub-könyvtárait terelte el (MÉRVE: 31 teszt bukott).
  setReviewStoreBase,
  titleBudget,
  toGithubComments,
  uploadFindings,
} from './tui-core.mjs'

// A "TUI nem elérhető" DEDIKÁLT exit-kódja. A hívó (bin/tuipr.sh) EBBŐL
// tudja, hogy nem generikus hiba történt, hanem a TUI-mód nem futott le, tehát
// át kell esni a lista-nézetre. Ezért nem 1: az 1 a TTY-guard és minden más
// hibaág, arra nem szabad fallbackölni.
export const EXIT_TUI_UNAVAILABLE = 3

// Entryként futunk-e?
//
// FIGYELEM, EZ VOLT A NÉMA EXIT BUGJA: a naiv
//   import.meta.url === new URL(`file://${process.argv[1]}`).href
// összehasonlítás a SYMLINKELT fogyasztói úton MINDIG false-ot ad, mert a
// process.argv[1] a symlink-út (…/<repo>/node_modules/tuipr/bin/…),
// az import.meta.url viszont a node ESM-loader által REALPATH-olt út
// (…/packages/tuipr/bin/…). A mobile és a web a core-t symlinkkel
// fogyasztja, tehát élesben SOSEM egyeztek: a TUI-blokk kimaradt, a modul csak
// re-exportált, és a process 0 bájt kimenettel, exit 0-val visszatért. Nem
// "elnyelt hiba" volt — egyszerűen nem futott le semmi.
//
// A javítás: a process.argv[1]-et is realpath-oljuk, hogy ugyanazon a normál-
// formán hasonlítsunk, amit a loader használ. (A bash oldalon a SCRIPT_DIR
// logikai pwd-t használ, ezért ott a symlink-út érvényes marad — a normalizálás
// itt, a node oldalon a helye.)
const isMain = (() => {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href
  } catch {
    // Nem létező/olvashatatlan argv[1]: essünk vissza a naiv egyezésre, semmit
    // nem veszítünk vele.
    return import.meta.url === new URL(`file://${argv1}`).href
  }
})()

// A React/Ink rész csak akkor töltődik be, ha tényleg TUI-ként futunk — így a
// unit-tesztek (amik csak a tiszta függvényeket importálják) nem igényelnek
// telepített inket.
//
// MIÉRT FÜGGVÉNY, ÉS NEM CSAK EGY `if (isMain)` BLOKK: a telepített parancs
// (`bin/tuipr.mjs`) nem EZ a fájl, tehát az `isMain` ott hamis lenne, és a TUI
// néma no-opként térne vissza — pontosan az a hibaosztály, amit a fenti
// realpath-javítás egyszer már kiirtott. A bin ezért a `main()`-t hívja, nem
// az entry-heurisztikára bízza magát. Az `isMain`-ág megmarad, hogy a fájl
// közvetlenül futtatva is működjön (fejlesztés, teszt).
export async function main() {
  // Az app-modul útja env-ből felülírható — ez a teszt-fogantyú a "nem
  // resolválható függőség" ág fedezésére (más célra ne használd).
  const appModule = process.env.TUIPR_NEXT_TUI_APP || './tui-app.mjs'

  // Ink-feloldás a pkl.sh mintájára (scripts/pkl.sh): a fogyasztó fájában nem
  // biztos, hogy ott van az ink (pnpm hoisting, vendorolt telepítés), a core
  // checkoutjában viszont igen. A NODE_PATH-hoz hozzáadjuk a core saját
  // node_modules-át, hogy a bare import onnan is feloldódjon — a Node ezt a
  // CommonJS-hez tervezte, de a `createRequire`-alapú resolve-ot az ESM-loader
  // is tiszteletben tartja, ha a folyamat indulásakor be van állítva. Ezért:
  // ha az itteni (core-beli) node_modules létezik ÉS a bare 'ink' nem oldható
  // fel innen, akkor újraindítjuk magunkat a beállított NODE_PATH-tal.
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
      // Egyetlen respawn (a guard-env megakadályozza a végtelen ciklust), a
      // core node_modules-át a NODE_PATH elé fűzve.
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
    // CSAK a "nincs meg a modul/csomag" hibát kezeljük gracefully — minden más
    // (szintaktikai hiba, futásidejű throw a modul törzsében) VALÓDI bug, azt
    // hangosan, teljes stack trace-szel kell látni. Néma elnyelés nincs.
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    process.stderr.write(
      'A review-TUI nem indítható: az `ink` (React-terminál) függőség nem resolválható.\n' +
        `  (${error.message.split('\n')[0]})\n` +
        '\n' +
        'Mit tegyél:\n' +
        '  • fejlesztői gépen: futtass `pnpm install` (workspace root vagy az app package)\n' +
        '    — az ink a tuipr *dependency*-je, tehát a fogyasztó install-ja is lehúzza.\n' +
        '  • ha most nem tudsz installálni: a lista-nézet mindig működik:\n' +
        '    `tuipr queue --list` (vagy `--json`).\n' +
        '\n' +
        'Addig a lista-nézetet adom.\n',
    )
    process.exitCode = EXIT_TUI_UNAVAILABLE
  }
  installEscapeTrace()
  if (runTui) await runTui()
}

if (isMain) await main()

/**
 * DIAGNOSZTIKA — ESCAPE-SZEKVENCIA TRACE, opt-in, alapból NEM fut.
 *
 * MIÉRT LÉTEZIK: a hunk↔TUI váltás villanásait három szereplő escape-írásai
 * együtt okozzák (az Ink `beginSuspend`/`endSuspend`-je, a mi kompenzációink, és a
 * hunk késett szekvenciái a `script` PTY-ról). A sorrendjükre TIPPELNI nem lehet —
 * három javítási kör bizonyította. Ez a tracer a MÉRÉS: időbélyeggel naplózza,
 * melyik írás mikor ment ki.
 *
 * AMIT NEM LÁT: a hunk SAJÁT írásait. A gyerek `stdio: 'inherit'`-tel a nyers
 * fd-re ír, ami nem megy át a `process.stdout.write`-on. A hunk szekvenciái tehát
 * a naplóban NEM szerepelnek — a HIÁNYUK viszont épp annyira informatív: a
 * saját írásaink közti IDŐRÉS mutatja meg azt az ablakot, ahol a shell látszik.
 *
 * Használat:
 *   TUIPR_NEXT_TRACE=/tmp/tuipr-trace.log pnpm exec tuipr queue
 */
function installEscapeTrace() {
  const target = process.env.TUIPR_NEXT_TRACE
  if (!target) return
  const { appendFileSync } = require_fs()
  const t0 = process.hrtime.bigint()
  const ms = () => Number((process.hrtime.bigint() - t0) / 1000n) / 1000
  // A NEVESÍTETT SZEKVENCIÁK: csak az, ami a villanás szempontjából számít.
  const NAMES = [
    ['\u001B[?1049h', 'ENTER_ALT'],
    ['\u001B[?1049l', 'EXIT_ALT'],
    ['\u001B[?25l', 'CURSOR_HIDE'],
    ['\u001B[?25h', 'CURSOR_SHOW'],
    ['\u001B[2J', 'CLEAR_SCREEN'],
    ['\u001B[3J', 'CLEAR_SCROLLBACK'],
  ]
  // MEMÓRIA-PUFFER, NEM SORONKÉNTI FÁJLÍRÁS — MÉRT OK, AZ ELSŐ FUTÁS LELETÉBŐL.
  //
  // Az `appendFileSync` soronként ~7-9 ms-ot vitt: mérve, a `CHILD_EXIT` marker és
  // a KÖZVETLENÜL utána álló `write` között 8.8 ms telt el, holott a kódban két
  // egymást követő utasítás. Egy escape-villanás vizsgálatánál ez végzetes — a
  // tracer MAGA nagyította fel azokat az ablakokat, amiket mérni akartunk.
  // Pufferelve a log-hívás ára ~mikroszekundum, tehát az időbélyegek a VALÓDI
  // sorrendet és réseket mutatják.
  const buf = []
  const flush = () => {
    if (buf.length === 0) return
    try {
      appendFileSync(target, `${buf.join('\n')}\n`)
      buf.length = 0
    } catch { /* a trace hibája SOSEM buktathatja az appot */ }
  }
  const log = (kind, detail) => {
    buf.push(`${ms().toFixed(3).padStart(10)}ms  ${kind}${detail ? `  ${detail}` : ''}`)
    // A PLAFON a memória ellen véd, de akkora, hogy egy `d`+`q` kör BIZTOSAN
    // elférjen — különben pont a vizsgált szakaszon ütne be a fájlírás késése.
    if (buf.length >= 5000) flush()
  }
  process.on('exit', flush)
  // A MARKEREKET az app hívja (`globalThis.__tuiprTrace?.(…)`) — szándékosan
  // globálison át, hogy a diagnosztika NE szivárogjon be a modul-gráfba.
  globalThis.__tuiprTrace = (marker) => log(`>>> ${marker}`)
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => {
    try {
      const str = typeof chunk === 'string' ? chunk : String(chunk)
      const hits = NAMES.filter(([seq]) => str.includes(seq)).map(([, name]) => name)
      if (hits.length > 0) log(hits.join('+'), `(${str.length} bájt)`)
    } catch { /* lásd fent */ }
    return orig(chunk, ...rest)
  }
  log('TRACE_START', `pid=${process.pid}`)
}

// A `createRequire` már importálva van a fájl tetején; a tracer csak az fs-t kéri.
function require_fs() {
  return createRequire(import.meta.url)('node:fs')
}
