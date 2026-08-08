// tuipr — HUNK: a hunk-integráció EGÉSZE (a hunk 0.17.0 CLI szerződése).
//
// Ami itt lakik: az attesztációs review-body és az attribúció-parse, a
// session-próba / várakozás / reload, a comment-olvasás a MÉRT (b) sémával, a
// "nincs élő session" KÜLÖN hibaosztálya, a review-nézet megnyitása (a wf26-os
// TTY-fd minta!), a findingok visszainjektálása és a GitHub-feltöltés.
//
// MIÉRT EGY MODUL, a méret ellenére: EGY külső szerződés (a `hunk` CLI) körül
// forog minden. A flagek, a JSON-sémák és a hibaosztályok együtt mozognak, ha a
// hunk verziót vált — szétvágva a szerződés két helyen élne.
//
// RÉTEGREND: lefelé importál (proc: spawn-diagnózis). SEMMIT nem importál a
// core-ból vagy felette.
//
// A TTY-ÁTADÁS MINTÁJA (wf31/19, MÉRVE HÁROM ÉLES FAGYÁSON): a hunk-nézet SAJÁT
// PSZEUDOTERMINÁLBAN fut (`script -q /dev/null`), tehát nincs közös TTY-leíró és
// nincs közös process group a TUI-val. A korábbi minták (saját /dev/tty fd a
// gyereknek — wf26; `stdin.pause()` a spawn előtt — wf31/18) NEM voltak elegek: a
// kernel a PROCESS GROUP alapján dönt a TTY-olvasásról, nem az fd alapján. Az
// indoklás a `reviewCommand` és a `reviewSpawnOptions` fejénél áll.
import { CORE_ROOT, spawnFailure } from './proc.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import tty from 'node:tty'

// --- A findings-review body-ja --------------------------------------------

/**
 * Az attesztációs/attribúciós body EGY GitHub review-hoz (event=COMMENT).
 *
 * A szándék: a review lokálisan készült, és a findingokat a futtató USER
 * verifikálta. A modell/eszköz-metaadat gépileg kinyerhető (parseAttribution) —
 * összecsukható <details> blokkban, hogy a PR olvasóját ne zavarja.
 *
 * KÉT ÚT, EGY BODY. A `tool` mező hordozza a valódi provenance-ot:
 *   - `hunk` (default): a fejlesztő maga írta a findingokat a hunk sessionben,
 *   - `claude-p`: a findingokat a `claude -p` AI-review generálta, a fejlesztő
 *     pedig a hunk sessionben szűrte/szerkesztette őket.
 * A PRÓZA is követi a toolt: korábban fixen "hunk-kal készült" állt benne, ami
 * AI-review-nál HAZUGSÁG lenne — és épp a provenance az, amiért ez a blokk van.
 *
 * Az AI-úton a metaadat MÉRT, nem deklarált: a `model` a claude-burkoló
 * `modelUsage` kulcsából, a `costUsd` a `total_cost_usd`-ből jön. A `findings`
 * MINDIG a MEGTARTOTT (feltöltött) darabszám; az `aiGenerated` a nyers
 * generált szám — a kettő különbsége maga a human-gate mérőszáma.
 */
/**
 * A HUNK BINÁRIS ÚTJA — A CORE SAJÁT DEPENDENCY-JÉBŐL, nem a gépről.
 *
 * MIÉRT: a `hunkdiff` a tuipr `dependencies`-e, tehát a toolt a TUI HOZZA
 * MAGÁVAL — nem a fejlesztő gépén kell provisionálni (se brew, se npm -g). Ez a
 * függvény ezt a kötést valósítja meg: a bundled binárist adja vissza, ha ott van.
 *
 * A `CORE_ROOT`-ból származtatjuk, NEM a cwd-ből — ugyanaz az indoklás, mint a
 * `CORE_ROOT` docstringjében: a TUI-t a user egy MÁSIK repo checkoutjából
 * futtatja (mobile/web), ahol a core szimlinkelt vagy npm-dependency. A cwd
 * alatti `node_modules/.bin` tehát a FOGYASZTÓ package-éé lenne, ahol a hunkdiff
 * nem szerepel — a `CORE_ROOT` alatti viszont mindig a MIÉNK.
 *
 * A PATH-FALLBACK SZÁNDÉKOS, és nem hibaelnyelés: aki a hunkot magának telepíti
 * (brew, npm -g, bárhogy), annak a puszta `'hunk'` név a PATH-on feloldódik — a
 * régi viselkedés bájtra megmarad. A `spawnFailure` ENOENT-diagnózisa pedig
 * változatlanul hangosan szól, ha EGYIK sincs meg.
 *
 * MEMOIZÁLT: a TUI egyetlen futásán belül a fájlrendszer-állapot nem változik, a
 * `d`/`r` út viszont sokszor hívja. A cache-ürítő a teszteké.
 */
let hunkBinCache
export function resetHunkBinCache() {
  hunkBinCache = undefined
}
export function hunkBin() {
  if (hunkBinCache !== undefined) return hunkBinCache
  const local = path.join(CORE_ROOT, 'node_modules', '.bin', 'hunk')
  try {
    // X_OK: a puszta létezés nem elég, futtathatónak is kell lennie (a
    // `claudePath` ugyanezt a mércét használja).
    accessSync(local, constants.X_OK)
    hunkBinCache = local
  } catch {
    // Nincs bundled példány (pl. `pnpm install --prod=false` nélküli telepítés,
    // vagy sérült node_modules) — a PATH-ra esünk vissza.
    hunkBinCache = 'hunk'
  }
  return hunkBinCache
}

/**
 * A bináris útja BASH-BA ÁGYAZHATÓ alakban (a `script`-es PTY-burkoláshoz).
 * Az abszolút út szóközt is tartalmazhat (pl. "Application Support" alatti
 * checkout), és ott az idézőjel nélküli beszúrás KÉT argumentumra esne szét.
 * A PATH-fallback (`'hunk'`) idézve is PATH-ból oldódik fel — bash-szemantika.
 */
export function hunkBinShell() {
  return `'${hunkBin().replaceAll("'", `'\\''`)}'`
}

export function reviewBody({ model, user, count, tool = 'hunk', aiGenerated, costUsd, sessionId, skill, aiSummary }) {
  const lead = tool === 'hunk'
    ? `Review lokálisan, \`hunk\`-kal készült — AI-asszisztált elemzés, a findingokat @${user} verifikálta.`
    : `Review lokálisan, \`claude -p\`-vel generálva — @${user} verifikálta és szűrte`
      + (aiGenerated === undefined ? '' : ` (${count}/${aiGenerated} finding megtartva)`)
      + '.'
  const meta = { tool, model, verifiedBy: user, findings: count }
  // Csak a TÉNYLEGESEN mért mezők kerülnek be — egy `null` költés vagy egy
  // kitalált 0 rosszabb, mint a mező hiánya.
  if (skill !== undefined) meta.skill = skill
  if (aiGenerated !== undefined) meta.aiGenerated = aiGenerated
  if (costUsd !== undefined) meta.costUsd = costUsd
  if (sessionId !== undefined) meta.sessionId = sessionId
  // (wf24/2) AZ AI-ÖSSZEGZŐ A BODY-BAN IS. Az agent verdictje (mit nézett át,
  // mi a fő kockázat) a PR olvasójának ugyanolyan hasznos, mint a TUI-ban — és
  // eddig SEHOL nem jelent meg. Csak akkor kerül be, ha TÉNYLEG van: egy üres
  // szekció rosszabb, mint a hiánya. A `hunk` (nem-AI) út bájtra változatlan.
  const summaryBlock = typeof aiSummary === 'string' && aiSummary.trim() !== ''
    ? ['', '**AI-összegzés:**', '', aiSummary.trim()]
    : []
  // (wf31/13) A „Ez **nem** approve: … külön gesztus." MONDAT KIVEZETVE — a user
  // kérése, szó szerint: "Ez a nem approve mondat egy idétlen szájbarágás, vedd
  // ki."
  //
  // MIÉRT NEM VESZÍTÜNK VELE SEMMIT: a review `event`-je `COMMENT`, és a GitHub
  // MAGA jelzi az állapotot a review fejlécében ("commented" — nem "approved",
  // nem "requested changes"), zöld pipa és approval-számláló nélkül. A mondat
  // tehát olyan tényt magyarázott, amit a platform UI-ja már kimond, méghozzá
  // erősebben (gépi állapot vs. prózai állítás). A PR olvasójának ráadásul nem is
  // a mi belső gesztus-tipológiánk a kérdése.
  //
  // A DARABSZÁM MARAD: az `N inline megjegyzés` valódi információ (mennyit kell
  // átolvasni), és a `comments[]` atomicitása miatt egyben ellenőrizhető tény is.
  return [
    lead,
    ...summaryBlock,
    '',
    `${count} inline megjegyzés.`,
    '',
    '<details>',
    '<summary>Eszköz- és modell-metaadat</summary>',
    '',
    '```json',
    JSON.stringify(meta, null, 2),
    '```',
    '</details>',
  ].join('\n')
}

/** A reviewBody metaadat-blokkjának visszaolvasása (gépi kinyerhetőség). */
export function parseAttribution(body) {
  const m = body.match(/```json\n([\s\S]*?)\n```/)
  if (!m) return null
  const meta = JSON.parse(m[1])
  return { tool: meta.tool, model: meta.model, user: meta.verifiedBy, findings: meta.findings }
}

// --- hunk session comments → GitHub review comments[] ----------------------

/**
 * A findingok leképezése a GitHub review `comments[]` alakjára.
 *
 * KÉT BEMENŐ POZÍCIÓ-SÉMÁT FOGAD, és ez NEM kényelmi engedmény — a kódbázisban
 * MINDKETTŐ ÉL, egymás mellett:
 *
 *   (A) `{ side: 'new'|'old', line: N }` — a HUNK-út alakja
 *       (`parseHunkAgentComments`: a `newRange`/`oldRange`-ből számolja).
 *   (B) `{ newLine: N }` / `{ oldLine: N }` — az ANSWER-út alakja
 *       (`hunk-findings.mjs`: az agent válasz-JSON-ja ezt a sémát használja, és a
 *       review-store is ÍGY perzisztálja; az `aiReviewPanelLines` is erre ágazik).
 *
 * MÉRT, ÉLES BUG (a user #904-es esete, HTTP 422): ez a függvény csak az (A)
 * sémát ismerte. A (B) alakú findingon a `c.line` `undefined` volt, tehát a
 * fájl-szintű ágra esett — DE a GitHub a `subject_type: "file"` kommentet ezen az
 * úton nem fogadta el, és a `comments[]` ATOMICITÁSA miatt az EGÉSZ review
 * elbukott. A findingoknak volt pozíciója (`newLine: 143` és `149`), csak MÁS
 * mezőnévben — a néma alak-eltérés így 422-vé fordult.
 *
 * MIÉRT ITT NORMALIZÁLUNK, ÉS NEM A HÍVÓBAN: ez a KÖZÖS fogyasztó — a hunk-út és
 * az answer-út (a cache-elt review fallbackje) is ide fut be. A hívási helyeken
 * konvertálva a következő új út ismét lemaradna, és ugyanezt a 422-t adná.
 *
 * A koordináta-tér EGYEZIK: a post-image fájl-sorszám (hunk `side:"new"` / `line`,
 * illetve `newLine`) pontosan a GitHub `side:"RIGHT"` / `line` szemantikája
 * (empirikusan ellenőrizve, lásd a recon-jelentést).
 *
 * FIGYELEM: a `comments[]` ATOMIKUS — egyetlen olyan `line`, ami nincs a PR
 * diffjében, 422-vel megbuktatja az EGÉSZ review-t.
 */
export function toGithubComments(comments) {
  return comments.map((c) => {
    const body = c.rationale ? `${c.summary}\n\n${c.rationale}` : c.summary
    const pos = findingPosition(c)
    // POZÍCIÓ NÉLKÜL fájl-szintű komment (`subject_type:"file"`) — `line`-nal 422
    // lenne. Ez a VÉGSŐ mentsvár: a hívók (parseHunkAgentComments,
    // normalizeAnswerFindings) a pozíció-hiányt már HANGOSAN elutasítják, tehát
    // ide gyakorlatilag csak akkor jut el finding, ha egy jövőbeli út kihagyja
    // azokat a kapukat.
    if (pos === null) {
      return { path: c.filePath, subject_type: 'file', body }
    }
    return {
      path: c.filePath,
      line: pos.line,
      side: pos.side === 'old' ? 'LEFT' : 'RIGHT',
      body,
    }
  })
}

/**
 * Egy finding pozíciója a KÉT elfogadott séma bármelyikéből: `{ side, line }`
 * vagy `null`.
 *
 * A SORREND KÖTÖTT, és a `hunk-findings.mjs` doktrínáját ismétli: ha MINDKÉT
 * oldal meg van adva (agent-slip), a POST-IMAGE (`new`) nyer — az a diff jobb
 * oldala, amit a reviewer olvas.
 *
 * FAIL-CLOSED A NEM-SZÁM POZÍCIÓRA: a `Number.isInteger` kapu után csak valódi
 * sorszám mehet ki. Egy `"143"` string vagy `NaN` a GitHubon 422-t adna, itt
 * viszont `null`-lá válik, tehát a finding fájl-szintű kommentként MÉGIS felmegy —
 * a néma teljes-review-bukás helyett részleges pontosság-veszteség.
 */
function findingPosition(c) {
  // (A) séma: explicit `side` + `line`.
  if (Number.isInteger(c?.line) && c.line > 0) {
    return { side: c.side === 'old' ? 'old' : 'new', line: c.line }
  }
  // (B) séma: `newLine` / `oldLine`. A post-image ELŐBB (lásd fent).
  if (Number.isInteger(c?.newLine) && c.newLine > 0) return { side: 'new', line: c.newLine }
  if (Number.isInteger(c?.oldLine) && c.oldLine > 0) return { side: 'old', line: c.oldLine }
  return null
}

// --- Adatforrás / akció-végrehajtás ---------------------------------------
//
// Innentől nem tiszta függvények: a queue lekérése és az akciók végrehajtása.
// A TUI ezeket hívja; a tesztek a fenti tiszta részt fedik.
//
// A process-helper alapréteg (spawnFailure / fetchRepoRoot / spawnCollect) és az
// útkonstansok (SCRIPT_DIR / NEXT_SH) a bin/next/proc.mjs-ben laknak.

/**
 * A SESSION-LÉTEZÉS lekérdezésének argv-je.
 *
 * A `session list --json` a SZEMANTIKAILAG helyes kérdés: "milyen élő sessionök
 * vannak?". Ez MÁS kérdés, mint a `comment list` ("mik a findingok?") — és a
 * kettő szétválasztása LOAD-BEARING:
 *
 *   - a session-PRÓBA a claude indításának ELŐFELTÉTELE (sorrend-garancia),
 *   - a `comment list` a `before`/`after` MÉRÉS.
 *
 * MÉRT KÖVETKEZMÉNY (a mutáns-ellenőrzés fogta el): amíg a próba is a
 * `comment list`-en ment, a két lépés MEGFIGYELHETETLENÜL egybeolvadt — a
 * sorrend-garanciát ki lehetett iktatni anélkül, hogy bármelyik teszt piros
 * lett volna, mert a `before` mérés dobása ELFEDTE a hiányzó várakozást.
 *
 * NINCS `--repo` FLAG (MÉRVE, hunk 0.17.0):
 *   $ hunk session list --repo /x  →  "error: unknown option '--repo'", exit 1
 * Az opciók: `--json` és `-h`. A repo-szűrést tehát MI végezzük a JSON-on — egy
 * `--repo` flag feltételezése itt CSENDES exit-1-et adott volna, amit a
 * háromállapotú felismerés (üres stdout + nem-nulla exit) "nincs session"-nek
 * olvasott: a TUI minden próbán újat nyitna.
 */
export function hunkSessionListCommand() {
  return ['session', 'list', '--json']
}

/**
 * ÉLŐ hunk-session van-e ERRE A REPÓRA? — HÁROM ÁLLAPOT (lásd `hunkSessionAlive`).
 *
 * MELLÉKHATÁS-MENTES: a `session list` csak KÉRDEZ (a `reload` MÓDOSÍTANA, a
 * `diff` pedig ÚJAT NYITNA — egy állapot-lekérdezés nem tehet ilyet).
 *
 * A SZŰRÉS A `repoRoot` EGYEZÉSÉRE megy, mert a `session list` MINDEN sessiont
 * felsorol — a más repókra nyitottakat is. Egy szűrés nélküli "van legalább egy
 * session" válasz pontosan a user-jelentett hibát adná vissza: nála a
 * nyilvántartott EGYETLEN session egy MÁR TÖRÖLT temp-könyvtárra szólt
 * (`/private/var/…/tmp.G4I6zLIvk5/probe`), a mobile repóra pedig egy sem — a
 * szűrés nélküli próba mégis "élő session"-t jelentett volna.
 *
 * A MÉRT JSON-SÉMA (hunk 0.17.0): `{ sessions: [{ sessionId, pid, cwd,
 * repoRoot, … }] }`. A `repoRoot` a horgony, NEM a `cwd`: a `cwd` az indítás
 * helye (lehet a repón belüli alkönyvtár is), a `repoRoot` viszont ugyanaz a
 * gyökér, amit a `comment list --repo` vár.
 */
export function probeHunkSession(repoRoot) {
  const res = spawnSync(hunkBin(), hunkSessionListCommand(), { encoding: 'utf8' })
  // A HIÁNYZÓ BINÁRIS / spawn-hiba NEM session-állapot (lásd hunkSessionAlive).
  if (res.error) return null
  if (res.status !== 0) return hunkSessionAlive(res)
  let env
  try {
    env = JSON.parse(res.stdout || '')
  } catch {
    // A SZERZŐDÉS BUKOTT EL: nem-parse-olható kimenetből NEM következtetünk sem
    // létezésre, sem hiányra. A `null` a hívónál nyers hibát ad — egy "nincs
    // session" találgatás itt minden próbán új hunkot nyitna.
    return null
  }
  if (!env || !Array.isArray(env.sessions)) return null
  // Az ÖSSZEHASONLÍTÁS a NYERS gyökereken megy. A hunk a realpath-olt alakot
  // adja (`/private/var/…`), és a hívó is a `git rev-parse --show-toplevel`
  // realpath-olt gyökerét: a két forma tehát egyezik.
  return env.sessions.some((s) => s?.repoRoot === repoRoot)
}

/**
 * A repo-gyökér ÉLŐ hunk-sessionjének AZONOSÍTÓJA — a betöltés-guard horgonya.
 *
 * MIÉRT KELL (a user 5. futásának 3. lelete): az `applied` flag önmagában csak
 * a PR-hoz kötött, a hunk `q`-ja viszont a SESSIONT is elviszi — az újbóli
 * megnyitás ÚJ, ÜRES sessiont kap, amiben a betöltött note-ok NINCSENEK ott.
 * A guardnak tehát tudnia kell, HOVA történt a betöltés: a sessionId a MÉRT
 * séma része (`session list --json` → `sessions[].sessionId`, hunk 0.17.0).
 *
 * MINDEN nem-mérhető ágon `null` (hiba / szemét kimenet / nincs találat): a
 * hívó (answerFindingsNeedApply) ebből fail-safe döntést hoz — a `null` élő
 * azonosítóval sosem egyezik, tehát "nincs azonosítható élő session"-ként
 * viselkedik. NEM dob: az azonosító-olvasás kozmetikai út a megnyitás mellett,
 * egy dobás itt a teljes megnyitást vinné el.
 */
export function hunkLiveSessionId(repoRoot) {
  const res = spawnSync(hunkBin(), hunkSessionListCommand(), { encoding: 'utf8' })
  if (res.error || res.status !== 0) return null
  let env
  try {
    env = JSON.parse(res.stdout || '')
  } catch {
    return null
  }
  if (!env || !Array.isArray(env.sessions)) return null
  const own = env.sessions.find((s) => s?.repoRoot === repoRoot)
  const sid = own?.sessionId
  return typeof sid === 'string' && sid !== '' ? sid : null
}

/**
 * A HÁTTÉR-REVIEW SORREND-GARANCIÁJA: várakozás, amíg a session MEGJELENIK.
 *
 * MIÉRT KELL (a párhuzamos modell (i) követelménye): a `claude` CSAK akkor
 * indulhat, ha a session MÁR létezik — különben pontosan ugyanaz a "nincs élő
 * session" hiba jön, csak HÁTTÉRBEN, és a token MÁR elment a semmire. A
 * `hunk diff` viszont egy INTERAKTÍV TUI-t indít egy MÁSIK processzben: a
 * session nem a spawn pillanatában jön létre, hanem amikor a hunk daemonja
 * regisztrálta. Ezt MÉRNI kell, nem feltételezni.
 *
 * A VÁRAKOZÁS EXPONENCIÁLIS BACKOFF-fal pollozik (50 → 100 → 200 → … ms), és a
 * `timeoutMs` után FELADJA. A feladás HANGOS: `false`-t ad, és a hívó NEM
 * indítja el a claude-ot. A néma továbbmenés itt tokent költene egy olyan
 * sessionre, ami nem létezik.
 *
 * A `sleep` és a `now` INJEKTÁLHATÓ: enélkül a timeout-ág tesztje valós
 * másodpercekig tartana (vagy — ami rosszabb — flaky lenne).
 */
export async function waitForHunkSession(repoRoot, {
  timeoutMs = 10_000,
  probe = probeHunkSession,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  const started = now()
  let delay = 50
  for (;;) {
    const alive = probe(repoRoot)
    // `true` — megvan. `null` — NEM TUDHATÓ (daemon-hiba / nincs bináris): itt a
    // várakozásnak SEMMI értelme, a hiba nem az időzítésről szól. A hívó a nyers
    // diagnózist adja, nem 10 másodpercig vár egy telepítési hibára.
    if (alive === true) return true
    if (alive === null) return null
    if (now() - started >= timeoutMs) return false
    await sleep(delay)
    delay = Math.min(delay * 2, 1000)
  }
}

/**
 * A SESSIONBEN LÉVŐ AGENT-FINDINGOK `noteId`-HALMAZA.
 *
 * MIÉRT HALMAZ ÉS NEM DARABSZÁM (a párhuzamos modell (ii) követelménye): a
 * szinkron modellben a `before`/`after` DARABSZÁM elég volt, mert a claude
 * futása alatt SENKI MÁS nem írhatott a sessionbe. A párhuzamos modellben a USER
 * IS ír — ő a diffben ül, miközben az agent dolgozik. Egy puszta növekmény tehát
 * NEM bizonyítja, hogy az AGENT írt: két user-komment mellett a gate akkor is
 * "sikeres review"-t állítana, ha a claude egyetlen sort sem írt.
 *
 * A HALMAZ-DIFF user-írás mellett is HELYES: pontosan azokat az ID-ket adja,
 * amik a claude futása ALATT jelentek meg.
 *
 * MÉRT TÉNY (hunk 0.17.0, élő TUI-ban, tmux-ból vezérelve — a szétválasztás
 * MEGBÍZHATÓ, tehát a `--type agent` szűrő önmagában is jó lenne; a halmaz-diff
 * a MÁSODIK védelmi vonal):
 *   - a hunk TUI-ban KÉZZEL (`c`) írt komment: `source: "user"`,
 *     `noteId: "user:<epoch-ms>"` — a `--type agent` ERRE ÜRES listát ad;
 *   - a CLI-vel (`comment apply`) írt: `source: "agent"`,
 *     `noteId: "mcp:<uuid>:<n>"` — a `--type user` ERRE ad üres listát.
 * A kettő tehát nem mosódik össze; a halmaz-diff viszont akkor is helyes marad,
 * ha egy későbbi hunk-verzió ezt megváltoztatja.
 */
export function hunkAgentNoteIds(repoRoot, opts) {
  return new Set(hunkComments(repoRoot, opts).map((c) => c.noteId).filter((id) => id !== undefined))
}

/**
 * A MEGLÉVŐ session ÁTVÁLTÁSA a PR diffjére — a SINGLETON-viselkedés magja.
 *
 * `true`-t ad, ha a reload SIKERÜLT (tehát NEM kell új sessiont nyitni).
 * `false`-t, ha nincs mit reloadolni (nincs élő / ÁRVA session) — a hívó
 * ilyenkor NYIT. Ez a fail-soft ág SZÁNDÉKOS: a usernél pontosan az árva
 * session (törölt temp-gyökér) ütött ki, és ott a dobás zsákutca lett volna.
 *
 * MÁS, MEGNEVEZETT hunk-hibán DOB: a hamis "nincs session" diagnózis egy
 * MÁSODIK hunkot indítana ugyanarra a bajra (daemon-crash, zárolt DB).
 */
export function reloadHunkSession(repoRoot, base, head) {
  const res = spawnSync(hunkBin(), hunkSessionReloadCommand(repoRoot, base, head), { encoding: 'utf8' })
  const alive = hunkSessionAlive(res)
  if (alive === true) return true
  if (alive === false) return false
  // `null` — NEM TUDHATÓ. A hiányzó bináris KÜLÖN diagnózis (ugyanaz az elv,
  // mint a hunkComments ENOENT-ágán): ott nem a session a baj.
  if (res.error?.code === 'ENOENT') {
    throw new Error(
      'a `hunk` bináris nem indítható — sem a core bundled példánya '
      + '(`node_modules/.bin/hunk`, a `hunkdiff` dependency), sem a PATH-on lévő. '
      + 'Futtass `pnpm install`-t a core-ban. Ezért a review-session nem '
      + 'kezelhető. Ez NEM session-hiba: a bináris maga hiányzik.\n'
      + 'Mit tegyél: `brew install hunk` (telepíti/PATH-ra teszi), majd próbáld újra.',
    )
  }
  const spawnErr = spawnFailure(res, 'hunk')
  if (spawnErr) throw new Error(`a hunk-session nem váltható át: ${spawnErr}`)
  throw new Error(
    `a hunk-session átváltása nem sikerült (session reload, exit ${res.status}): `
    + `${(res.stderr || res.stdout || '').trim() || '(nincs kimenet)'}`,
  )
}




/**
 * A review-diff megnyitása hunkban. Konfigurálható: TUIPR_REVIEW_CMD — a {base},
 * {head}, {pr} placeholderek kicserélődnek.
 *
 * Default: a PR branch fetchelése egy lokális refre, majd `hunk diff base...head`.
 * Ez a hármas-pont forma a MERGE-BASE-től számol, tehát ugyanazt a diffet adja,
 * amit a GitHub mutat — és a `hunk` line-anchorjai a post-image sorszámok,
 * amiket a toGithubComments közvetlenül a GitHub RIGHT oldalára képez.
 */
/**
 * (wf31/19) A GYEREK SAJÁT PTY-BAN FUT — `script(1)`-en keresztül.
 *
 * A FAGYÁS GYÖKÉROKA, HÁROM ÉLES INCIDENSEN MÉRVE (`ps -o pgid` + `lsof` a
 * beragadt állapoton): a hunk és a TUI UGYANABBAN a process groupban ült, és a
 * terminál foreground pgrp-je ez a group volt — tehát a KERNEL MINDKETTŐNEK
 * ENGEDTE a TTY-olvasást. A leütött bájtokat a szülő szívta el, a hunk `S+`-ban
 * inputra várt, és soha nem kapott gombot. Innen a lánc: nem lép ki → a `close`
 * nem jön → a `finally` nem fut → az fd-k is ottmaradnak (a mért állapotban HAT
 * TTY-leíró volt a szülőn, a `d` ismételt nyitásaiból).
 *
 * A DÖNTŐ MEGFIGYELÉS: a gyereknek VOLT saját `/dev/tty` fd-je (`0r`, a wf26-os
 * fix), és MÉGIS beragadt. A kernel a PGRP alapján dönt, nem az fd alapján —
 * tehát a fd-csere (wf26) és a `process.stdin.pause()` (wf31/18) is a ROSSZ
 * SZINTEN próbálkozott. Mindkettő MÉRVE elégtelen: a harmadik fagyás azzal a
 * javítással a kódban történt.
 *
 * AMIT MÉG ELVETETTEM, MÉRÉSSEL: `bash -mc` (job control). A `-m` `-c` módban
 * NEM tesz külön process groupba — a gyerek pgid-je változatlanul a szülőé
 * (mérve: 41193 mindkét alakban). A feltevés hibás volt.
 *
 * A `script -q /dev/null` VISZONT SAJÁT PSZEUDOTERMINÁLT ad a gyereknek, és
 * process group leaderré teszi (mérve: `pgid == pid`, `tty=/dev/ttysNNN` — MÁS,
 * mint a szülő terminálja). A versengés így ELVBŐL megszűnik: a hunk a saját
 * PTY-ját olvassa, a szülő a sajátját — nincs közös leíró, nincs közös pgrp.
 *
 * A `-q` a `script` fejlécét/láblécét nyomja el ("Script started/done on …"),
 * ami különben a TUI képébe írna. A `/dev/null` a tipikus scriptfile-helyettes:
 * a `script` MINDIG naplóz, de ide dobjuk.
 *
 * A TERMINÁL-MÉRET ÁTADÁSA KÖTELEM, NEM KÉNYELEM: a `script` PTY-ja DEFAULT
 * méretet kap, nem a valódi terminálét — mérve `0 0`-t is adott. Egy rossz
 * szélességen a hunk TUI-ja tördel/csonkol. Ezért a gyerek shellje ELŐBB
 * `stty`-vel ráállítja a MÉRT méretet (és kikapcsolja az echo-t — lásd ott), és
 * csak utána indítja a hunkot. A méret a SPAWN pillanatában érvényes érték (a
 * hívó adja át) — a spawn UTÁNI resize-t ez nem követi, ami TUDOTT KORLÁT: a hunk
 * a `q`-ig ugyanazon a méreten marad. (A user visszajelzése: "a hunk nem
 * méreteződik a terminal ablak után, de ezzel együtt lehet élni.")
 */
function ptyWrap(inner, { columns, rows }) {
  // A MÉRET-ELŐTAG CSAK MÉRT ÉRTÉKKEL kerül be: egy kitalált `80 24` rosszabb,
  // mint a `script` defaultja, mert HAZUG pontosságot ad. Nem-TTY-n (pipe,
  // teszt) a hívó `null`-t ad, és akkor a `stty` ki is marad.
  //
  // (wf31/20) A `-echo` IS BEKERÜL: a `script` PTY-ja DEFAULT ECHO-val indul, és
  // a megnyitáskor egy `^D\b\b`-t ír a kimenetre (MÉRVE: `od -c` a `script -q`
  // kimenetén — a `-q` a fejlécet elnyomja, EZT nem). Ez a TUI képébe/a
  // scrollbackbe szemetel. A hunk maga raw-mode-ot állít magának, tehát az echo
  // kikapcsolása a viselkedését nem érinti — csak a PTY induló állapotát tisztítja.
  const sttyArgs = ['-echo']
  if (Number.isInteger(columns) && columns > 0 && Number.isInteger(rows) && rows > 0) {
    sttyArgs.push(`rows ${rows}`, `cols ${columns}`)
  }
  // Az `exec` LOAD-BEARING: enélkül a shell a hunk mellett ÉLETBEN MARAD, tehát a
  // `script` gyereke egy shell lenne, nem a hunk — a `close` esemény pedig a
  // shell (nem a hunk) kilépésekor jönne meg. Az `exec` ráadásul egy processzt is
  // megszüntet a láncból.
  return ['script', ['-q', '/dev/null', 'bash', '-c', `stty ${sttyArgs.join(' ')}; exec ${inner}`]]
}

/**
 * A hunk-diff parancs BELSŐ (`bash -c`-be írható) alakja, a `script`-burkolat
 * NÉLKÜL.
 *
 * MIÉRT VÁLIK KÜLÖN a `ptyWrap`-tól: a node-pty relé (`openReviewViaPty`,
 * lentebb) ÖNMAGA ad saját PTY-t és saját process groupot a gyereknek — a
 * `script`-es burkolat (ami épp ERRE a két tulajdonságra való, lásd a
 * `ptyWrap` fejét) NÁLA FELESLEGES lenne. A KÉT út (`TUIPR_REVIEW_CMD` sablon
 * + a default `hunk diff`) parancs-építése viszont AZONOS, tehát EGY helyen
 * áll — szétírva a sablon-behelyettesítés az egyik úton könnyen lemaradna egy
 * jövőbeli módosításnál.
 */
export function reviewInnerCommand(pr, base, head, { agentNotes = false } = {}) {
  const tpl = process.env.TUIPR_REVIEW_CMD
  if (tpl) {
    // A SABLON a user SAJÁT parancsa — abba nem injektálunk flaget: ő tudja,
    // mit akar futtatni, és egy idegen `--agent-notes` el is hasalhatna rajta.
    return tpl.replaceAll('{pr}', String(pr)).replaceAll('{base}', base).replaceAll('{head}', head)
  }
  // A `--agent-notes` MÉRT flag (hunk 0.17.0 `diff --help`: "show agent notes
  // by default"): a review-megnyitáskor (r, ill. a `d` betöltős útja) az
  // AI-kommentek AZONNAL látszanak, nem kell az `a` toggle. A pending-mentes
  // `d` út flag NÉLKÜL fut — bájtra a régi, a hunk defaultja marad.
  return `${hunkBinShell()} diff${agentNotes ? ' --agent-notes' : ''} "${base}...${head}"`
}

export function reviewCommand(pr, base, head, { agentNotes = false, columns = null, rows = null } = {}) {
  // A PTY-BURKOLÁS ITT KELL: a fagyás a TTY-versengésből jön, ami FÜGGETLEN
  // attól, mit futtatunk — egy saját sablon (`TUIPR_REVIEW_CMD`) ugyanúgy
  // beragadna. Ez az út a `script`-es (nem node-pty-s) megnyitáshoz kell,
  // lásd az `openReviewView` hívási helyét.
  return ptyWrap(reviewInnerCommand(pr, base, head, { agentNotes }), { columns, rows })
}

/**
 * A hunk-diff SPAWN-OPCIÓI — a `cwd` ITT dől el, EGY helyen.
 *
 * VALÓDI, USER-JELENTETT HIBA GYÖKÉROKA (a `d` után is "nincs élő session"):
 * az `openReview` a `spawnSync(cmd, args, { stdio: 'inherit' })` alakot
 * használta, **`cwd` NÉLKÜL**. A hunk így a TUI PROCESS munkakönyvtárát látta
 * repoRoot-nak, a `hunkComments` viszont a `--repo <git rev-parse
 * --show-toplevel>` gyökeret kérdezte. A session tehát MÁS gyökérre jött létre,
 * mint amit kerestünk — és a két gyökér csak akkor egyezett, ha a user épp a
 * repo gyökeréből indította a TUI-t.
 *
 * TMUX PTY-N MÉRVE (a TUI a repón KÍVÜLI könyvtárból indítva):
 *   hunk diff origin/main...refs/tuipr/pr/101   [cwd=/tmp/tuipr-pty/elsewhere]
 *   hunk session comment list --repo /tmp/tuipr-pty/repo --type agent --json
 *
 * FAIL-SOFT, DE NEM HAZUG: ha a gyökér nem mérhető (üres/null), a `cwd` KIMARAD
 * — a process a sajátját örökli, ahogy eddig. Egy `cwd: ''` a spawnSync-en MÁS
 * viselkedést adna (és a `d` némán elhasalna), egy `cwd: undefined` pedig
 * hazug pontosságot sugallna a hívási helyen.
 *
 * --- (wf26) AZ STDIO: MIÉRT NEM `'inherit'` TÖBBÉ ---------------------------
 *
 * A USER 6. ÉLES FUTÁSÁNAK LELETE: a hunk-nézetből `q`-val kilépve a TUI NEM
 * TÉRT VISSZA — a lista eltűnt, csak a fejléc-sor maradt a shellben. A processz
 * nem hasalt el és nem is lépett ki: ÖRÖKRE FAGYOTT.
 *
 * A DIAGNÓZIS élő PTY-n, a FAGYOTT processzt `sample(1)`-lel mérve — a főszál
 * natív stackje a fagyás pillanatában:
 *
 *   uv_run → uv__io_poll → uv__stream_io → read (libsystem_kernel.dylib)
 *
 * Tehát a loop egy BLOKKOLÓ `read()`-ben áll a TTY-n (NEM `kevent`-ben), így a
 * gyerek halálát jelző SIGCHLD-et FEL SEM TUDJA DOLGOZNI: a hunk gyereke
 * ZOMBIVÁ vált (`ps`: `ZN+ <defunct>`), az `openReviewView` promise-a sosem
 * settle-elt, és még a `setInterval`-timerek is megálltak. A `d` útja tehát EL
 * SEM JUTOTT a resume utáni renderig — a hiba NEM a render, NEM a `loadedAt`
 * alapú elrejtés és NEM a wf20-as aszinkron reload.
 *
 * AZ OK a `stdio: 'inherit'`: a gyerek UGYANAZT a TTY fd-t kapta, amin a Node
 * (az Ink raw-mode-os stdinjén keresztül) MÁR olvasott.
 *
 * A MÉRT IZOLÁCIÓ (élő PTY-n, Ink NÉLKÜL is reprodukálva):
 *   - stdin-olvasás nélkül / csak `setRawMode` / csak `ref()` → `close` MEGJÖN
 *   - `readable` listener VAGY `resume()`                     → FAGYÁS
 *   - `pause()` + `unref()` + `removeAllListeners()` a spawn előtt → FAGYÁS
 *     (a blokkoló `read()` MÁR bent van a syscallban — stream-szintről nem
 *     visszavonható; ezért NEM a hívási hely köré tett "pauzálás" a fix)
 *   - saját `/dev/tty` fd a gyereknek                         → `close` MEGJÖN
 *
 * A GYEREK INTERAKTIVITÁSA NEM SÉRÜL (élő PTY-n a gyerekben mérve:
 * `tty=/dev/tty`, `[ -t 0 ]` = yes, `stty size` = 30 120, a leütött gombok
 * megérkeznek, a `q` kilép), és a szülő a zárás után VISSZASZEREZI a terminált:
 * a `/dev/tty` UGYANAZ a terminál, csak MÁS fd — épp ez oldja a beragadást.
 *
 * A `closeFds()` NEM opcionális kényelem: a `d` egy sessionben sokszor fut, és
 * fd-szivárgás mellett a TUI előbb-utóbb EMFILE-lel halna meg.
 */
export function reviewSpawnOptions(repoRoot) {
  const root = typeof repoRoot === 'string' ? repoRoot.trim() : ''
  const base = root === '' ? {} : { cwd: root }
  return {
    ...base,
    // (wf31/19) MINDHÁROM IRÁNY `'inherit'` — a saját `/dev/tty` fd KIVEZETVE.
    //
    // MIÉRT: a gyerek mostantól SAJÁT PTY-ban fut (`script -q /dev/null` — lásd a
    // `reviewCommand` fejét), tehát a terminálját a `script` adja, nem mi. Egy
    // külön `/dev/tty`-megnyitás ebben a modellben FELESLEGES (a versengés a PTY
    // szintjén már megszűnt) és KÁROS is: a `script` a saját PTY-ját akarja a
    // gyerek stdinjére kötni, egy explicit fd ezt írná felül.
    //
    // AMI MEGSZŰNIK VELE: az fd-SZIVÁRGÁS. A mért, beragadt állapotban HAT
    // TTY-leíró volt a szülőn (`0u 1u 2u 11u 15u 16u 17r`) — a `closeFds()` csak
    // akkor futott, ha a promise settle-elt, fagyás mellett pedig nem. Amit nem
    // nyitunk meg, azt nem is kell zárni.
    //
    // AMI VÁLTOZATLANUL ÁLL: a `[fd, fd, fd]` alak a Bun `kqueue`-ján CRASHELT
    // (EINVAL, mérve hunk 0.17.0 / Bun v1.3.14) — ezért nem tértünk vissza
    // explicit írás-fd-kre sem. Az `'inherit'` a mért, működő forma.
    stdio: 'inherit',
    // A `closeFds` MEGMARAD NO-OP-KÉNT: a hívási hely `finally`-ja hívja
    // (`spawnOpts.closeFds?.()`), és a szerződése (idempotens, sosem dob)
    // változatlan — csak már nincs mit zárni.
    closeFds: () => {},
  }
}

// (wf31/19) A `defaultOpenTty` KIVEZETVE: a gyerek saját PTY-ban fut
// (`script -q /dev/null`), tehát nem nyitunk neki `/dev/tty`-t. Az indoklás a
// `reviewSpawnOptions` stdio-magyarázatában áll.

/**
 * A hunk-diff nézet megnyitása ASZINKRON gyerekként — a terminált átadva.
 *
 * MIÉRT NEM `spawnSync` (MÉRT BUG, élő PTY-n tmuxban megfigyelve): a `spawnSync`
 * a NODE EVENT LOOPJÁT blokkolja a gyerek TELJES élettartamára. A hunk TUI pedig
 * addig fut, amíg a user `q`-t nem nyom — tehát a spawnSync mellett a
 * PÁRHUZAMOSSÁG ELVBŐL LEHETETLEN: a `waitForHunkSession` pollja SOSEM futott le
 * újra, a `claude` pedig csak a diff BEZÁRÁSA UTÁN indult el. A napló ezt
 * mutatta: a session MÁR élt (`session.alive` létezett), a várakozás mégsem
 * haladt, mert a loop állt.
 *
 * Az `spawn` mellett a loop szabad marad: a session-próba lefut, a claude
 * elindul, és a findingok a MÉG NYITVA lévő diffben jelennek meg — pontosan az,
 * amit a user kért.
 *
 * A `stdio: 'inherit'` VÁLTOZATLAN: a hunknak VALÓDI TTY kell (interaktív TUI).
 * A promise a gyerek KILÉPÉSEKOR settle-el, tehát a hívó továbbra is meg tudja
 * várni a nézet bezárását — csak közben nem fagyasztja meg a processzt.
 */
export function openReviewView(cmd, args, opts, {
  spawn: spawnImpl = spawn,
  watchdog = null,
  onExit = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(cmd, args, opts)
    let settled = false
    // A `stopWatch` DEKLARÁCIÓJA A `done` ELŐTT — a `done` a closure-jén át olvassa,
    // és egy alatta álló `let` TDZ-hibát adna, ha a `close` a watchdog beállítása
    // ELŐTT sülne el (rövid életű gyerek: ENOENT, azonnali exit).
    let stopWatch = null
    const done = (fn, arg) => {
      if (settled) return
      settled = true
      stopWatch?.()
      fn(arg)
    }
    // (wf31/16) A BERAGADÁS-ŐR — a user élő incidenséből.
    //
    // A TÜNET: a `d` megnyitotta a `hunk diff`-et, és a TELJES terminál befagyott
    // — se egér, se billentyű, se `Ctrl-C`. A mért állapot (`ps`/`lsof`): a hunk
    // `S+` (foreground, INPUTRA VÁRVA), és KÉT olvasó fd-t tartott ugyanarra a
    // `/dev/tty`-ra, miközben a szülő Node libuv-ja is bent volt a blokkoló
    // TTY-`read()`-jében. A `Ctrl-C` sem hatott: az Ink raw-mode-ja kikapcsolja az
    // `ISIG`-et, tehát a `^C` nem jellé, hanem BÁJTTÁ fordult — egy olyan
    // olvasóhoz, ami nem dolgozta fel.
    //
    // MIÉRT NEM AZ „ÍR-E VALAMIT" A JEL: a gyerek stdout/stderr-je ÖRÖKÖLT
    // (`stdio: [fd, 'inherit', 'inherit']` — lásd a `reviewSpawnOptions`
    // indoklását), tehát a szülő NEM LÁTJA, mit ír. Az „elhallgatott" gyerek
    // detektálása ezen az úton elvből lehetetlen.
    //
    // A MEGBÍZHATÓ JEL A SESSION MEGJELENÉSE, egy MÁSIK processzből mérve: a
    // `hunk session list --json` a DAEMONT kérdezi (nem a TTY-n ülő gyereket),
    // tehát akkor is válaszol, ha a gyerek a terminálra beragadt. Ha a hunk
    // NORMÁLISAN indul, a session másodperceken belül regisztrálódik; ha
    // beragadt a TTY-n, SOSEM. Ez a `waitForHunkSession` már bejáratott
    // mechanizmusa — itt csak MÁS célra használjuk (őr, nem sorrend-garancia).
    //
    // FAIL-SOFT MINDEN BIZONYTALANSÁGRA: a `watchdog` CSAK akkor öl, ha a próba
    // EXPLICIT `false`-t adott (a daemon válaszolt, és a session NINCS ott). A
    // `null` (nem mérhető: daemon-hiba, hiányzó bináris) NEM ölés — ott nem
    // tudjuk, mi történik, és egy MŰKÖDŐ diff elvágása rosszabb, mint a
    // várakozás. Ugyanaz a doktrína, ami a `probeHunkSession` `null`-ágán áll.
    if (watchdog) stopWatch = watchdog(child, (reason) => done(reject, reason))
    child.on('error', (error) => {
      done(reject, error?.code === 'ENOENT'
        ? new Error(
          `a(z) \`${cmd}\` nem indítható (ENOENT): nincs telepítve, vagy nincs a PATH-on. `
          + 'Ez NEM a review hibája — a bináris maga hiányzik.',
        )
        : new Error(`a diff-nézet nem indítható: ${error?.message ?? String(error)}`))
    })
    // A NEM-NULLA EXIT NEM HIBA: a hunk TUI-ból való kilépés (`q`) legitim, és a
    // pager-szerű eszközök gyakran nem-nullával térnek vissza megszakításkor. A
    // `d` szerződése az, hogy a nézet LEZÁRULT — nem az, hogy 0-val tette.
    // (wf31/48) AZ `exit` HOOK — A `close`-NÁL KORÁBBI JEL, KOZMETIKAI CÉLRA.
    //
    // MIÉRT KELL KÜLÖN A `close` MELLÉ: a promise a `close`-ra oldódik fel (az a
    // helyes szerződés — ott már a stdio is elzárult), DE a `close` a mérés szerint
    // ~50 ms-mal a processz tényleges kilépése UTÁN jön. A hunk viszont a kilépéskor
    // AZONNAL kiírja a `?1049l`-t, tehát ebben az ablakban a shell képe látszik. A
    // hívó ezen a hookon léphet vissza alt-screenbe a lehető leghamarabb.
    //
    // KIZÁRÓLAG KOZMETIKAI: a hook NEM settle-eli a promise-t, és a hibája sem
    // változtat a kimenetelen — egy dobó hook nem viheti el a `d` útját. Ezért
    // fail-soft, és ezért NEM a `done`-on keresztül megy.
    child.on('exit', () => {
      try {
        onExit?.()
      } catch { /* kozmetikai hook: a hibája nem befolyásolja a nézet zárását */ }
    })
    // A NEM-NULLA EXIT NEM HIBA (lásd fent) — a `close` a settle-pont.
    child.on('close', () => done(resolve))
  })
}

/**
 * (wf31/16) A BERAGADÁS-ŐR GYÁRTÓJA — `openReviewView({ watchdog })`-ba adva.
 *
 * A SZERZŐDÉS: visszaad egy `stop()`-ot, amit az `openReviewView` MINDEN kimeneten
 * meghív (siker, hiba, ölés) — enélkül a timer a TUI életére ott maradna.
 *
 * A HATÁRÉRTÉK INDOKLÁSA (`graceMs`): a `waitForHunkSession` defaultja 10 s a
 * SORREND-GARANCIÁRA — ott a türelem indokolt, mert a claude indítása a tét. Az
 * ŐRNEK viszont a FAGYÁST kell elkapnia, és ott a türelem ára az, hogy a user
 * ennyi ideig egy halott terminált néz. A 20 s KÉTSZERESE a bejáratott
 * várakozásnak: egy lassú (nagy repó, cold daemon) indulást biztosan átereszt,
 * de nem hagy percekig fagyva. NEM konfigurálható a hívási helyen — egy
 * per-hívás küszöb pont az az elcsúszás, amiből a következő „miért vágta el?"
 * lelet születne.
 *
 * A `probe` és a `sleep`/`now` INJEKTÁLHATÓ, a `waitForHunkSession` mintájára:
 * enélkül az őr tesztje valós 20 másodpercig tartana.
 */
export function makeStuckViewWatchdog(repoRoot, {
  graceMs = 20_000,
  probe = probeHunkSession,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  return (child, onStuck) => {
    let stopped = false
    const started = now()
    const loop = async () => {
      let delay = 500
      for (;;) {
        await sleep(delay)
        if (stopped) return
        // A GYEREK MÁR NINCS: a `close` úgyis settle-eli a promise-t, itt nincs
        // dolgunk. (`exitCode`/`signalCode` bármelyike nem-null → lezárult.)
        if (child.exitCode !== null || child.signalCode !== null) return
        const alive = probe(repoRoot)
        // MEGVAN A SESSION → a hunk NORMÁLISAN fut, az őr LESZÁLL. Innentől a
        // nézet addig él, ameddig a user akarja (`q`) — ez a szerződés.
        if (alive === true) return
        // NEM MÉRHETŐ (`null`) → NEM ölünk (lásd a fail-soft indoklást fentebb).
        // Tovább pollozunk: hátha a daemon magához tér a türelmi időn belül.
        if (alive === false && now() - started >= graceMs) {
          stopped = true
          // A GYEREK MEGÖLÉSE: `SIGTERM` ELŐBB. A mért incidensben a beragadt
          // hunk erre KILÉPETT, és utána a szülő `close`-kezelője rendben
          // lefutott (a teljes lánc lebomlott) — tehát a `SIGKILL` nem
          // szükséges első lépésként, és a finomabb jel esélyt ad a hunknak a
          // terminál-állapot helyreállítására (raw-mode, alternate screen).
          try { child.kill('SIGTERM') } catch { /* már elment */ }
          // A `SIGKILL` BIZTOSÍTÉK: ha a `SIGTERM` sem hat, a fagyás megmarad.
          // Az `unref` load-bearing: enélkül ez a timer a TUI kilépését is
          // késleltetné.
          const hard = setTimeout(() => {
            try { child.kill('SIGKILL') } catch { /* már elment */ }
          }, 2000)
          hard.unref?.()
          onStuck(new Error(
            'a hunk-diff nézet BERAGADT: a session nem jelent meg '
            + `${Math.round(graceMs / 1000)} másodpercen belül, miközben a hunk `
            + 'processz futott — a nézetet lezártuk, hogy a terminál ne fagyjon be.\n'
            + 'Ez a TTY-átadás mért hibaosztálya (a gyerek és a TUI ugyanazt a '
            + 'terminált olvasta). Mit tegyél: próbáld újra a `d`-t; ha ismétlődik, '
            + 'nyiss egy sessiont külön terminálban (`hunk diff <base>...<head>`), '
            + 'és a TUI azt fogja használni.',
          ))
          return
        }
        delay = Math.min(delay * 2, 2000)
      }
    }
    void loop()
    return () => { stopped = true }
  }
}

// --- node-pty relé: a hunk↔TUI váltás SHELL-FLASH-JÉNEK megszüntetése -------
//
// A `script`-es út (ptyWrap/openReviewView, fentebb) a HÁROM ÉLES FAGYÁST
// megoldja (saját PTY, saját process group — lásd a `ptyWrap` fejét), de a
// hunk KILÉPÉSEKOR MÉRT ~40 ms-os shell-flash MARAD: a `script` csak a HUNK
// halála UTÁN záródik le, és a hunk `?1049l`-je eközben a nyers, örökölt
// fd-re megy (`stdio: 'inherit'`) — a szülő nem látja, nem tudja
// visszatartani.
//
// A node-pty-vel a szülő MAGA a relé: a gyerek TELJES bájtfolyama az
// `onData`-n megy át, tehát a `?1049l` KISZŰRHETŐ, MIELŐTT a valódi
// terminálra kerülne — a váltást innentől MI vezényeljük, nem a hunk. A
// terminál ezért SOSEM esik vissza a primary bufferre a hunk kilépésekor: ez
// nem az ablak SZŰKÍTÉSE, hanem ELVI megszüntetése.
//
// OPTIONAL DEPENDENCY: a `node-pty` natív buildet igényel (pnpm `allowBuilds`
// jóváhagyás + platform-specifikus prebuild), ami nem minden gépen érhető el.
// A hívó ETTŐL FÜGGETLENÜL kell működjön — lásd az `openReviewViaPty` hibaosztályát.
let nodePtyCache // undefined = még nem próbáltuk; null = próbáltuk, nem megy; egyébként a betöltött modul
export function resetNodePtyCache() {
  nodePtyCache = undefined
}
/**
 * A node-pty `spawn-helper` FUTTATÁSI JOGÁNAK HELYREÁLLÍTÁSA — UPSTREAM CSOMAGOLÁSI
 * HIBA JAVÍTÁSA A HASZNÁLAT PONTJÁN.
 *
 * MI EZ A FÁJL: a `pty.fork()` TIZEDIK argumentuma (`node-pty/lib/unixTerminal.js`),
 * amit a natív modul a cél-parancs HELYETT futtat. Ez hívja a `setsid()`-et és a
 * `TIOCSCTTY`-t, majd `exec`-eli a hunkot — vagyis EZ adja a gyereknek a saját
 * sessionjét és CONTROLLING TERMINÁLJÁT. Pontosan az a tulajdonság, amiért a
 * `script -q /dev/null` burkolat is készült (lásd a `ptyWrap` fejét), és amitől a
 * HÁROM ÉLES FAGYÁS megszűnt. Nem segédprogram: maga az izolációs mechanizmus.
 *
 * A HIBA, MÉRVE (node-pty 1.1.0):
 *   - a PUBLIKÁLT npm tarballban a `spawn-helper` módja `-rw-r--r--` (ellenőrizve
 *     a registry tarballján: `tar -tvzf` → `-rw-r--r-- … prebuilds/darwin-arm64/spawn-helper`),
 *   - az `install` script (`scripts/prebuild.js`) CSAK ELLENŐRZI, van-e prebuild —
 *     nem épít és nem chmod-ol,
 *   - a `postinstall` (`scripts/post-install.js`) a `build/Release`-t takarítja és
 *     Windowson conpty-t másol — `chmod` SEHOL nincs benne.
 * A csomag tehát teljes egészében arra hagyatkozik, hogy a tar-kicsomagolás megőrzi
 * az exec-bitet — amit a tarball maga nem hordoz. Tünet: `posix_spawnp failed`.
 *
 * MIÉRT CSAK MACOS-ON: prebuild KIZÁRÓLAG `darwin-*` és `win32-*` platformra van a
 * csomagban. Linuxon nincs, tehát ott `node-gyp rebuild` fut, a helper HELYBEN
 * fordul, és futtatható lesz. Az ubuntu CI-t ez a hiba NEM érinti — a macOS
 * fejlesztői gépeket és a macos runnert igen.
 *
 * MIÉRT ITT, ÉS NEM EGY POSTINSTALL SCRIPTBEN: a core az EGYETLEN fogyasztója a
 * node-pty-nak, tehát itt egy helyen javítva MINDEN telepítési alakban hat
 * (workspace overlay, standalone mobile/web a vendorolt snapshotból, CI) — anélkül,
 * hogy három repó install-pipeline-jához hozzá kellene nyúlni. Ráadásul ÖNJAVÍTÓ:
 * egy `pnpm store prune` vagy friss klón utáni első használatkor újra lefut.
 *
 * FAIL-SOFT, SZÁNDÉKOSAN: ha a fájl nincs meg, vagy a store írásvédett, NEM dobunk —
 * a hívó `openReviewViaPty`-ja úgyis `NODE_PTY_UNAVAILABLE`-lel a `script`-es útra
 * esik. Ez a javítás tehát legrosszabb esetben nem használ; ártani nem tud.
 */
function ensureSpawnHelperExecutable() {
  // Windowson nincs `spawn-helper` (ott a conpty/winpty út megy) — nincs mit tenni.
  if (process.platform === 'win32') return
  let root
  try {
    root = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
  } catch {
    return // nincs telepítve — a hívó fallbackje veszi át
  }
  // A KÉT LEHETSÉGES HELY: a prebuild (ez a hibás ág) és a helyben fordított
  // kimenet (ez már eleve futtatható, de az ellenőrzés olcsó és ártalmatlan).
  const candidates = [
    path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    path.join(root, 'build', 'Release', 'spawn-helper'),
  ]
  for (const candidate of candidates) {
    let mode
    try {
      mode = statSync(candidate).mode
    } catch {
      continue // ezen az ágon nincs helper — jöhet a másik jelölt
    }
    try {
      accessSync(candidate, constants.X_OK)
      return // MÁR futtatható: nincs mit javítani
    } catch { /* nem futtatható — ezt jöttünk helyrehozni */ }
    try {
      // A MEGLÉVŐ módhoz ADJUK az exec-bitet (`| 0o111`), nem felülírjuk: az
      // olvasási/írási jogokat a store tulajdonosa állította be, azokhoz nem nyúlunk.
      chmodSync(candidate, mode | 0o111)
    } catch { /* írásvédett store — a hívó fallbackje veszi át */ }
    return
  }
}

async function loadNodePty() {
  if (nodePtyCache !== undefined) return nodePtyCache
  // A HELYREÁLLÍTÁS A BETÖLTÉS ELŐTT: a `spawn-helper` a SPAWN pillanatában kell,
  // de a `loadNodePty` a memoizált belépési pont — így körönként EGYSZER fut le,
  // nem `d`-nyomásonként.
  ensureSpawnHelperExecutable()
  try {
    nodePtyCache = await import('node-pty')
  } catch {
    // NEM telepítve, vagy nincs natív build ehhez a platformhoz — a hívó a
    // `script`-es útra esik vissza (lásd `openReviewViaPty`), NEM hangos hiba.
    nodePtyCache = null
  }
  return nodePtyCache
}

/**
 * A hívó EZEN a `.code`-on ismeri fel az "essünk vissza a `script`-es útra"
 * állapotot (`openReviewViaPty` dobja) — attól MEGKÜLÖNBÖZTETVE, hogy a
 * node-pty MEGVAN, de a review-session magától omlott össze (az UTÓBBI
 * valódi hiba, azt nem szabad néma fallbackként kezelni).
 */
export const NODE_PTY_UNAVAILABLE = 'TUIPR_NODE_PTY_UNAVAILABLE'

/**
 * A hunk `?1049l` (alt-screen KILÉPÉS) szekvenciájának KISZŰRÉSE a node-pty
 * bájtfolyamából.
 *
 * MIÉRT KELL EGYÁLTALÁN A STATEFUL KERESÉS: a node-pty `onData`-ja STRING-et
 * ad (a natív réteg már UTF-8-ra dekódolta, a többbájtos karakterek határa
 * tehát MÁR helyes — mérve: az `encoding` default `'utf8'`, a node-pty
 * unixTerminal.js-e `_socket.setEncoding('utf8')`-ot hív) — a KERESETT
 * ESCAPE-SZEKVENCIA viszont ATTÓL FÜGGETLENÜL szétvágódhat egy `onData`-hívás
 * határán, hogy a pty tetszőleges méretű darabokban ad adatot. A `carry` ezért
 * a PATTERN-nel részlegesen egyező, MÉG EL NEM DÖNTHETŐ karakterfarkot tartja
 * a KÖVETKEZŐ `feed()`-hívásig.
 *
 * MIÉRT NEM SZŰRI a `?1049h`-t is: a szándék KIZÁRÓLAG a KILÉPÉS
 * visszatartása. A hunk saját BELÉPÉSE (a session elején írt `?1049h`)
 * ÁRTALMATLAN és ÁTMEGY változatlanul — a terminál ekkor MÁR alt-screenben
 * van (a hívó a spawn ELŐTT saját `?1049h`-t írt, lásd az `openHunkView`
 * hívási helyét az tui-app.mjs-ben), tehát a hunk írása egy, a
 * terminál szempontjából no-op-nak megfelelő, de VALÓS escape-kódot ismétel —
 * pontosan úgy, ahogy a mai `script`-es úton is teszi.
 */
export function createAltScreenExitFilter() {
  const PATTERN = '\u001B[?1049l'
  let carry = ''
  return {
    /** @returns {string|null} a kimenetre írható rész, `null`, ha nincs. */
    feed(chunk) {
      const s = carry + String(chunk)
      let out = ''
      let i = 0
      while (i < s.length) {
        let matched = 0
        while (matched < PATTERN.length && i + matched < s.length && s[i + matched] === PATTERN[matched]) {
          matched++
        }
        if (matched === PATTERN.length) {
          // TELJES EGYEZÉS — ez a szekvencia NEM kerül a kimenetre.
          i += matched
          continue
        }
        if (i + matched === s.length) {
          // a chunk ITT VÉGET ÉR, miközben a PATTERN-nel részlegesen egyezik —
          // a KÖVETKEZŐ feed() dönt, a farkot megőrizzük.
          carry = s.slice(i)
          return out.length > 0 ? out : null
        }
        out += s[i]
        i++
      }
      carry = ''
      return out.length > 0 ? out : null
    },
    /**
     * A folyam VÉGÉN megmaradt, MÉG EL NEM DÖNTHETŐ farok — idáig jutva ez
     * SOSEM volt teljes egyezés (a `feed()` a teljes egyezést AZONNAL,
     * kiírás nélkül nyeli el, még mielőtt a `carry`-ba kerülne).
     *
     * SZÁNDÉKOSAN ELDOBJUK, NEM ÍRJUK KI: a `carry` a konstrukció miatt
     * KIZÁRÓLAG a `\u001B[?1049l` egy VALÓDI, nem-üres PREFIXE lehet (a
     * `feed()`-ben csak akkor kerül bele, ha `matched > 0` ÉS a string épp
     * itt ér véget — lásd ott). Egy csonka escape-prefix (pl. önmagában egy
     * `\u001B` vagy `\u001B[?1049`) a terminálra írva egy LEZÁRATLAN
     * szekvenciát hagyna a parseren — a gyerek itt csak úgy szakadhat félbe,
     * hogy megölték/összeomlott KÖZBEN, tehát TÖBB bájt már SOSEM jön, ami
     * lezárná. A hiányzó pár bájt (ami vagy `h` vagy `l` lett volna) amúgy
     * sem hordoz értelmezhető tartalmat — az eldobás itt STRIKTEBB, mint a
     * `feed()` doktrínája (ami MINDEN NEM-egyező bájtot megőriz), de csak
     * azért, mert ez a farok DEFINÍCIÓ SZERINT sosem "normál tartalom".
     */
    flush() {
      carry = ''
      return null
    },
  }
}

/**
 * A hunk-diff nézet megnyitása node-pty RELÉN át — a `script`-es út
 * (`openReviewView`) HELYETT, amikor a node-pty elérhető.
 *
 * A MECHANIZMUS: a gyerek SAJÁT pszeudoterminálban fut (a node-pty adja
 * neki), tehát a VALÓDI terminálunkat (a mi fd 0/1/2-nk) SOSEM éri el — a
 * bájtfolyamot MI reléezzük mindkét irányban:
 *   - KIMENET: `child.onData` → (a `?1049l` kiszűrve, lásd
 *     `createAltScreenExitFilter`) → `process.stdout`,
 *   - BEMENET: a mi stdinünk (saját, dedikált `tty.ReadStream(0)`) →
 *     `child.write`.
 *
 * A PROCESS-GROUP IZOLÁCIÓ (a HÁROM ÉLES FAGYÁS javítása, lásd a `ptyWrap`
 * fejét) MEGMARAD, csak eszközváltással: a node-pty a gyereket SAJÁT PTY-ban
 * és SAJÁT process groupban indítja (MÉRVE, élő teszttel: a gyerek pgid-je a
 * SAJÁT pid-jével egyezik, a szülőétől ELTÉR) — tehát a `script`-es út
 * mögötti indoklás (a kernel a PGRP alapján dönt a TTY-olvasásról, nem fd
 * alapján) ITT IS érvényben marad.
 *
 * A STDIN-RELÉ KÜLÖN `tty.ReadStream(0)`-ot használ, NEM az Ink
 * `stdinWrapper` targetét: a hívó (`tui-app.mjs`) a spawn ELŐTT már
 * meghívta a `stdinWrapper.destroyOldTarget()`-et (a `DelegatingStdin`
 * szerződése szerint), tehát a régi target ekkor MÁR nem olvas — a relé a
 * SAJÁT, FRISS streamjét a gyerek TELJES élettartamára tartja nyitva, és a
 * kilépés UTÁN `destroy()`-olja. A hívó EZUTÁN hívja az `attachFreshTarget()`-et,
 * ami egy ÚJABB, Inknek szánt friss streamet hoz létre. A két stream tehát
 * IDŐBEN nem fedi egymást — ugyanaz a bevált minta (destroy → [munka] →
 * friss attach), mint a `stdio: 'inherit'` úton, csak a "munka" itt AKTÍV
 * relézés, nem tétlen várakozás. KÉT olvasó SOHA nincs egyszerre a fd-n, mert
 * a gyerek MAGA sosem éri el ezt az fd-t (saját PTY-ban él) — a korábbi
 * (wf26 előtti) hibaosztály (két olvasó UGYANARRA az örökölt fd-re) itt fel
 * sem merülhet.
 *
 * @throws {Error} `.code === NODE_PTY_UNAVAILABLE`, ha az `import('node-pty')`
 *   dob, VAGY a `pty.spawn()` maga dob (natív build hiányzik/törött a
 *   platformon) — a hívó EZEN a kódon ismeri fel, hogy a `script`-es útra
 *   kell esnie; ez NEM review-hiba.
 */
export async function openReviewViaPty(command, { cwd = null, columns = null, rows = null } = {}, {
  onExit = null,
  watchdog = null,
} = {}) {
  const nodePty = await loadNodePty()
  if (!nodePty) {
    const err = new Error('a `node-pty` nem resolválható — a hívónak a `script`-es útra kell esnie')
    err.code = NODE_PTY_UNAVAILABLE
    throw err
  }
  // MÉRT ÉRTÉKKEL, HA VAN: nem-TTY-n (a hívó `null`-t ad) a node-pty defaultja
  // (80x24) megy — kitalált méretet itt sem írunk be, ugyanaz a doktrína, mint
  // a `ptyWrap` fejében.
  const cols = Number.isInteger(columns) && columns > 0 ? columns : 80
  const rowsN = Number.isInteger(rows) && rows > 0 ? rows : 24
  let child
  try {
    child = nodePty.spawn('bash', ['-c', command], {
      name: 'xterm-256color',
      cols,
      rows: rowsN,
      cwd: cwd || process.cwd(),
      env: process.env,
    })
  } catch (error) {
    // A NATÍV BUILD törött/hiányzó a platformon — UGYANAZ a fallback-jel, mint
    // az import-hibán: a hívó szempontjából a két ok megkülönböztethetetlen
    // ("itt most nem megy a node-pty"), a reakció (essünk a `script`-re) azonos.
    const err = new Error(
      `a node-pty spawn nem sikerült — a hívónak a \`script\`-es útra kell esnie: ${error?.message ?? error}`,
    )
    err.code = NODE_PTY_UNAVAILABLE
    throw err
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let stopWatch = null
    let outputSub = null
    const relayStdin = new tty.ReadStream(0)
    const resizeHandler = () => {
      const c = process.stdout.columns
      const r = process.stdout.rows
      if (Number.isInteger(c) && c > 0 && Number.isInteger(r) && r > 0) {
        try { child.resize(c, r) } catch { /* a gyerek épp záródik — nem eshet el rajta a relé */ }
      }
    }

    const cleanupRelay = () => {
      outputSub?.dispose?.()
      process.stdout.removeListener('resize', resizeHandler)
      // FAIL-SOFT: a stream ekkorra akár már destroyed is lehet (pl. egy
      // korábbi hiba-ág futott le) — a takarítás hibája nem buktathatja a
      // hívót, a cél (a fd-n ne maradjon aktív olvasónk) enélkül is teljesül.
      try { relayStdin.setRawMode(false) } catch { /* lásd fent */ }
      try { relayStdin.destroy() } catch { /* lásd fent */ }
    }
    const done = (fn, arg) => {
      if (settled) return
      settled = true
      stopWatch?.()
      cleanupRelay()
      fn(arg)
    }

    try {
      // A BERAGADÁS-ŐRHÖZ a `makeStuckViewWatchdog` VÁLTOZATLANUL
      // újrahasznosítható — a szerződése `child.exitCode`/`child.signalCode`/
      // `child.kill(sig)`, az `IPty`-nek viszont ezek NINCSENEK (csak `onExit`
      // esemény + `kill(sig)` van). A SHIM ezt a KÉT felületet hidalja át, hogy
      // a fagyás-detektáló KÓDOT NE kelljen duplikálni két eszközre.
      const watchdogShim = { exitCode: null, signalCode: null, kill: (sig) => child.kill(sig) }
      if (watchdog) stopWatch = watchdog(watchdogShim, (reason) => done(reject, reason))

      const filter = createAltScreenExitFilter()
      outputSub = child.onData((chunk) => {
        const out = filter.feed(chunk)
        if (out !== null) process.stdout.write(out)
      })

      // A BEMENETI RELÉ — lásd a függvény fejét. RAW MODE KELL: a hunk
      // karakterenkénti billentyűket vár, nem sor-pufferelt (cooked)
      // bemenetet — az Ink `beginSuspend()`-je viszont KIKAPCSOLTA a raw
      // mode-ot ("Hand input back to the terminal (raw mode off...)", ink.js),
      // tehát nekünk kell VISSZAkapcsolnunk, a SAJÁT, friss streamünkön.
      relayStdin.setRawMode(true)
      relayStdin.on('data', (chunk) => {
        // A gyerek `write()`-ja Buffert IS elfogad (`Buffer.from(data)` a
        // node-pty CustomWriteStream-jében, string ág nélkül) — a nyers
        // bájtokat egy decode/encode kerülő nélkül, VÁLTOZATLANUL adjuk át,
        // hogy egy multi-byte karakter chunk-határon SOSE törhessen el.
        try { child.write(chunk) } catch { /* a gyerek már ment — a bájt elveszik, ez legitim */ }
      })

      // (BÓNUSZ) A TERMINÁL-MÉRET KÖVETÉSE: a `script`-es úton a hunk a
      // SPAWN pillanatában kapott mérethez van kötve a `q`-ig (tudott korlát,
      // lásd a `ptyWrap` fejét) — a node-pty `resize()`-a ezt FELOLDJA, ha a
      // valódi terminál a hunk FUTÁSA KÖZBEN méreteződik át.
      process.stdout.on('resize', resizeHandler)

      child.onExit(({ exitCode, signal }) => {
        watchdogShim.exitCode = exitCode
        watchdogShim.signalCode = signal ?? null
        // A FOLYAM VÉGÉN megmaradt, még el nem dönthető karakterfarkot a
        // `flush()` SZÁNDÉKOSAN eldobja, nem írja ki — egy csonka escape-prefix
        // (a gyerek KÖZBEN halt meg, mielőtt lezárta volna) rosszabb lenne a
        // terminálon, mint a hiánya. Lásd a `createAltScreenExitFilter.flush`
        // fejét.
        filter.flush()
        // (KOZMETIKAI, ld. az `openReviewView` `exit`-hookjának indoklását): a
        // hívó ezen léphet vissza alt-screenbe a lehető leghamarabb — bár a
        // fenti szűrés miatt ELMÉLETBEN már sosem hagytuk el, ez a hívás
        // BIZTOSÍTÉK, ha a szűrő valamiért egy jövőbeli hunk-verzió MÁSKÉNT
        // formázott escape-jén átcsúszna.
        try { onExit?.() } catch { /* kozmetikai hook: a hibája nem buktathatja a nézet zárását */ }
        done(resolve)
      })
    } catch (error) {
      // A SZINKRON BEKÖTÉS hasalt el (pl. a stdin NEM állítható raw módba) —
      // a gyerek EKKORRA már fut, tehát a hívónak NEM hagyhatjuk árván: a
      // `script`-es úton is ez a doktrína (a `finally` mindig zár).
      try { child.kill('SIGKILL') } catch { /* már ment / nem indult el */ }
      reject(error)
    }
  })
}

/**
 * A MEGLÉVŐ hunk-session ÁTVÁLTÁSA a kiválasztott PR diffjére.
 *
 * A user kérése: "nem lehetne azt, hogy saját singleton hunk sessiont tart fenn
 * a TUI?" — a hunk API-jának KORLÁTAI KÖZÖTT ez a legtöbb, ami megvalósítható:
 *
 *   - Sessiont NYITNI csak a `hunk diff` / `hunk show` tud, és az INTERAKTÍV
 *     TUI-t indít (MÉRVE: nincs `--headless` / `--detach` / `--background` a
 *     `hunk diff --help` opciólistáján). Tehát a TUI nem tud "csendben" sessiont
 *     nyitni a háttérben.
 *   - A `hunk session *` alparancsok CSAK LÉTEZŐ sessiont vezérelnek.
 *   - A `hunk session reload --repo <path> -- diff <ref>` viszont KICSERÉLI az
 *     élő session tartalmát — tehát ha EGYSZER van session, a PR-váltáshoz NEM
 *     kell újat nyitni. EZ a singleton-viselkedés magja.
 *
 * A `--` szeparátor load-bearing: utána a hunk a maradékot BEÁGYAZOTT parancsként
 * olvassa (`diff <range>`), nem a `session reload` saját flagjeként.
 */
export function hunkSessionReloadCommand(repoRoot, base, head) {
  return ['session', 'reload', '--repo', repoRoot, '--', 'diff', `${base}...${head}`]
}

/**
 * ÉLŐ-e a hunk-session? HÁROM ÁLLAPOT, szándékosan — a boolean itt hazudna.
 *
 *   `true`  — van élő session (exit 0).
 *   `false` — NINCS, de ez NEM HIBA: nyiss egyet. Ide tartozik az ÁRVA SESSION
 *             is, ami pontosan a usernél ütött ki: a nyilvántartott session
 *             repo-gyökere egy MÁR TÖRÖLT temp-könyvtár volt
 *             (`/private/var/…/tmp.G4I6zLIvk5/probe`), a mobile repóra pedig
 *             EGY session sem volt. A TUI-nak úgy kell kezelnie, MINTHA NEM
 *             LENNE — nyisson újat, ne dobjon hibát.
 *   `null`  — NEM TUDHATÓ. Egy MEGNEVEZETT más hiba (daemon-crash, zárolt DB,
 *             jogosultság) vagy a HIÁNYZÓ BINÁRIS (ENOENT) esetén a "nincs
 *             session" HAMIS DIAGNÓZIS lenne, ami egy MÁSODIK hunkot indítana
 *             ugyanarra a bajra. A hívó ilyenkor a NYERS hibát adja.
 *
 * A FELISMERÉS ugyanazon a két jelen áll, mint az `isNoActiveSession` (a hunk
 * szövege verzióváltással változhat, ezért nem szó szerinti match) — de itt a
 * harmadik állapot is meg van nevezve, mert a session-affinitás DÖNTÉST épít rá.
 */
export function hunkSessionAlive(res) {
  if (!res) return null
  // A HIÁNYZÓ BINÁRIS ELŐBB, mint a status: ENOENT-en a `status` null, amiből a
  // lenti néma-ág "nincs session"-t csinálna — HAZUG, mert a session
  // állapotáról semmit nem tudunk (lásd a hunkComments ENOENT-ágát).
  if (res.error) return null
  if (res.status === 0) return true
  const stderr = String(res.stderr ?? '').trim()
  const stdout = String(res.stdout ?? '').trim()
  if (/no active session/i.test(stderr)) return false
  // A NÉMA nem-nulla exit: nincs olvasható session-állapot → fail-soft "nincs".
  if (stderr === '' && stdout === '') return false
  // MEGNEVEZETT MÁS hiba: nem találgatunk.
  return null
}


/**
 * A `hunk session comment list` hívás argv-je — az AGENT-írta findingokra.
 *
 * A `--type agent` NEM stílus-kérdés, hanem MÉRÉS. A hunk 0.17.0-n ugyanarra az
 * EGY, CLI-vel beírt kommentre az öt szűrő ezt adta:
 *   --type live -> 1 | --type all -> 3 | --type user -> 0 | --type ai -> 0 (!) | --type agent -> 1
 * Tehát a CLI-vel (`comment add` / `comment apply`) beírt megjegyzés
 * `source: "agent"`, NEM `"ai"` — a `--type ai` MINDIG üres listát ad. Ha a
 * feltöltés arra épülne, NÉMÁN semmit nem töltene fel: a fejlesztő azt hinné,
 * felküldte a findingokat, holott üres review-t (vagy semmit) küldött.
 *
 * Miért nem a szűrő nélküli ("live") út: az a LEGACY nézet, ami az (a) sémát
 * adja (filePath/side/line/summary). Az agent-vezérelt flow-ban a `--type agent`
 * a szemantikailag helyes szűrő (az AGENT findingjai kellenek, nem a legacy
 * live-nézet), és ez a (b) sémát adja — lásd parseHunkAgentComments.
 */
export function hunkCommentsCommand(repoRoot) {
  return ['session', 'comment', 'list', '--repo', repoRoot, '--type', 'agent', '--json']
}

/**
 * A `comment list --type agent --json` (b) SÉMÁJÁNAK parse-olása a belső
 * (filePath/side/line/summary) alakra, amit a toGithubComments vár.
 *
 * A KÉT SÉMA (mért, hunk 0.17.0, UGYANAZ a komment):
 *   (a) `comment list --json` (szűrő nélkül, "live"):
 *       {commentId, filePath, hunkIndex, side, line, summary, rationale, createdAt}
 *   (b) `comment list --type agent|all --json`:
 *       {noteId, source, filePath, hunkIndex, newRange|oldRange, body, createdAt, editable}
 *
 * A (b)-ben NINCS `line` és NINCS `side`:
 *   - a sorpozíció a `newRange[0]` / `oldRange[0]`,
 *   - az OLDAL a `newRange` / `oldRange` JELENLÉTÉBŐL derül ki,
 *   - a `body` az összefűzött summary + "\n\n" + rationale (a hunk fűzi össze).
 * Ezért a (b) sémán a `c.line` `undefined` — a naiv úton ez NÉMÁN
 * `subject_type:"file"` fájl-szintű kommentté degradálta volna a findingot: a
 * finding felkerül, de NEM oda, ahova az agent mutatott.
 *
 * FAIL-CLOSED, három ponton. Egy elcsúszott sorpozíció rossz helyre tett
 * review-komment, ami rosszabb, mint a hangos bukás:
 *   1. nem-parse-olható kimenet → dobás, a NYERS kimenettel;
 *   2. hiányzó `comments` kulcs → dobás (a néma üres lista "nincs finding"-ot
 *      jelentene, holott a SZERZŐDÉS bukott el);
 *   3. pozíció nélküli finding (sem oldRange, sem newRange) → dobás.
 * Az ÜRES `comments` viszont LEGITIM: a user a hunkban mindent kiszűrt
 * (`comment rm`) — azt nem szabad hibának venni.
 */
export function parseHunkAgentComments(stdout) {
  const raw = String(stdout ?? '')
  const clip = (s) => (s.length > 2000 ? `${s.slice(0, 2000)}…[csonkolva]` : s)
  let env
  try {
    env = JSON.parse(raw)
  } catch {
    throw new Error(
      'a `hunk session comment list --type agent --json` kimenete nem parse-olható JSON '
      + '— NEM töltünk fel semmit.\n'
      + `nyers kimenet:\n${clip(raw.trim()) || '(üres)'}`,
    )
  }
  if (!env || !Array.isArray(env.comments)) {
    throw new Error(
      'a hunk kimenetében NINCS `comments` tömb — a szerződés bukott el, tehát NEM '
      + 'töltünk fel semmit (az üres lista itt hazug "nincs finding" lenne).\n'
      + `nyers kimenet:\n${clip(raw.trim()) || '(üres)'}`,
    )
  }
  return env.comments.map((c, i) => {
    const where = c?.filePath ? `${c.filePath} (${c?.noteId ?? `#${i}`})` : `a ${i}. finding`
    // A pozíció az EGYETLEN mező, amit nem lehet találgatni: a newRange és az
    // oldRange KÜLÖNBÖZŐ koordináta-térben él (post- vs pre-image), tehát a
    // hiányukból nem következtethetünk egyikre sem.
    const newLine = Array.isArray(c?.newRange) ? c.newRange[0] : undefined
    const oldLine = Array.isArray(c?.oldRange) ? c.oldRange[0] : undefined
    if (!Number.isInteger(newLine) && !Number.isInteger(oldLine)) {
      throw new Error(
        `${where}: a findingból hiányzik a pozíció (sem \`newRange\`, sem \`oldRange\`) — `
        + 'a sorpozíció NEM találgatható, egy elcsúszott sor rossz helyre tett review-kommentet '
        + 'jelentene. NEM töltünk fel semmit.\n'
        + `a nyers finding:\n${clip(JSON.stringify(c))}`,
      )
    }
    const body = typeof c?.body === 'string' ? c.body : ''
    if (body.length === 0) {
      throw new Error(
        `${where}: a finding \`body\`-ja üres — üres GitHub-kommentet nem töltünk fel.\n`
        + `a nyers finding:\n${clip(JSON.stringify(c))}`,
      )
    }
    // A `summary` mezőbe a TELJES body kerül, `rationale` NÉLKÜL: a hunk a (b)
    // sémában már összefűzte a kettőt, tehát a toGithubComments-ben egy külön
    // rationale újra-fűzése duplikálná a szöveget.
    return {
      noteId: c.noteId,
      source: c.source,
      filePath: c.filePath,
      side: Number.isInteger(newLine) ? 'new' : 'old',
      line: Number.isInteger(newLine) ? newLine : oldLine,
      summary: body,
    }
  })
}

// --- "NINCS ÉLŐ HUNK-SESSION": külön hibaosztály ----------------------------
//
// VALÓDI, USER-JELENTETT HIBA (#904, `r` = AI-review). A hunk ezt adta:
//   exit 1 · stderr: "hunk: No active session matches repoRoot /…/<repo>"
//   stdout: (üres)
// és a TUI ezt írta ki nyersen:
//   AI-review hiba: hunk comment list (exit 1): hunk: No active session …
// A FAIL-CLOSED viselkedés HELYES (a `before` mérés a claude-hívás ELŐTT van,
// tehát a bukás NEM költött tokent), az ÜZENET viszont használhatatlan volt: nem
// mondta meg, MIT tegyen a user. Az AI-review flow a findingokat az agenttel a
// HUNK SESSIONBE íratja (hunk-review skill, `comment apply`), tehát ÉLŐ SESSION
// az ELŐFELTÉTEL — ezt ki kell mondani, a megnyitás útjával együtt.

/**
 * A hunk-session megnyitásának útja — EGY helyen, hogy a hiba-üzenet és a
 * megerősítő ekrán ne csússzon szét (a duplikált user-facing szöveg az a
 * hibaosztály, amit ez a modul máshol is kerül).
 */
export const HUNK_SESSION_HINT =
  "nyiss egyet: a TUI-ból a `d` (diff-review) indítja a PR diffjével, vagy külön "
  + 'terminálban `hunk diff <base>...<head>`'

/**
 * FELISMERI-e a hunk kimenete a "nincs élő session" állapotot?
 *
 * A felismerés KÉT JELRE épül, nem egy pontos szövegre — a hunk üzenete
 * verzióváltással változhat, és egy szó szerinti match némán visszaesne a régi,
 * használhatatlan üzenetre:
 *   (1) a stderr tartalmazza a `No active session` részstringet, VAGY
 *   (2) nem-nulla exit + ÜRES stdout — ott sincs olvasható session-állapot.
 *
 * FAIL-CLOSED A MÁSIK IRÁNYBAN IS: ha a stderr MÁS konkrét hibát nevez meg
 * (daemon-crash, zárolt DB, jogosultság), a (2) jel NEM elég — inkább nyers
 * hiba, mint HAMIS diagnózis, ami a usert a session keresésére küldi egy
 * telepítési/daemon-hiba miatt.
 */
export function isNoActiveSession(res) {
  if (!res || res.status === 0) return false
  const stderr = String(res.stderr ?? '').trim()
  const stdout = String(res.stdout ?? '').trim()
  if (/no active session/i.test(stderr)) return true
  // A (2) jel CSAK akkor dönt, ha a hunk semmit nem mondott — egy megnevezett
  // más hiba mellett a "nincs session" találgatás lenne.
  return stderr === '' && stdout === ''
}

/**
 * A "nincs élő session" üzenet — a HÍVÁSI KONTEXTUSHOZ igazítva.
 *
 * A két kontextus MÁST jelent ugyanarra az állapotra, ezért nem egy szöveg:
 *  - `review`: az AI-review a findingokat a sessionbe ÍRATJA, tehát élő session
 *    az ELŐFELTÉTEL → nyiss egyet. Plusz a megnyugtató, IGAZ állítás: a bukás a
 *    claude-hívás ELŐTT van, tehát NEM költött tokent.
 *  - `upload`: a `f` út a sessionből OLVAS, tehát a "nincs session" annyit
 *    jelent, hogy NINCS MIT FELTÖLTENI — ott a "nyiss sessiont" felszólítás
 *    félrevezető lenne (nem a session hiánya a probléma, hanem a findingok).
 *    EZ AZ ÜZENET CSAK A VÉGSŐ ESETBEN jut a userhez: a hívó (`doUpload`) a
 *    "nincs session" osztályon ELŐBB a cache-elt review-findingokra esik
 *    fallbackre, és ez a szöveg csak akkor megy ki, ha ott SEM volt semmi —
 *    tehát a "NINCS MIT FELTÖLTENI" állítás igaz. A fallback nélkül HAMIS volt:
 *    a user #904-es esetében két finding ült a cache-ben, miközben ez az üzenet
 *    az ellenkezőjét állította.
 *  - `after`: az AI-review UTÁNI mérés. A claude MÁR LEFUTOTT, tehát a
 *    "tokent nem költöttünk" mondat itt HAZUG lenne — a session a futás közben
 *    zárult be, és a findingok elvesztek.
 */
export function noActiveSessionMessage(repoRoot, context = 'review') {
  if (context === 'upload') {
    return `nincs élő hunk-session erre a repóra (${repoRoot}), tehát NINCS MIT FELTÖLTENI. `
      + 'A findingok a hunk sessionben élnek; ha van mit feltölteni, előbb '
      + `${HUNK_SESSION_HINT}.`
  }
  if (context === 'after') {
    return `a hunk-session a review KÖZBEN szűnt meg (${repoRoot}), ezért a findingok `
      + 'nem olvashatók vissza — a review MÁR LEFUTOTT, tehát a költés megtörtént. '
      + `Indíts új sessiont (${HUNK_SESSION_HINT}), és futtasd újra az AI-review-t.`
  }
  return `nincs élő hunk-session erre a repóra (${repoRoot}). `
    + 'Az AI-review a findingokat a hunk sessionbe írja, ezért élő session az ELŐFELTÉTEL — '
    + `${HUNK_SESSION_HINT}. `
    + 'Tokent NEM költöttünk: a bukás a claude-hívás ELŐTT van.'
}

/**
 * A hunk sessionben MEGMARADT agent-findingok (a user már szűrt `comment rm`-mel).
 *
 * A hunk hibán EXIT=1 + plain text stderrt ad, strukturált error objektum nélkül
 * — az exit statust ezért MAGUNK ellenőrizzük, elnyelés nélkül.
 *
 * A `context` a HIBASZÖVEGET választja (`review` | `upload`) — lásd
 * noActiveSessionMessage.
 */
export function hunkComments(repoRoot, { context = 'review' } = {}) {
  const res = spawnSync(hunkBin(), hunkCommentsCommand(repoRoot), { encoding: 'utf8' })
  // A NEM TELEPÍTETT bináris ELŐBB, mint a status-ellenőrzés. MÉRT hamis
  // diagnózis: ENOENT-en a spawnSync `status: null`-t ad, amiből a lenti ág
  // "exit null: nincs aktív session"-t csinált — HAZUG, mert a session
  // állapotáról semmit nem tudunk, csak a bináris hiányzik. A fejlesztő a hunk
  // sessiont kezdte volna keresni egy telepítési hiba miatt.
  if (res.error?.code === 'ENOENT') {
    throw new Error(
      'a `hunk` bináris nem indítható — sem a core bundled példánya '
      + '(`node_modules/.bin/hunk`, a `hunkdiff` dependency), sem a PATH-on lévő. '
      + 'Futtass `pnpm install`-t a core-ban. Ezért a review-megjegyzések '
      + 'nem olvashatók ki. Ez NEM session-hiba: a bináris maga hiányzik.\n'
      + 'Mit tegyél: `brew install hunk` (telepíti/PATH-ra teszi), majd próbáld újra.',
    )
  }
  if (res.error) throw new Error(`a hunk nem indult el: ${res.error.message}`)
  if (res.status !== 0) {
    // A "nincs élő session" KÜLÖN hibaosztály: cselekvésre alkalmas üzenet, a
    // nyers `comment list (exit N)` forma NÉLKÜL.
    if (isNoActiveSession(res)) throw new Error(noActiveSessionMessage(repoRoot, context))
    // MINDEN MÁS hunk-hiba a NYERS üzenetre esik vissza: a hamis diagnózis
    // rosszabb, mint a nyers stderr.
    throw new Error(
      `hunk comment list (exit ${res.status}): ${(res.stderr || '').trim() || '(nincs stderr)'}\n`
      + `stdout: ${(res.stdout || '').trim() || '(üres)'}`,
    )
  }
  return parseHunkAgentComments(res.stdout)
}

/** A hunk sessionben LÉVŐ agent-findingok darabszáma — az aiReviewGate mérése. */
export function hunkCommentCount(repoRoot, opts) {
  return hunkComments(repoRoot, opts).length
}

/**
 * A findings feltöltése EGY GitHub review-ként (event=COMMENT).
 * A `--input -` út kell: a comments[] object-tömb, amit a -f/-F field-flagekkel
 * nem lehet összerakni. A --method POST explicit, mert --input mellett a default
 * method GET marad.
 */
export function uploadFindings(pr, comments, { model, user, ...attribution }) {
  const payload = JSON.stringify({
    event: 'COMMENT',
    // Az attribúció (tool / aiGenerated / costUsd / sessionId) ÁTMEGY: az
    // AI-generált findingok body-jában a provenance nem opcionális.
    body: reviewBody({ ...attribution, model, user, count: comments.length }),
    comments: toGithubComments(comments),
  })
  const repo = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { encoding: 'utf8' })
  // A repo-nevet SEM szabad némán elnyelni: üres nwo mellett a `gh api
  // repos//pulls/N/reviews` út 404-et adna, és a hibaüzenet a valódi okot (auth /
  // nem repo-cwd) elfedné.
  const repoSpawnErr = spawnFailure(repo, 'gh')
  if (repoSpawnErr) throw new Error(`a repo neve nem kérdezhető le: ${repoSpawnErr}`)
  if (repo.status !== 0) {
    throw new Error(`a repo neve nem kérdezhető le: ${(repo.stderr || '').trim() || `gh exit ${repo.status}`}`)
  }
  const nwo = repo.stdout.trim()
  if (!nwo) throw new Error('a repo neve üresen jött vissza a gh-tól — a feltöltés célja nem találgatható')
  const res = spawnSync('gh', ['api', `repos/${nwo}/pulls/${pr}/reviews`, '--method', 'POST', '--input', '-'], {
    input: payload,
    encoding: 'utf8',
  })
  // A SPAWN-HIBA ELŐBB: ENOENT-en a `res.stderr` UNDEFINED, tehát a lenti
  // `res.stderr.trim()` maga dobott volna TypeError-t — a user egy
  // "Cannot read properties of undefined" sort kapott volna a valódi ok helyett.
  const postSpawnErr = spawnFailure(res, 'gh')
  if (postSpawnErr) throw new Error(`a review feltöltése nem indítható: ${postSpawnErr}`)
  if (res.status !== 0) {
    // A STDERR ÉS A STDOUT IS KELL, ÉS EZ MÉRT LELET (a user #904-es 422-je): a
    // `gh api` a HTTP-hibát a stderr-re írja ÁLTALÁNOS alakban
    // (`gh: Unprocessable Entity (HTTP 422)`), a GitHub VÁLASZ-BODY-ja viszont —
    // amiben a `message` és az `errors[]` megnevezi a HIBÁS KOMMENTET és a
    // mezőt — a STDOUT-ra megy. A régi kód a stderr-t preferálta (`||`), tehát a
    // user pontosan azt a mondatot kapta, amiből NEM derül ki semmi: nem tudta
    // meg, MELYIK finding, MELYIK mezője buktatta el az EGÉSZ (atomikus) review-t.
    //
    // A 422 KÜLÖN MAGYARÁZATOT KAP: ez a leggyakoribb kimenet ezen az úton, és a
    // három tipikus oka (a `line` nincs a diff-hunkban / rossz `side` / hibás
    // `path`) mind a KOMMENT-POZÍCIÓRA vezet. A nyers body enélkül is ott van, de
    // a diagnózis-irány kimondása órákat spórol.
    const out = (res.stdout || '').trim()
    const err = (res.stderr || '').trim()
    const detail = [err, out].filter((s) => s !== '').join('\n') || '(nincs kimenet)'
    const hint = /\b422\b|Unprocessable/i.test(`${err}\n${out}`)
      ? '\nA 422 ezen az úton szinte mindig KOMMENT-POZÍCIÓ: a `line` nincs a PR '
        + 'diff-hunkjain belül, a `side` (RIGHT/LEFT) nem a mért koordináta-térhez '
        + 'tartozik, vagy a `path` nem a repo-gyökérhez képest relatív. A `comments[]` '
        + 'ATOMIKUS: egyetlen hibás pozíció az EGÉSZ review-t megbuktatja.'
      : ''
    throw new Error(`a review feltöltése nem sikerült (exit ${res.status}): ${detail}${hint}`)
  }
  return JSON.parse(res.stdout)
}

/**
 * Az AI findingok BEÍRÁSA a hunk sessionbe — ez a human-in-the-loop kapu.
 *
 * Miért nem egyenest GitHubra: a review body `verifiedBy` állítása csak akkor
 * igaz, ha a fejlesztő tényleg átnézte a findingokat. A hunk session az a hely,
 * ahol végigmehet rajtuk, törölhet és szerkeszthet — és utána a MEGLÉVŐ 'f' út
 * (hunkComments → toGithubComments → uploadFindings) tölti fel őket, változatlanul.
 *
 * Az `--author` a provenance: a hunk sessionben is látszik, melyik megjegyzést
 * generálta az AI és melyiket írta a fejlesztő.
 */
export function injectHunkComments(repoRoot, findings, { author = 'claude-p' } = {}) {
  let added = 0
  for (const f of findings) {
    const args = [
      'session', 'comment', 'add',
      '--repo', repoRoot,
      '--file', f.filePath,
      '--summary', f.summary,
      '--author', author,
    ]
    if (f.line !== undefined && f.line !== null) {
      args.push(f.side === 'old' ? '--old-line' : '--new-line', String(f.line))
    }
    if (f.rationale) args.push('--rationale', f.rationale)
    const res = spawnSync(hunkBin(), args, { encoding: 'utf8' })
    // A HIÁNYZÓ BINÁRIS külön diagnózis (lásd a hunkComments ENOENT-ágát): a
    // "hunk exit null" azt sugallná, hogy a beírás hasalt el, holott a hunk el
    // sem indult — a fejlesztő a sessiont kezdte volna hibakeresni.
    const spawnErr = spawnFailure(res, 'hunk')
    if (spawnErr) {
      throw new Error(
        `a ${added + 1}. finding beírása nem indítható (${f.filePath}:${f.line}): ${spawnErr} `
        + `${added} finding már bekerült — a hunkban CSAK azokat látod.`,
      )
    }
    // Fail-closed: egy elhasalt beírás után NEM megyünk tovább némán, mert a
    // fejlesztő azt hinné, minden findingot lát a hunkban — és a hiányzót nem
    // tudná, hogy nem látja. A már beírtak számát megmondjuk.
    if (res.status !== 0) {
      // A "nincs élő session" itt is KÜLÖN hibaosztály (ugyanaz a felismerő):
      // a `comment add` ugyanúgy sessiont igényel, mint a `comment list`, és a
      // nyers hunk-stderr ugyanúgy nem mondaná meg, mit tegyen a fejlesztő.
      if (isNoActiveSession(res)) {
        throw new Error(
          `${noActiveSessionMessage(repoRoot, 'review')} `
          + `(a ${added + 1}. finding beírásán bukott el: ${f.filePath}:${f.line}; `
          + `${added} finding került be.)`,
        )
      }
      throw new Error(
        `a ${added + 1}. finding beírása a hunk sessionbe nem sikerült (${f.filePath}:${f.line}): `
        + `${(res.stderr || res.stdout || '').trim() || `hunk exit ${res.status}`}. `
        + `${added} finding már bekerült — a hunkban CSAK azokat látod.`,
      )
    }
    added += 1
  }
  return added
}
