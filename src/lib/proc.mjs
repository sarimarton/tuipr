// tuipr — PROC: process-helper alapréteg.
//
// ALAPRÉTEG: csak node-builtinokat importál, NULLA projekt-modult. A ciklus-
// tilalom indoklása a bin/tui-core.mjs fejlécében áll.
//
// Ami itt lakik: a spawn-HIBA (nem az exit-kód!) diagnózisa EGY helyen (az
// ENOENT-csapda), a repo-gyökér memoizált mérése, a spawnSync-ALAKÚ aszinkron
// gyerek, és a shell-belépési pont útkonstansai.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const SCRIPT_DIR = new URL('..', import.meta.url).pathname
const NEXT_SH = `${SCRIPT_DIR}tuipr.sh`

/**
 * A CORE-GYÖKÉR: a MODUL saját helyéről (`import.meta.url`) származtatva.
 *
 * MIÉRT NEM a process cwd-jéből (ez a lényeg, nem részlet): a TUI-t a user egy
 * MÁSIK repo checkoutjából futtatja (a mobile/web packages alól, ahol a core
 * szimlinkelt vagy vendorolt npm-dependency). A cwd-ben mért SHA tehát a
 * FOGYASZTÓ repójáét mondaná meg — pontosan a rossz választ arra az egyetlen
 * kérdésre, amiért ez a szegmens létezik ("melyik CORE-kód fut?"). A
 * `fetchRepoRoot` szándékosan MÁS fogalom (az a hunk-session repo-gyökere, ami
 * a cwd-é és annak is kell lennie) — a kettő nem cserélhető össze.
 */
const CORE_ROOT = path.resolve(SCRIPT_DIR, '..')

export { CORE_ROOT, NEXT_SH, SCRIPT_DIR }

/**
 * A SPAWN-HIBA (nem az exit-kód!) érdemi szövege — EGY helyen, minden
 * spawnSync-es hívási úthoz.
 *
 * MÉRT CSAPDA, amiért ez létezik (node v24, spawnSync, PATH=/nonexistent):
 *   res.status === null · res.stderr === undefined · res.error.code === 'ENOENT'
 * Tehát a CSAK `res.status !== 0`-t vizsgáló ág "exit null" / "undefined"
 * szöveget ad a usernek, és a valódi okról (a bináris nincs telepítve / nincs a
 * PATH-on) EGY SZÓT SEM. Ez a projekt már megfogott hibaosztálya: a
 * `hunkComments` pont ezért kapott külön ENOENT-ágat ("NEM session-hiba: a
 * bináris maga hiányzik") — ez a helper ugyanazt a diagnózist adja a többi
 * útnak is, hogy ne csak egy helyen legyen igaz.
 *
 * `null`-t ad, ha NEM spawn-hiba történt (akkor a hívó az exit-kódos ágon megy).
 */
export function spawnFailure(res, tool) {
  if (!res?.error) return null
  if (res.error.code === 'ENOENT') {
    return `a(z) \`${tool}\` nem található (ENOENT): nincs telepítve, vagy nincs a PATH-on. `
      + 'Ez NEM a művelet hibája — a bináris maga hiányzik.'
  }
  return `a(z) \`${tool}\` nem indítható (${res.error.code ?? 'spawn hiba'}): ${res.error.message}`
}

/**
 * A REPO GYÖKERE — EGY mérés, EGY helyen.
 *
 * MIÉRT KELL KÖZPONTOSÍTVA: a gyökér HÁROM úton kellett (a `d` cwd-je, a
 * `hunkComments --repo`-ja, az AI-review `--repo`-ja), és három MÁSOLT
 * `git rev-parse --show-toplevel` hívás állt a kódban. A `d` útján viszont
 * EGYIK SEM volt ott — a hunk a TUI munkakönyvtárában indult. Ez a duplikáció
 * szülte a user-jelentett hibát: a "gyökér" fogalma három helyen élt, és az
 * egyik helyen NEM élt.
 *
 * A HIBA DOBÓDIK, nem nyeljük el: gyökér nélkül a session-affinitás nem
 * értelmezhető, egy néma üres string pedig `--repo ""`-t adna a hunknak.
 *
 * MEMOIZÁLT (wf24/4). A TUI munkakönyvtára a session ÉLETÉBEN NEM változik (a
 * process cwd-je fix, a hunk-suspend sem mozdítja), tehát az ismételt
 * `git rev-parse` tiszta latencia — és pontosan ez ült a kész review `r`-jének
 * ELSŐ blokkoló hívásaként, a UI-frissítés előtt. Csak a SIKERES mérés
 * cache-elődik: a hibát minden hívás újra megméri (egy tranziens git-hiba nem
 * ragadhat be a session hátralévő részére).
 */
let repoRootCache = null

/** A memoizált gyökér ELDOBÁSA — teszt-horgony (a fixtúrák közti szivárgás ellen). */
export function resetRepoRootCache() {
  repoRootCache = null
}

export function fetchRepoRoot() {
  if (repoRootCache !== null) return repoRootCache
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  const spawnErr = spawnFailure(res, 'git')
  if (spawnErr) throw new Error(`a repo gyökere nem határozható meg: ${spawnErr}`)
  if (res.status !== 0) {
    throw new Error(
      `a repo gyökere nem határozható meg (git rev-parse, exit ${res.status}): `
      + `${(res.stderr || '').trim() || '(nincs stderr)'}`,
    )
  }
  const root = (res.stdout || '').trim()
  if (root === '') {
    throw new Error(
      'a repo gyökere ÜRESEN jött vissza a git-től. A hunk-session repo-szintű, '
      + 'tehát gyökér nélkül nem azonosítható — a `--repo ""` hívás némán MÁS '
      + 'sessiont (vagy semmit) találna.',
    )
  }
  repoRootCache = root
  return root
}

/**
 * spawnSync-ALAKÚ eredmény ({ status, stdout, stderr, error }) ASZINKRON
 * gyerekből — a szinkron fetch-ek parse-logikája VÁLTOZTATÁS NÉLKÜL ráhúzható.
 *
 * MIÉRT KELL (a user 5. futásának 2. lelete): a hunk-nézet zárása utáni puha
 * reload spawnSync-ként futott a runExclusive alatt, és a MÉRT post-q szakasz
 * (queue --json ~1.9 s + rev-parse + gh pr list ~0.55 s) alatt az app süket
 * volt ("pár másodperces dolgozom"). Az aszinkron gyerek az event loopot
 * szabadon hagyja. SOSEM reject-el: a hibát a spawnSync-alak hordozza (error /
 * nem-nulla status), a döntés a parse-oló hívóé — pontosan mint a szinkron úton.
 */
export function spawnCollect(cmd, args) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', error })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => { stderr += d })
    // Az 'error' után 'close' is jöhet — a Promise az ELSŐ resolve-ot tartja,
    // tehát a kettős jelzés nem ártalmas.
    child.on('error', (error) => resolve({ status: null, stdout, stderr, error }))
    child.on('close', (code) => resolve({ status: code, stdout, stderr }))
  })
}

// --- A TRUNK NEVE: melyik branch ellen mér a tooling ------------------------
//
// (dev-trunk átállás) A fogyasztó repók trunkja nem szükségképpen `main` többé:
// az app repók a dev-trunk modellre állnak át, ahol a PR-ok célpontja és a
// landability-mérés alapja a `dev`. A név EGY FORRÁSBÓL oldódik fel, a bash
// oldallal (bin/tuipr.sh `MAIN=`) BÁJTRA azonos rangsorban:
//   1) `NEXT_WORK_MAIN` env — kézi felülírás (a bash oldal ezt már ismerte);
//   2) a FOGYASZTÓ repo package.json-jának `tuipr.trunk` mezője — ez a
//      repóba COMMITOLT deklaráció, tehát az átállás nem függ senki lokál
//      env-jétől;
//   3) `'main'` — a mai világ, változatlan viselkedés.
//
// FAIL-SOFT MINDEN ÁGON, és ez itt HELYES (nem lazaság): a hiányzó/olvashatatlan
// package.json pontosan a mai (átállás előtti) repókat írja le — ott a 'main' a
// helyes válasz. PR-KONTEXTUSBAN TOVÁBBRA IS a `baseRefName` az igazság
// (fetchPrRefs) — ez a resolver a REPO-SZINTŰ kérdésekhez való (cache-horgony,
// staleness-szignatúra), ahol nincs PR, ami megmondaná.
let trunkBranchCache = null

/** A memoizált trunk-név ELDOBÁSA — teszt-horgony (fixtúrák közti szivárgás ellen). */
export function resetTrunkBranchCache() {
  trunkBranchCache = null
}

/**
 * A trunk branch neve a FOGYASZTÓ repóban. Sosem dob, sosem üres.
 *
 * @param {object} [opts]
 * @param {string} [opts.root] a repo gyökere — CSAK teszt-injekcióra; élesben a
 *   memoizált `fetchRepoRoot()` a forrás. Injektált gyökérrel NINCS memoizálás
 *   (a cache a valódi repo válaszát őrzi, nem a fixtúráét).
 */
export function trunkBranch({ root } = {}) {
  const injected = root !== undefined
  if (!injected && trunkBranchCache !== null) return trunkBranchCache
  const resolve = () => {
    const env = (process.env.NEXT_WORK_MAIN || '').trim()
    if (env !== '') return env
    try {
      const repoRoot = injected ? root : fetchRepoRoot()
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
      const declared = typeof pkg?.tuipr?.trunk === 'string' ? pkg.tuipr.trunk.trim() : ''
      if (declared !== '') return declared
    } catch { /* lásd a fail-soft indoklást a fejlécben */ }
    return 'main'
  }
  const value = resolve()
  if (!injected) trunkBranchCache = value
  return value
}

// --- A trunk (origin/<main|dev>) SHA: git-plumbing a PROCESS-rétegen --------
//
// MIÉRT ITT: ez a mérés-cache invalidálási horgonyának másik fele, tehát
// FOGYASZTÓJA a poll (fetchStalenessProbe) ÉS a queue-fetch réteg is. Ha a
// queue-fetch modulban lakna, a poll FELFELÉ importálna — pont az a ciklus-
// veszély, amit a rétegrend kizár. Függősége csak spawnSync/spawnCollect,
// tehát a proc-réteg a természetes helye.
/**
 * A trunk (`origin/<trunkBranch()>`) SHA — a mérés-cache INVALIDÁLÁSI
 * HORGONYÁNAK másik fele. A név történelmi: a "main" itt a TRUNK szerepét
 * jelöli, aminek a neve a dev-trunk átállás után repónként `dev` is lehet
 * (lásd a trunkBranch fejlécét) — az átnevezés a 175 nevet címző fogyasztói
 * szerződés (barrel/entry/tesztek) fölösleges churnje lenne.
 *
 * EGYSZER fut REBETÖLTÉSENKÉNT, nem soronként: a user 4. pontja kimondja, hogy a
 * jelző nem lassíthatja a listát. Egy `git rev-parse` lokális, de PR-onként
 * meghívva 20 sornál 20 processz lenne MINDEN renderben.
 *
 * MIÉRT NEM DOB: a horgony fél része hiányozhat (nincs remote-ref, friss klón), és
 * ez NEM ok a TUI megbukására — a `null` fail-closed módon `unknown` horgonyt ad
 * (lásd cacheAnchor), tehát semmi nem lesz "friss", csak újramérünk. A NÉMA ELNYELÉS
 * viszont itt sem opció más irányban: egy HAMIS SHA (pl. üres string
 * "sikerként" elfogadva) két KÜLÖNBÖZŐ trunk-állapotot azonosnak mutatna, és a
 * cache elavult diagnózist adna késznek. Ezért az exit-statust ÉS az ENOENT-et
 * is ellenőrizzük, és csak a nem-üres kimenetet fogadjuk el.
 */
export function fetchMainSha(remote = 'origin', branch = trunkBranch()) {
  return parseMainShaResult(spawnSync('git', ['rev-parse', `${remote}/${branch}`], { encoding: 'utf8' }))
}

/** A main-SHA EGYETLEN parse-olója — a szinkron és az aszinkron út közös magja. */
function parseMainShaResult(res) {
  // ENOENT (nincs git) és bármely más spawn-hiba: nincs SHA. A `spawnFailure`
  // ugyanazt a diagnózist adja, mint a többi úton — csak itt nem dobjuk, hanem
  // null-lal jelezzük a "nem tudható" horgonyt.
  if (res.error) return null
  if (res.status !== 0) return null
  const sha = (res.stdout || '').trim()
  return sha === '' ? null : sha
}

/** A fetchMainSha ASZINKRON párja — ugyanaz a null-kontraktus, szabad event looppal. */
export async function fetchMainShaAsync(remote = 'origin', branch = trunkBranch()) {
  return parseMainShaResult(await spawnCollect('git', ['rev-parse', `${remote}/${branch}`]))
}

// --- A BETÖLTÖTT CORE AZONOSÍTÓJA (1a) -------------------------------------
//
// A USER MÉRT KÖLTSÉGE, ami miatt ez létezik: "MA TÖBBSZÖR nem tudta
// megállapítani, hogy friss kódot futtat-e, és ez sok idejébe került". A TUI
// négy különböző úton indulhat (élő checkout, git worktree, szimlinkelt
// workspace-package, vendorolt npm-dependency), és a képernyőn eddig SEMMI nem
// mondta meg, MELYIKET futja. A fejléc-időbélyeg csak azt mondja, mikor
// töltöttük a QUEUE-t — nem azt, hogy melyik KÓD tölti.
//
// HÁROM FORRÁS, RANGSORBAN. A rangsor nem önkényes: a PONTOSABB azonosító
// nyer, mert a kérdés az, hogy "ez-e a most pusholt commit".
//   1) `git -C <coreRoot> rev-parse --short HEAD` — a fejlesztői út. Ez az
//      EGYETLEN, ami commit-pontos.
//   2) a `.source-sha` első 7 karaktere — a vendorolt út, ha a szinkronizáló
//      lerakta a forrás-commitot. Szintén commit-pontos, csak nem élő.
//   3) a `package.json` verziója — az utolsó mentsvár. NEM commit-pontos (egy
//      verzió sok commitot fed), de a semminél informatívabb.
//
// NÉGYSZERESEN FAIL-SOFT, és ez SZERZŐDÉS, nem lazaság: ez egy KOZMETIKAI
// fejléc-szegmens. Egy dobás (nem-git könyvtár, olvashatatlan fájl, romlott
// JSON) a TELJES TUI-t megölné — az pedig végtelenül drágább, mint a hiányzó
// SHA. Ezért minden ág `null`-ra fut, és a hívó ELHAGYJA a szegmenst.
//
// MIÉRT NEM ÍRUNK "unknown"-t (a task explicit kikötése): a "core unknown" azt
// a képet adja, hogy a program tudni AKARTA és elhasalt — a user pedig épp
// azért néz a fejlécre, hogy BIZTOS információt kapjon. A hiányzó szegmens
// néma, a hazug szegmens költséges.

/** A rövid SHA hossza — a git `--short` default-jával egyezően. */
const SHORT_SHA_LEN = 7

let coreShaCache
let coreShaCached = false

/** A memoizált core-SHA ELDOBÁSA — teszt-horgony (a fixtúrák közti szivárgás ellen). */
export function resetCoreShaCache() {
  coreShaCache = undefined
  coreShaCached = false
}

/** A git-út: rövid HEAD-SHA a core gyökeréből. `null`, ha nem git (vagy nincs git). */
function coreShaFromGit(coreRoot) {
  // A `--short` a git default-hosszát adja (7+, ütközésnél több) — nem mi
  // csonkoljuk, mert a git tudja, mennyi kell az EGYEDISÉGHEZ ebben a repóban.
  const res = spawnSync('git', ['-C', coreRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
  // ENOENT (nincs git) és minden más spawn-hiba: nincs SHA ezen az úton.
  if (res.error) return null
  if (res.status !== 0) return null
  const sha = (res.stdout || '').trim()
  return sha === '' ? null : sha
}

/** A vendorolt út: a `.source-sha` első 7 karaktere. `null`, ha nincs/olvashatatlan. */
function coreShaFromSourceFile(coreRoot) {
  try {
    const raw = fs.readFileSync(path.join(coreRoot, '.source-sha'), 'utf8').trim()
    if (raw === '') return null
    const head = raw.slice(0, SHORT_SHA_LEN)
    return head === '' ? null : head
  } catch {
    // NINCS-FÁJL és OLVASHATATLAN-FÁJL ugyanaz a válasz: nincs SHA ezen az úton.
    // A kettő szétválasztása itt semmit nem adna (a user nem tud mit tenni vele),
    // és egy dobás a fejléc miatt vinné el a TUI-t.
    return null
  }
}

/** A vendorolt út utolsó mentsvára: a `package.json` verziója. */
function coreShaFromPackageVersion(coreRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(coreRoot, 'package.json'), 'utf8'))
    const v = pkg?.version
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
  } catch {
    // ROMLOTT JSON is ide fut: fail-soft (lásd a szekció fejét).
    return null
  }
}

/**
 * A BETÖLTÖTT CORE RÖVID AZONOSÍTÓJA a fejléchez, vagy `null`.
 *
 * MEMOIZÁLT, és ez LOAD-BEARING, nem optimalizálás: a `headerLine` MINDEN
 * renderben újraszámolódik (az Ink minden keyfelütésre, minden poll-tickre,
 * minden spinner-frame-re újrarendereli a fát). Egy itt lapuló `spawnSync`
 * tehát FRAME-enként egy processzt indítana — ugyanaz a hibaosztály, amiért a
 * `fetchRepoRoot` memoizálva van, csak sokkal sűrűbben ütve. A `null` EREDMÉNY
 * IS CACHE-ELŐDIK (külön `coreShaCached` flag): a nem-git úton különben minden
 * frame újra megpróbálná a spawnt, és pont a legrosszabb (leglassabb) ágon.
 *
 * A `coreRoot` PARAMÉTER csak teszt-horgony; élesben a modul saját helye
 * (CORE_ROOT) az egyetlen helyes válasz — lásd a CORE_ROOT fejét.
 */
export function fetchCoreSha({ coreRoot = CORE_ROOT } = {}) {
  if (coreShaCached) return coreShaCache
  const sha = coreShaFromGit(coreRoot)
    ?? coreShaFromSourceFile(coreRoot)
    ?? coreShaFromPackageVersion(coreRoot)
  coreShaCache = sha
  coreShaCached = true
  return sha
}
