// tuipr — AI-REVIEW-CONFIG: az AI-review ELŐFELTÉTELEI és user-választásai.
//
// Ami itt lakik: a scope-szűrés (generált/lockfile kizárás), a claude-út
// felderítése, a blokkolók, a dwell-kapu (typeahead), a költés-plafon
// (DEFAULTBAN OFF) és a modell-választó (default opus), a review-út opciók, és a
// megerősítő ekrán összegző szövege.
//
// RÉTEGREND: lefelé importál (layout: a summary cellában mér; queue-fetch: a
// PR-fájlok). SEMMIT nem importál a core-ból vagy felette.
//
// A KÖLTÉS-PLAFON DEFAULT-OFF invariánsát a tesztek A TELJES MODUL-FELÜLETEN
// mérik (egyetlen függvény-paraméter sem adhat nem-nulla plafont) — a flag csak
// EXPLICIT user-döntésre mehet ki.
import { displayWidth, stepIndex } from './layout.mjs'
import process from 'node:process'
import { accessSync, constants } from 'node:fs'
import { spawnSync } from 'node:child_process'

// --- AI-review: `claude -p` a TUI-ból ('r' billentyű) ----------------------
//
// A FELELŐSSÉG-MODELL: a hívás a FUTTATÓ FEJLESZTŐ lokális Claude-credentialját
// fogyasztja (OAuth/keychain), nem a CI org-szintű secret-pooljából. Ez ugyanaz
// a bucket, mint a hunk-os lokális review-nál, tehát a felelősség kategóriája
// NEM változik — de a költés valós, ezért megerősítés-köteles (lásd
// aiReviewSummary + a TUI confirm-kapuja).
//
// A SZERZŐDÉS HÁROM PONTON FAIL-CLOSED, és mindhárom MÉRT csapdára válaszol:
//
//  1. Az EXIT-KÓD NEM GATE. A `claude -p` adhat exit 0 + `subtype:"success"` +
//     `is_error:false` választ úgy, hogy a review NEM futott le — mérve: a
//     `/security-review` "git repository-n belül futtatható, de a cwd nem az"
//     prózát adott vissza, teljesen sikeres burkolóval. Fail-closed gate nélkül
//     a TUI "0 finding, minden rendben"-t jelentett volna: pontosan az a hazug
//     üres válasz, amit a --json szerződés tilt. Ezért a VALÓDI gate a
//     strukturált findings-parse (parseAiReviewResult), és a hiányzó
//     findings-kulcs DOBÁS, nem üres lista.
//  2. A SCOPE-SZŰRÉS ELŐFELTÉTEL, nem opció. A #911 teljes diffje mérve
//     ~8,88 MB / 275 248 sor ≈ 2,2–2,5M token, a contextWindow 1M — a naiv
//     "adjuk be a diffet" út GARANTÁLTAN elhasal. A churn 97%-a 13 generált
//     fixture (egyetlen pack.json 198 483 sor); a valódi kód 87 fájl / 7 882 sor
//     ≈ 184k token, ami kényelmesen befér. A kizárást a megerősítő ekrán
//     MEGMUTATJA: a fejlesztőnek tudnia kell, mit NEM reviewolt az AI.
//  3. A KÖLTÉS-PLAFON HARD. A `--max-budget-usd` mindig ki van töltve, mert a
//     review-skillek agent-fanoutja miatt a költés nem lineáris a diff-mérettel:
//     a becslés nem védelem, a plafon az.
//
// AMI SZÁNDÉKOSAN NEM ITT VAN: a findingok NEM mennek egyenest GitHubra. A
// runAiReview eredménye a HUNK SESSIONBE kerül (injectHunkComments), ahol a
// fejlesztő végigmegy rajtuk, töröl/szerkeszt — és a meglévő 'f' út tölti fel.
// Ez a human-in-the-loop kapu az, ami a body `verifiedBy` állítását IGAZZÁ teszi.

/**
 * A generált/derivált fájlok minta-listája — ezeket az AI-review kihagyja.
 *
 * Miért glob-lista és nem méret-heurisztika: a méret önmagában nem mond semmit
 * a reviewálhatóságról (egy 2000 soros kézzel írt view reviewálandó, egy 12
 * soros generált snapshot nem), a generáltság viszont a fájl SZEREPÉBŐL
 * következik. A `reason` a megerősítő ekrán szövege, ezért magyar.
 */
const GENERATED_PATTERNS = [
  { re: /(^|\/)pack\.json$/, reason: 'generált scenario-pack' },
  { re: /\.jsonl$/, reason: 'generált event-stream (jsonl)' },
  { re: /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Podfile\.lock)$/, reason: 'lockfile' },
  { re: /(^|\/)__snapshots__\//, reason: 'jest snapshot' },
  { re: /\.snap$/, reason: 'jest snapshot' },
  { re: /(^|\/)(generated|__generated__)\//, reason: 'generált könyvtár' },
  { re: /\.generated\.[a-z]+$/, reason: 'generált fájl' },
]

/**
 * A PR fájl-listájából a reviewálandó scope és a kizártak.
 *
 * A visszatérés ALAKJA szándékosan aszimmetrikus: a `scope` puszta útvonal-lista
 * (ez megy a promptba), a `excluded` viszont OKKAL együtt — mert azt a
 * megerősítő ekrán mutatja meg, és egy indoklás nélküli "kihagyva: 13 fájl"
 * nem auditálható.
 */
export function aiReviewScope(files) {
  const scope = []
  const excluded = []
  for (const f of files) {
    const hit = GENERATED_PATTERNS.find((p) => p.re.test(f.path))
    if (hit) excluded.push({ path: f.path, reason: hit.reason, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })
    else scope.push(f.path)
  }
  return { scope, excluded }
}

// Az a fájlszám, ami fölött a megerősítő ekrán NYOMATÉKOSAN figyelmeztet. A
// #911 (100 fájl) van a fejünkben, de a küszöb nem rá van szabva: 40 fájl fölött
// egy AI-review már többszáz ezer token, és a fejlesztő sem tudja átolvasni a
// findingokat egy ülésben. A küszöb LÁTHATÓ konstans, nem szórt magic number.
const AI_LARGE_FILES = 40
const AI_LARGE_CHURN = 5000

/**
 * A `claude` bináris útja, vagy null. A hiánya BLOKKOLÓ, nem néma no-op.
 *
 * A PATH-ot MAGUNK járjuk be, nem `command -v`-t shellezünk: a `shell: true` +
 * args kombináció Node-deprecated (DEP0190, escape-elés nélküli konkatenáció),
 * és egy `/bin/sh` indítást is megspórolunk. A `spawnSync('claude', …)` ENOENT-je
 * nem elég korai jelzés: a megerősítő ekrán a hívás ELŐTT akarja tudni, hogy
 * van-e claude egyáltalán.
 */
export function claudePath() {
  const dirs = (process.env.PATH || '').split(':').filter((d) => d.length > 0)
  for (const d of dirs) {
    const p = `${d}/claude`
    try {
      // X_OK: a puszta létezés nem elég, futtathatónak is kell lennie.
      accessSync(p, constants.X_OK)
      return p
    } catch {
      // Nem ebben a könyvtárban van — a következő PATH-elem jön. Ez NEM
      // hibaelnyelés: a hiány normális eset, és a végén null-lal jelezzük.
    }
  }
  return null
}

/**
 * Az AI-review blokkolói, FELSOROLVA — a megerősítő ekrán ezt mutatja, és y-ra
 * csak üres lista mellett indul (ugyanaz a mechanika, mint a mergeBlockers).
 *
 * A claude hiánya MAGYARÁZÓ hibát ad, nem csak egy "nincs claude"-ot: a projekt
 * szabálya szerint a néma/érthetetlen hibaelnyelés tilos.
 */
export function aiReviewBlockers({ claudePath: cp, scope }) {
  const out = []
  if (!cp) {
    out.push(
      'a `claude` CLI nem található a PATH-on — az AI-review a lokális Claude Code '
      + 'telepítést hívja (`claude -p`). Telepítsd, vagy tedd a PATH-ra, majd próbáld újra.',
    )
  }
  if (!scope || scope.length === 0) {
    out.push(
      'a review-scope ÜRES: a PR minden fájlja generált/lock fájl, tehát nincs mit '
      + 'AI-review-ra adni. Reviewold a diffet kézzel (`d`).',
    )
  }
  return out
}

/**
 * A megerősítő ekrán MINIMÁLIS dwell-ideje ms-ban: ennyi ideig nem fogadunk el
 * 'y'-t a mountolás után. 250 ms — a szándékos gombnyomáshoz a szem-kéz kör
 * ennél lassabb, a pufferelt keypress viszont ~0 ms-nál csapódik be.
 */
export const CONFIRM_DWELL_MS = 250

// --- A költés-plafon: DEFAULTBAN KIKAPCSOLVA -------------------------------
//
// A MÉRT TÉNY, amiből a döntés következik (`claude --help`):
//     --max-budget-usd <amount>   Maximum dollar amount to spend on API calls
//                                 (only works with --print)
// Tehát a flag API-KÖLTÉSRE való fogalom: dollárban vágja el a futást. A user
// viszont SUBSCRIPTION limitet fogyaszt (nincs ANTHROPIC_API_KEY, OAuth-alapú
// auth), ahol nincs dollár-számla, amit vágni lehetne. Ott egy szám alapján
// történő hard vágás legjobb esetben no-op, legrosszabb esetben FÉLÚTON elvágja
// a review-t: a tokent elköltötte, findingot nem ad. Az elvágott review
// ROSSZABB, mint a plafon nélküli futás.
//
// EZÉRT a szerződés három pontja:
//   1. DEFAULT OFF, és kikapcsolva a `--max-budget-usd` EGYÁLTALÁN nincs az
//      argv-ben (nem 0, nem "unlimited", nem undefined-string — nincs flag);
//   2. ad hoc kapcsolható a TUI-ban, de HANGSÚLYTALANUL: egy dimmelt sor az
//      overlay alján. Nem kap kiemelést és nem kap magyarázó bekezdést, mert
//      amit tud, az bizonytalan — a UI ne higgyen róla többet;
//   3. a VALÓDI védelem a subscription-limitre a PR-MÉRET-INFO (fájlszám +
//      diff-sorok, nagy PR-on kiemelten) — az bizonyítottan hasznos, tehát az
//      a hangsúlyos rész, nem ez.
//
// A VÁLASZTÁS NEM RAGADÓS a sessionön túl: nincs perzisztálás. Egy elfelejtett,
// diszkre írt plafon pont az a néma vágás lenne, amit a fenti indoklás tilt.

/**
 * A választható plafon-fokozatok USD-ben. LÁTHATÓ, fix lista, nem szabad
 * beírás: egy szabad numerikus input a TUI-ban több kódot és több hibaesetet
 * adna (parse, validálás, kurzor), mint amennyit egy bizonytalan hatású flag
 * megér. Öt fokozat elég a "nagyságrend" kifejezésére.
 */
export const BUDGET_STEPS_USD = [1, 2, 3, 5, 10]

/**
 * A plafon KEZDŐÁLLAPOTA: `{ enabled, usd }`.
 *
 * Az env (`TUIPR_AI_REVIEW_BUDGET_USD`) csak KEZDŐÉRTÉKET ad — ha van érvényes
 * értéke, bekapcsolt állapotból indulunk azzal a számmal. Env nélkül KIKAPCSOLT
 * állapot, `usd: undefined`, tehát a hívási úton nincs mit átadni.
 *
 * Az ÉRVÉNYTELEN env NEM kapcsol be (fail-closed a KIKAPCSOLT irányba): a
 * `Number('')` 0-t, a `Number('abc')` NaN-t ad, és egyik sem szándék-jelzés. A
 * 0 azonnal elvágott review lenne, a NaN pedig parse-hiba a claude oldalán —
 * mindkettő rosszabb, mint a plafon nélküli futás.
 */
export function aiReviewBudgetState({ env } = {}) {
  const n = Number(env)
  if (env !== undefined && env !== null && String(env).trim() !== '' && Number.isFinite(n) && n > 0) {
    return { enabled: true, usd: n }
  }
  return { enabled: false, usd: undefined }
}

/**
 * A `b` billentyű: be/ki. Bekapcsoláskor a legutóbbi (vagy a default) fokozatra
 * ül vissza, kikapcsoláskor az `usd` ELTŰNIK — nem "megőrzött, de inaktív"
 * érték, mert egy inaktív szám a hívási úton pont az a szivárgás, amit az
 * argv-guard tesztje tilt.
 */
export function budgetToggle(state) {
  const on = state?.enabled === true
  if (on) return { enabled: false, usd: undefined }
  const prev = Number(state?.usd)
  const usd = BUDGET_STEPS_USD.includes(prev) ? prev : BUDGET_DEFAULT_USD
  return { enabled: true, usd }
}

// A bekapcsoláskor felvett fokozat. A 3 USD a lista közepe: nem a legkisebb
// (ami félúton vágna), nem a legnagyobb (ami látszatra "korlátlan").
const BUDGET_DEFAULT_USD = 3

/**
 * A `←`/`→` léptetés a fokozatokon, KÖRBE.
 *
 * KIKAPCSOLT állapotban NO-OP: a léptetés NEM kapcsol be. A kapcsoló a `b`, és
 * ha a nyíl is bekapcsolna, egy véletlen nyíl-nyomás némán plafont húzna a
 * futásra — pont az a néma állapotváltás, amit a fail-closed elv tilt.
 */
export function budgetStep(state, delta) {
  if (state?.enabled !== true) return { enabled: false, usd: undefined }
  const i = BUDGET_STEPS_USD.indexOf(Number(state.usd))
  const from = i >= 0 ? i : BUDGET_STEPS_USD.indexOf(BUDGET_DEFAULT_USD)
  return { enabled: true, usd: BUDGET_STEPS_USD[stepIndex(from, BUDGET_STEPS_USD.length, delta)] }
}

/**
 * A budget-sor SZÖVEGE — egy sor, dimmelten, az overlay alján.
 *
 * A BIZONYTALANSÁG KIMONDVA, de zárójelben és röviden: a `claude --help` szerint
 * a flag "API calls"-ra vonatkozik, a user viszont subscription-limitet
 * fogyaszt, tehát nem tudjuk, hogy egyáltalán fog-e vágni. Ez a fél sor a
 * becsületes állítás — egy magyarázó bekezdés viszont pont azt a hangsúlyt adná
 * neki, amit a user KIFEJEZETTEN nem kért ("lehet nagyon hangsúlytalan helyen").
 */
export function budgetLine(state) {
  if (state?.enabled !== true) return 'budget: off (b)'
  return `budget: ${state.usd} USD (b: ki · ←/→: ${BUDGET_STEPS_USD.join('/')} — subscription alatt a hatása bizonytalan)`
}

/**
 * A `--max-budget-usd` argv-részlete — VAGY két elem, VAGY üres tömb.
 *
 * EGY HELYEN dől el, hogy a flag kimegy-e: a v1 findings-út és az agent-út
 * KÜLÖN command-buildere kétszer hozta volna ugyanezt a döntést, és a
 * default-OFF garancia pont attól csúszhatott volna szét, hogy az egyiket
 * javítjuk, a másikat nem.
 *
 * A GUARD FAIL-CLOSED a flag ELHAGYÁSA felé: nem-szám, nem-véges, nem-pozitív
 * bemenetre NINCS flag. A `String(undefined)` = "undefined" a claude oldalán
 * parse-hiba, a `0` pedig azonnali vágás — a hiányzó flag mindkettőnél jobb.
 */
export function budgetArgs(maxBudgetUsd) {
  const n = Number(maxBudgetUsd)
  if (maxBudgetUsd === undefined || maxBudgetUsd === null || !Number.isFinite(n) || n <= 0) return []
  return ['--max-budget-usd', String(n)]
}

// --- A REVIEW-AGENT MODELLJE: MINDIG EXPLICIT, DEFAULT OPUS -----------------
//
// A MÉRT LELET (a user élő tesztje, #904 saját futtatás): a `claude -p` hívásunk
// NEM adott `--model`-t, tehát a user MENTETT DEFAULTJÁT örökölte — nála Fable 5,
// a legdrágább tier —, és EGYETLEN review kimerítette a session-keretét. A flag
// elhagyása tehát nem semleges: néma költség-eszkaláció annál, akinek a
// defaultja drága. EZÉRT a `--model` az argv-ben KÖTELEZŐ (lásd a két
// command-builder végét), és a default a user javaslata szerint az opus.
//
// A VÁLASZTÉK három elem, LÁTHATÓ listaként (a TUI-váltó ezt járja be körbe):
// az opus a kiegyensúlyozott default, a sonnet az olcsó/gyors út, a fable a
// legerősebb — de a sora KIMONDJA a következményt (a session-keretet gyorsan
// meríti), mert a user pontosan ebbe futott bele mérés nélkül.
export const AI_REVIEW_DEFAULT_MODEL = 'opus'

export const AI_REVIEW_MODELS = [
  // Az opus sorában SZÁNDÉKOSAN nincs "default" szó: a user pont a néma
  // default-öröklésen égett meg, a szó maga is azt sugallná, hogy "valami
  // máshol eldőlt". A konkrét név + a jelleg a becsületes alak.
  { id: 'opus', label: 'opus — ajánlott (alapos review, normál keret-fogyasztás)' },
  { id: 'sonnet', label: 'sonnet — olcsóbb, gyors' },
  { id: 'fable', label: 'fable — a legerősebb, de a session-keretet gyorsan meríti' },
]

/**
 * A modell-választó KEZDŐÁLLAPOTA: `{ id, fromEnv }`.
 *
 * Az env (`TUIPR_AI_REVIEW_MODEL`) csak KEZDŐÉRTÉKET ad — a TUI-váltás
 * futásonként felülírja (ugyanaz a minta, mint a budget-env). Az env-értéket
 * NEM szűrjük a saját listánkra: a `--model` a teljes modellnevet is elfogadja
 * (`claude --help`: "or a model's full name"), és a user fixálási szándéka
 * erősebb, mint a mi választékunk. Üres/whitespace env NEM választás — a
 * default (opus) megy.
 */
export function aiReviewModelState({ env } = {}) {
  const v = typeof env === 'string' ? env.trim() : ''
  if (v !== '') return { id: v, fromEnv: true }
  return { id: AI_REVIEW_DEFAULT_MODEL, fromEnv: false }
}

/**
 * A modell-váltó (az `m` billentyű a megerősítő panelen): KÖRBEJÁR a listán.
 *
 * LISTA-IDEGEN (env-ből fixált teljes nevű) modellről az ELSŐ lépés a lista
 * elejére (a defaultra) visz: a léptetés így determinisztikus, és a user nem
 * ragad be egy olyan névbe, amit a váltó nem ismer. A visszaút az env-értékhez
 * szándékosan nincs — aki env-vel fixált, az a váltót nem nyomkodja; aki
 * nyomkodja, az a látható választékból akar választani.
 */
export function modelStep(state, delta = +1) {
  const i = AI_REVIEW_MODELS.findIndex((m) => m.id === state?.id)
  if (i < 0) return { id: AI_REVIEW_MODELS[0].id, fromEnv: false }
  return { id: AI_REVIEW_MODELS[stepIndex(i, AI_REVIEW_MODELS.length, delta)].id, fromEnv: false }
}

/**
 * A modell-sor SZÖVEGE a megerősítő panelen — mindig a KONKRÉT modellnév.
 *
 * A régi "Modell: claude (default)" alak TILOS: pont azt fedte el, hogy a
 * "default" a user gépén BÁRMI lehet (nála a legdrágább tier volt). A fable
 * sora a keret-figyelmeztetést is hordozza; az env-ből jött lista-idegen név
 * a saját alakjában látszik.
 */
export function modelLine(state) {
  const id = state?.id ?? AI_REVIEW_DEFAULT_MODEL
  const known = AI_REVIEW_MODELS.find((m) => m.id === id)
  const label = known ? known.label : `${id} (env-ből fixálva)`
  return `modell: ${label} (m: váltás — ${AI_REVIEW_MODELS.map((m) => m.id).join('/')})`
}

/** A `--model` argv-részlete — MINDIG két elem (a default-öröklés tilos). */
export function modelArgs(model) {
  const id = typeof model === 'string' && model.trim() !== '' ? model.trim() : AI_REVIEW_DEFAULT_MODEL
  return ['--model', id]
}


// --- Review-út választás ---------------------------------------------------
//
// AZ ÚJ MODELL: a findingokat MAGA az AI-review agent írja be a hunk sessionbe
// (a hunk-review skill `comment apply` batch-útján), NEM a TUI. A TUI csak
// INDÍTJA a `claude -p`-t és megvárja. Ezért a "review-út" = melyik slash-command
// fut a `claude -p` alatt — és ez a választás LÁTHATÓ, nem beégetett.
//
// KIZÁRT UTAK, és MIÉRT (ez a lista maga a döntés dokumentációja):
//   - builtin `/review`: EGY-agentes one-shot, tehát se fan-out, se verify — a
//     6-sweepes agent-review-hoz képest nagyságrenddel kevesebbet talál;
//   - `/code-review ultra`: CLOUD-ban fut ($5-25/run), és a binary TILTJA az
//     agent-indítást — a TUI-ból nem is futtatható.

export const REVIEW_PATHS = [
  {
    id: 'agent-review',
    default: true,
    label: 'agent-review (6 skill-delegált sweep, bit-azonos a CI-vel)',
    command: '/agent-review',
    note: 'A CI-vel BIT-AZONOS út: ugyanaz a 6 skill-delegált sweep, ugyanaz a JSON-séma. '
      + 'Amit itt lát, azt fogja a CI is jelezni.',
  },
  {
    id: 'code-review',
    default: false,
    label: '/code-review high (multi-agentes fan-out + verify, normál usage)',
    command: '/code-review high',
    note: 'Modern multi-agentes út (fan-out + verify), a normál usage-ből megy. NEM a CI szabályai '
      + 'szerint reviewol, tehát a CI ettől eltérő findingokat adhat. Az `xhigh` mélyebb, drágább.',
  },
]

/**
 * A felajánlott review-utak. A DEFAULT az `agent-review`, mert az a CI-vel
 * bit-azonos: a lokális review így nem mond mást, mint amit a gate mondani fog.
 */
export function reviewPathOptions() {
  return REVIEW_PATHS.map((p) => ({ ...p }))
}

// A költség-figyelmeztetés küszöbei. LÁTHATÓ konstansok: a user döntése szerint
// >30 fájl VAGY >2000 diff-sor fölött nyomatékos figyelmeztetés kell, mert ott az
// agent-fanout token-költése már érdemi.
const REVIEW_WARN_FILES = 30
const REVIEW_WARN_CHURN = 2000

/**
 * Költség-figyelmeztetés a review-út választó ekrányra, vagy null.
 *
 * A MÉRT szám benne van a szövegben: egy általános "ez nagy PR" nem
 * auditálható, és a user nem tudná, mennyire nagy.
 */
export function reviewPathWarning({ fileCount = 0, churn = 0 } = {}) {
  const byFiles = fileCount > REVIEW_WARN_FILES
  const byChurn = churn > REVIEW_WARN_CHURN
  if (!byFiles && !byChurn) return null
  const reasons = []
  if (byFiles) reasons.push(`${fileCount} fájl (> ${REVIEW_WARN_FILES})`)
  if (byChurn) reasons.push(`${churn} diff-sor (> ${REVIEW_WARN_CHURN})`)
  // A "saját tokenjeidet fogyasztja" záró mondat SZÁNDÉKOSAN nincs itt (user
  // kifogása: felesleges). A MÉRT számok maradnak — azok auditálhatók.
  return (
    `FIGYELEM — KÖLTSÉG: ${reasons.join(' és ')}. A review-utak agent-fanoutosak, tehát a `
    + 'token-költés ezen a méreten már érdemi, és a findingok átolvasása is hosszú lesz.'
  )
}

/**
 * Elfogadható-e a megerősítés (a 'y') EZEN a keypressen? — TYPEAHEAD-KAPU.
 *
 * A MECHANIZMUS INDOKLÁSA ITT, KÓDKOMMENTBEN ÉL, nem a UI-ban: a kapu a normál
 * használatban LÁTHATATLAN (a szándékos gombnyomás szem-kéz köre lassabb a
 * dwellnél), tehát a megerősítő ekrányon a magyarázata csak zaj volt — a user
 * kifogása pontosan ez volt. Aki belefut, egy rövid "túl korai" sort kap.
 *
 * MIÉRT KELL: az `askAiReview` BLOKKOLÓ szinkron I/O-t végez (`gh pr view
 * --json files`, éles PR-on ~1 másodperc), majd megnyitja a megerősítő ekrányt.
 * Az Ink a stdin-t raw módban tartja, és nézet-váltáskor NEM dobja el a
 * bemeneti puffert. A gh-hívás KÖZBEN leütött 'y' tehát a confirm ekrán
 * mountolása UTÁN kerül feldolgozásra, egyenest a megerősítés-ágba — a user
 * ELOLVASTA volna az ekrányt, de nem kapott rá esélyt, és mégis elindult a
 * token-költő `claude -p`. Éles PR-on (#911, 100 fájl) ez valódi költés.
 *
 * MIÉRT NEM ELÉG A `busy` GUARD: a `setBusy(true)` és a `setBusy(false)`
 * UGYANABBAN a szinkron blokkban fut (try/finally), tehát a React sosem
 * RENDEREL `busy === true` állapotot. A useInput handler egy pufferelt
 * keypressnél mindig `busy === false`-ot lát — a guard strukturálisan
 * képtelen elkapni ezt az esetet.
 *
 * A KAPU ASZIMMETRIÁJA SZÁNDÉKOS: csak a megerősítést késleltetjük, a
 * megszakítást SOHA. A dwell a KÖLTÉST védi; a megszakítás ingyen van, tehát
 * egy pufferelt keypress is elvégezheti — az a biztonságos irány (fail-closed).
 */
export function confirmAccepts(state, input) {
  if (input !== 'y') return false
  const armedAt = state?.armedAt
  // Ha nincs arm-időpont, a kapu ZÁRVA van: a hiányzó mérésből nem következtetünk
  // engedélyre (ugyanaz a fail-closed elv, mint a merge/AI-blokkolóknál).
  if (typeof armedAt !== 'number' || !Number.isFinite(armedAt)) return false
  const now = typeof state?.now === 'number' ? state.now : Date.now()
  return now - armedAt >= CONFIRM_DWELL_MS
}

/**
 * A megerősítő ekrán tartalma — a PR MÉRETE, a scope, a kizártak és a PLAFON.
 *
 * Miért a plafon és nem a becslés: a becslés (token × ár) az agent-fanout miatt
 * nagyságrendet téveszthet, a `--max-budget-usd` viszont hard korlát. Ha a
 * fejlesztő a plafont látja, a legrosszabb esetet látja — az a tájékozott döntés.
 */
// A `model` PARAMÉTER KIVEZETVE (5b): a modell nem a summary statikus sora,
// hanem a megerősítés VÁLTHATÓ mezője (modelLine) — két megjelenítő ugyanarra
// a tényre pontosan az az elcsúszás-osztály, amit a budget-sornál már kizártunk.
export function aiReviewSummary({ pr, files, maxBudgetUsd }) {
  const { scope, excluded } = aiReviewScope(files)
  const additions = files.reduce((a, f) => a + (f.additions ?? 0), 0)
  const deletions = files.reduce((a, f) => a + (f.deletions ?? 0), 0)
  const churn = additions + deletions
  const large = files.length >= AI_LARGE_FILES || churn >= AI_LARGE_CHURN
  const exAdd = excluded.reduce((a, f) => a + f.additions + f.deletions, 0)

  const lines = []
  lines.push(`#${pr} — ${files.length} fájl, +${additions} / -${deletions} sor`)
  if (large) {
    lines.push(
      `FIGYELEM: ez NAGY PR (${files.length} fájl, ${churn} sor churn). Az AI-review `
      + 'ezen sok tokent fogyaszt, és a findingok átolvasása is hosszú lesz.',
    )
  }
  lines.push(`Review-scope: ${scope.length} fájl.`)
  if (excluded.length > 0) {
    // A kizárt fájlok NEVE látszik (legfeljebb 5 + maradék), mert a "13 fájl
    // kihagyva" nem auditálható állítás.
    const shown = excluded.slice(0, 5).map((e) => `${e.path} (${e.reason})`)
    const rest = excluded.length - shown.length
    lines.push(
      `Kihagyva ${excluded.length} generált/lock fájl (${exAdd} sor churn): `
      + shown.join(', ') + (rest > 0 ? `, +${rest} további` : ''),
    )
    lines.push('Amit az AI kihagy, azt NEKED kell átnézned, ha számít.')
  }
  // AZ ELŐFELTÉTEL KIMONDVA: a findingok a HUNK SESSIONBE kerülnek, tehát élő
  // session kell erre a repóra. A user-jelentett #904-es hibában ez pont azért
  // vált érthetetlenné, mert a UI SEHOL nem mondta ki az előfeltételt — csak a
  // bukás után jött egy nyers hunk-stderr. A szöveg a KÖZÖS HUNK_SESSION_HINT,
  // hogy a hiba-üzenettel ne csúszhasson szét.
  //
  // A PÁRHUZAMOS MODELL KIMONDVA a megerősítés ELŐTT: a user tudja, hogy (a) a
  // diff MEG FOG NYÍLNI (a terminált átveszi a hunk), és (b) a review a
  // HÁTTÉRBEN fut, tehát a findingok a szeme előtt jelennek meg. Enélkül a
  // megerősítés utáni terminál-átvétel MAGYARÁZAT NÉLKÜL csapódna be — és a
  // #904-es bejelentés magja pont az volt, hogy a UI nem mondta ki, mi történik.
  //
  // A `HUNK_SESSION_HINT` ELMARADT INNEN: a TUI mostantól MAGA nyitja meg a
  // sessiont, tehát a "nyiss egyet" felszólítás itt már félrevezető lenne (a
  // usernek nincs mit tennie). A hint a HIBA-úton marad, ahol tényleg kell.
  lines.push('')
  lines.push(
    'A review a HÁTTÉRBEN fut, a progresszt EZ A panel mutatja. A findingok a hunk '
    + 'sessionbe kerülnek (élő session nélkül a review válaszából töltjük be), és a '
    + 'hunk akkor nyílik meg, amikor VAN MIT látni.',
  )
  // A PLAFON-SOR CSAK AKKOR VAN, HA VAN PLAFON. Defaultban nincs (lásd a
  // budget-fejezetet), és egy "Költés-plafon: --max-budget-usd undefined" sor
  // rosszabb, mint a hallgatás: azt állítaná, hogy van védelem. A kikapcsolt
  // állapotot a UI hangsúlytalan budget-sora mondja ki ("budget: off"), nem ez.
  //
  // AMI SZÁNDÉKOSAN NINCS ITT: a "ez a TE saját tokenjeidet fogyasztja" mondat. A
  // user kifogása szerint felesleges — a fejlesztő tudja, hogy a lokális
  // credentialját használja. A felelősség-modell leírása a modul fejében és a
  // docs-ban él, nem a UI-ban.
  const hasBudget = Number.isFinite(Number(maxBudgetUsd)) && Number(maxBudgetUsd) > 0
  if (hasBudget) {
    lines.push(`Költés-plafon: --max-budget-usd ${maxBudgetUsd} (a claude --help szerint API-költésre vonatkozik)`)
  }
  // A plafon GÉPILEG is kimegy: a megerősítés y-ága EZT adja tovább a claude-nak,
  // hogy a user pontosan azt a plafont kapja, amit az ekrányon LÁTOTT. Ha a
  // futtató máshonnan számolná újra, a megjelenített és az élő plafon szétcsúszhat.
  return {
    fileCount: files.length, additions, deletions, churn, large, scope, excluded,
    maxBudgetUsd: hasBudget ? maxBudgetUsd : undefined,
    lines,
  }
}
