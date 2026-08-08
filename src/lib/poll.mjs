// tuipr — POLL: a háttér-elavultság-ellenőrzés állapotgépe (CSAK JELEZ, nem
// tölt újra) + a staleness-szignatúra + a gh-próbák + a fejléc-sor.
//
// RÉTEGREND: lefelé importál (layout: a fejléc CELLÁBAN mért degradálása; proc:
// a próbák spawnja és a main-SHA). SEMMIT nem importál a core-ból vagy felette —
// a ciklus-tilalom indoklása a bin/tui-core.mjs fejlécében áll.
//
// A MODUL-SZINTŰ INVARIÁNS, amit a test/next-poll.test.ts a fájl EGÉSZÉN mér:
// innen `fetchQueue` NEM hívható, és a reducerek I/O-mentesek (csak a
// fetchStalenessProbe spawnolhat). A poll JELEZ, az újratöltés a user döntése.
import { clampCells, displayWidth } from './layout.mjs'
import { fetchMainSha, fetchMainShaAsync, spawnCollect, spawnFailure } from './proc.mjs'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

// === POLL: háttér-elavultság-ellenőrzés (CSAK JELEZ, nem tölt újra) =========
//
// A PROBLÉMA: a képernyőn álló lista némán öregszik. Amíg a user egy PR-t
// review-ol, a next queue elmozdulhat (valaki pushol, egy PR landol, a main
// előre megy) — és a döntés (approve / merge) egy elavult képen születik. A
// fejléc időbélyege (task 1) megmondja, MIKOR töltöttünk; ez a szekció azt
// mondja meg, hogy AZÓTA VÁLTOZOTT-E valami.
//
// A LEGFONTOSABB TERVEZÉSI DÖNTÉS — A POLL CSAK JELEZ, NEM TÖLT ÚJRA:
// a user kimondott érve, hogy "a kurzor-atrendezes a legrosszabb pillanatban
// (amikor eppen `y`-t akarsz nyomni) veszelyes". Egy magától újratöltő poll a
// lista sorrendjét (és így a kiválasztott sort) A DÖNTÉS PILLANATÁBAN cserélné
// ki: a user a #911-re nézve nyomna `y`-t, és a #905-öt mergelné. Ez az
// állapotgép ezért NEM AD OLYAN KIMENETET, amiből újratöltés következhet — csak
// egy `stale` flaget, amit a fejléc jelez, és amire a user `R`-rel válaszol. A
// modul-szintű invariánst (`fetchQueue` nem hívható innen) teszt őrzi.
//
// A KÖLTSÉG MÉRVE (nem tippelve), a valódi <org> repókon, 3-3 futás:
//   - `gh pr list --json number,updatedAt` (38 nyitott PR):  519 / 681 / 724 ms, 1.9 KB
//   - `gh api repos/.../commits/main -q .sha`:                463 / 461 / 514 ms
//   - a TELJES `tuipr queue --json` (a referencia):      1765 / 1876 ms
// Tehát a próba a teljes újratöltés ~10-25%-a, és a PR-szám alig mozdítja (a
// költség a round-trip, nem a payload). A `files`/`statusCheckRollup` MEZŐK
// KIHAGYÁSA load-bearing: azokkal a próba ugyanannyiba kerülne, mint az
// újratöltés, és akkor semmi értelme nem lenne — teszt tiltja a bekerülésüket.
//
// MIÉRT A LISTÁS `gh pr list` ÉS A LOKÁLIS `git rev-parse` PÁROS, nem a
// `gh api commits/main`: a main-oldalt a `fetchMainSha` MÁR lokálisan olvassa
// (a cache-horgony fele), tehát ingyen van és ugyanazt a referenciát adja, amit
// a cache használ. Két külön main-forrás (lokális ref a cache-nek, GitHub API a
// pollnak) egymással ELLENTMONDHATNA: a poll "elavult"-at jelezne olyan
// elmozdulásra, amit a cache-horgony nem is látott, mert a lokális ref még nem
// volt fetchelve — a user hiába nyomna `R`-t, a jelzés nem múlna el.

/** A poll-intervallum. A user kimondott sávja: 90-120 s. */
export const POLL_INTERVAL_MS = 100_000

/**
 * AZ IDLE-LEÁLLÁS HATÁRA. A user érve: "hogy egy elfelejtett TUI ne pollozzon
 * ejszaka". Nem egy futásidejű optimalizálás, hanem HIGIÉNIA: egy nyitva
 * hagyott TUI különben napokig ütné a GitHub API-t egy olyan lista miatt, amit
 * senki nem néz.
 */
export const POLL_IDLE_TIMEOUT_MS = 15 * 60_000

/**
 * A BACKOFF-LÉPCSŐ hálózati hiba után.
 *
 * MIÉRT NEM SŰRŰBB az alap intervallumnál (teszt is őrzi): egy hálózati hiba
 * ESÉLYE arra, hogy a következő próba is elesik, NAGY — a gyakoribb újrapróbálás
 * ilyenkor csak több elesett hívást jelent, nem hamarabbi sikert. A lépcső a
 * végén MEGÁLL (nem nő a végtelenbe): egy tartósan offline gépen a 20 perces
 * ritmus már elég ritka, viszont a hálózat visszatérésekor még belátható időn
 * belül észreveszi magát.
 */
export const POLL_BACKOFF_MS = [POLL_INTERVAL_MS * 2, POLL_INTERVAL_MS * 6, POLL_INTERVAL_MS * 12]

/**
 * Ennyi EGYMÁS UTÁNI sikertelen próba után jelezzük, hogy nem tudjuk
 * ellenőrizni az elavultságot.
 *
 * MIÉRT NEM AZONNAL (1 hiba): egy pillanatnyi hálózati hiccup (VPN-váltás,
 * elalvás-utáni ébredés) rutinszerű, és minden ilyenre figyelmeztetni azt
 * tanítaná a usernek, hogy a jelzést figyelmen kívül hagyja. MIÉRT NEM SOKKAL
 * KÉSŐBB: a néma "minden rendben" hazugság — ha nem tudunk ellenőrizni, azt ki
 * kell mondani, mielőtt a user egy órányi elavult képre alapoz.
 */
export const POLL_FAILURES_BEFORE_WARNING = 3

/**
 * A POLL ÁLLAPOTA. Tiszta adat; minden léptető függvény új objektumot ad.
 *
 * `signature`   — az utolsó ISMERT kép aláírása (ehhez mérünk);
 * `lastInputAt` — az utolsó user-input ideje (a (c) kapu);
 * `nextDueAt`   — a következő próba legkorábbi ideje;
 * `failures`    — EGYMÁS UTÁNI sikertelen próbák száma;
 * `unverifiable`— jelezzük-e, hogy nem tudunk ellenőrizni;
 * `stale`       — MÉRTÜK, hogy a kép elmozdult.
 *
 * A `stale` és az `unverifiable` KÜLÖN mező, mert KÜLÖN állítás: az egyik TÉNY
 * (mértük az elmozdulást), a másik a TUDÁS HIÁNYA. Egy mezőbe olvasztva
 * valamelyikről hazudnánk.
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
 * USER-INPUT beérkezett: a (c) kapu órája újraindul.
 *
 * AZ IDLE-BŐL VALÓ FELÉLEDÉS itt történik, és a `nextDueAt` ÚJRAÜTEMEZÉSE
 * load-bearing: ha csak a `lastInputAt`-et állítanánk, akkor egy éjszakai
 * szünet után az első gombnyomás AZONNAL kilőne egy próbát (a `nextDueAt` már
 * régen elmúlt) — épp abban a pillanatban, amikor a user elkezd dolgozni.
 * A felélesztés ezért egy TELJES intervallumot ad: a poll a háttérben van, nem
 * az útban.
 */
export function pollNoteInput(st, { now = 0 } = {}) {
  const idle = now - st.lastInputAt > POLL_IDLE_TIMEOUT_MS
  return {
    ...st,
    lastInputAt: now,
    // Csak az idle-ből ÉBREDÉSKOR ütemezünk újra. Egy sima gombnyomás (nem
    // idle) NEM tolhatja ki a próbát, különben egy aktívan gépelő user
    // képénél a poll SOSEM futna le — a folyamatos input örökre elodázná.
    nextDueAt: idle ? now + POLL_INTERVAL_MS : st.nextDueAt,
  }
}

/**
 * A HÁROM KAPU. `null` = mind nyitva (a poll futhat), különben a ZÁRÓ ok.
 *
 * A SORREND DETERMINISZTIKUS (overlay → measuring → idle): ha több kapu is
 * zárva van, ugyanaz az ok jelenik meg minden futáskor. Enélkül a
 * status-szöveg futásonként változna, és egy hibajelentés nem lenne
 * reprodukálható.
 */
export function pollGateReason(st, { overlayOpen = false, measuring = false, now = 0 } = {}) {
  // (a) Nyitott dialógus/overlay: a fókusz a döntésen van. A poll nem szólhat
  // közbe — sem a fejlécben (elvonja a figyelmet), sem I/O-val (lassít).
  if (overlayOpen) return 'overlay'
  // (b) Futó mérés/review: a mérés eredménye épp a cache-be készül, tehát az
  // "elavult" jelzés félrevezető lenne; plusz egy párhuzamos gh-hívás azt
  // lassítja, amire a user VÁR.
  if (measuring) return 'measuring'
  // (c) Idle: nincs friss user-input. A határon MÉG nyitva van (`>`, nem `>=`) —
  // a pontos határ egy teljes intervallumot tudna elnyelni.
  if (now - st.lastInputAt > POLL_IDLE_TIMEOUT_MS) return 'idle'
  return null
}

/**
 * Esedékes-e egy próba MOST. A kapuk ÉS az ütemezés együtt döntenek.
 *
 * A ZÁRT KAPU CSAK KÉSLELTET, NEM HAGY KI: a `nextDueAt`-et a zárás alatt NEM
 * léptetjük, tehát egy hosszú overlay-nyitás után az esedékesség MEGVAN, és a
 * kapu nyitásakor azonnal lefut. Enélkül egy 10 perces info-panelezés után a
 * user órákig nem kapna elavultság-jelzést.
 */
export function pollDue(st, { overlayOpen = false, measuring = false, now = 0 } = {}) {
  if (pollGateReason(st, { overlayOpen, measuring, now }) !== null) return false
  return now >= st.nextDueAt
}

/**
 * A SIKERES próba eredménye.
 *
 * A `changed` KIZÁRÓLAG a `stale` flaget állítja — se újratöltés, se
 * cache-invalidálás nem következik belőle (lásd a szekció fejét).
 *
 * A `stale` EGYIRÁNYÚ: ha egyszer mértük az elmozdulást, a KÖVETKEZŐ próba
 * (ami már az ÚJ aláírást látja "változatlanként") NEM törli. A user képe
 * továbbra is a RÉGI állapotot mutatja — a jelzést csak egy valódi újratöltés
 * (`R` → friss `pollInit`) szünteti meg. Ez a mért csapda-osztály: a
 * "megjelent, majd magától eltűnt" figyelmeztetés rosszabb, mint a semmi.
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
 * A SIKERTELEN próba. Csendben újrapróbál (backoff), és csak
 * POLL_FAILURES_BEFORE_WARNING egymás utáni hiba után jelez.
 *
 * A NYERS hibaszöveget MEGTARTJUK (`lastError`) diagnosztikára, de a fejléc
 * jelzésébe NEM tesszük bele: egy több soros gh/TLS stderr a fejlécet
 * szétvinné (ez a projekt négyszer bejelentett tördelés-osztálya).
 */
export function pollFailure(st, { now = 0, message = null } = {}) {
  const failures = st.failures + 1
  // A lépcső VÉGÉN megáll: a `min` clampeli az indexet, tehát a várakozás a
  // legnagyobb lépésen ragad, nem nő a végtelenbe.
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
 * A FEJLÉC-JELZÉS szövege. Üres string = nincs jelzés.
 *
 * A JÓ ESET CSENDES: a friss kép NEM kap jelzést. A "minden rendben" a jelzés
 * HIÁNYA — egy "friss ✓" felirat minden fejlécben csak zaj, és a valódi
 * jelzést nehezebb lenne kiszúrni benne.
 *
 * A KÉT ÁLLÍTÁS PRIORITÁSA: a MÉRT elavultság erősebb, mint az
 * ellenőrizhetetlenség. Ha egyszer mértük, hogy elmozdult, az a cselekvést
 * kívánó információ (`R`) — az, hogy azóta nem tudunk újra ellenőrizni, nem
 * változtat rajta.
 */
export function pollStatusLabel(st) {
  if (!st) return ''
  if (st.stale === true) return '⟳ elavult — R: frissítés'
  if (st.unverifiable === true) return '⚠ az elavultság nem ellenőrizhető — R: frissítés'
  return ''
}

/**
 * A KÉP ALÁÍRÁSA: a queue PR-halmaza + a PR-onkénti `updatedAt` + a main SHA.
 *
 * MIND A HÁROM benne van, mert HÁROM KÜLÖNBÖZŐ elmozdulás-osztály van, és
 * egyik sem vezethető le a másikból:
 *   1) egy PR TARTALMA változott (push, rebase, komment) → `updatedAt`;
 *   2) a queue TAGSÁGA változott (új PR jött, egy landolt) → a szám-halmaz;
 *   3) a main ELŐRE MENT → a SHA. Ez a PR-ok `updatedAt`-jét NEM mozdítja,
 *      mégis érvényteleníti a merge-tree diagnózisokat.
 *
 * A SORREND-FÜGGETLENSÉG load-bearing: a `gh pr list` sorrendje nem stabil
 * (azonos időbélyegeknél az API sorrendje nem garantált), és egy
 * sorrend-érzékeny aláírás HAMIS elavultságot jelentene. A hamis pozitív itt a
 * legdrágább kár: a user leszokna a jelzésről, és akkor a VALÓDI elavultságot
 * is átnézné. Ezért PR-szám szerint rendezünk.
 */
export function stalenessSignature({ prs = [], mainSha = null } = {}) {
  const parts = (Array.isArray(prs) ? prs : [])
    .map((p) => `${p?.number ?? '?'}@${p?.updatedAt ?? ''}`)
    .sort()
  // A main-SHA HIÁNYA EXPLICIT marker, nem üres string: enélkül egy hiányzó SHA
  // és egy üresre sikerült SHA azonos aláírást adna, tehát a main mozgása
  // láthatatlan maradna. (A fetchMainSha ugyanezt az elvet követi: null, nem "".)
  const sha = typeof mainSha === 'string' && mainSha !== '' ? mainSha : '(nincs-main-sha)'
  return `${sha}|${parts.join(',')}`
}

/**
 * Elmozdult-e a kép. FAIL-CLOSED A HAMIS POZITÍV ELLEN: ha bármelyik aláírás
 * hiányzik, NEM jelentünk változást.
 *
 * MIÉRT EBBE AZ IRÁNYBA (a cache-nél fordítva van!): ott a hamis "friss" volt a
 * drága hiba (elavult diagnózisra alapozott merge), ezért ott a hiányzó horgony
 * SOSEM egyezik. Itt a hamis "elavult" a drága: minden session elején egy
 * alapot nélküli figyelmeztetés jönne (nincs mihez mérni), a user pedig
 * megtanulná átnézni a jelzést. A "nincs mérésem" itt NEM elavultság — a
 * mérés-hibát a `pollFailure` ága viszi, ami N hiba után KI IS MONDJA, hogy nem
 * tud ellenőrizni. Tehát a csend nem néma: a másik ág beszél helyette.
 */
export function stalenessChanged(prev, next) {
  if (typeof prev !== 'string' || prev === '') return false
  if (typeof next !== 'string' || next === '') return false
  return prev !== next
}

/**
 * AZ OLCSÓ PRÓBA: a queue PR-halmaza + a main SHA → aláírás.
 *
 * SOSEM DOB: a poll háttérfolyamat, egy dobás a React effektben unhandled
 * rejectionként végezné. A hibát STRUKTURÁLTAN adja vissza (`{ ok: false,
 * error }`), és a hívó a `pollFailure`-rel lépteti az állapotot.
 *
 * FAIL-CLOSED MINDEN ÁGON (a projekt tanult csapdája): a `res.status`-t ÉS a
 * `res.error?.code`-ot (ENOENT) is ellenőrizzük, a JSON-t parse-oljuk, és a
 * NEM-TÖMB választ (a `gh` részleges GraphQL hibánál exit 0-val `null`-t ír ki!)
 * külön, HANGOS ágon fogjuk. A legdrágább néma hiba itt az lenne, ha a bukott
 * hívásra üres aláírást adnánk: azt a `stalenessChanged` "változatlan"-nak
 * látná, és a poll ÖRÖKRE "minden rendben"-t mutatna, miközben sosem
 * ellenőrzött semmit.
 */
export function fetchStalenessProbe({ label = process.env.NEXT_WORK_NEXT || 'next' } = {}) {
  const parsed = parseStalenessListResult(spawnSync('gh', stalenessProbeArgs(label), { encoding: 'utf8' }))
  if (!parsed.ok) return { ok: false, error: parsed.error }
  // A main-SHA hiánya NEM buktatja a próbát (friss klón, nincs remote ref), de
  // EXPLICIT markerként bekerül az aláírásba — lásd stalenessSignature.
  return { ok: true, signature: stalenessSignature({ prs: parsed.prs, mainSha: fetchMainSha() }), error: null }
}

/**
 * (wf31/44) A NEXT-REBUILD ÁLLAPOTA — a fejléc frissesség-jelzéséhez.
 *
 * MIÉRT KELL A TUI-BAN: a bash `cmd_queue` a rebuild-státuszt a SHELLBE írja
 * (`Next rebuild: success (…)`), ami a fullscreen-módban AZONNAL ELVESZIK — a TUI
 * belép az alt-screenbe, és a sor a primary bufferben marad. A user kérdése
 * pontosan ez volt: "ennek nem a fullscreenben kéne megjelennie?"
 *
 * MIÉRT KÜLÖN PRÓBA, ÉS NEM A `queue --json` MEZŐJE: a `QUEUE_MODEL` egy TÖMB (a
 * PR-ok listája), nem objektum — egy rebuild-mező oda csak a szerződés
 * megtörésével fűzhető be (a `--json` fogyasztói, köztük a Claude-skill, tömböt
 * várnak). A `fetchStalenessProbe` MÁR bejáratott mintát ad: a TUI a saját
 * mérés-csatornáján kérdez, a bash-út érintetlen marad.
 *
 * CSAK A NEM-`success` ÁLLAPOT ÉRDEKES (a user döntése): a sikeres rebuildet nem
 * hirdetjük — ugyanaz az elv, mint a poll-jelzésnél (`⟳ elavult`), ahol a jó
 * állapot a jelzés HIÁNYA. Egy ötödik állandó fejléc-szegmens szűk terminálon
 * mást szorítana ki.
 *
 * FAIL-SOFT MINDEN ÚTON: nincs `gh`, nincs jogosultság, romlott JSON → `null`,
 * és a fejléc egyszerűen nem kap jelzést. Egy rebuild-státusz kedvéért nem
 * buktatjuk a listát.
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
  // A `conclusion` a LEZÁRULT futás eredménye, a `status` a folyamatban lévőé.
  // A sorrend a bash-út (`.[0].conclusion // .[0].status`) MÁSOLATA — a két hely
  // nem csúszhat el, mert ugyanazt a tényt írja le.
  const state = run?.conclusion || run?.status || ''
  if (state === '' || state === 'success') return null
  return { state, at: typeof run?.updatedAt === 'string' ? run.updatedAt : '' }
}

/** A próba argv-je EGY helyen — a szinkron és az aszinkron út nem csúszhat el. */
function stalenessProbeArgs(label) {
  return ['pr', 'list', '--state', 'open', '--label', label, '--limit', '200', '--json', 'number,updatedAt']
}

/** A gh pr list EGYETLEN parse-olója → { ok, prs } vagy { ok: false, error }. */
function parseStalenessListResult(res) {
  const spawnErr = spawnFailure(res, 'gh')
  if (spawnErr) return { ok: false, error: spawnErr }
  if (res.status !== 0) {
    return {
      ok: false,
      error: `gh pr list hiba (exit ${res.status}): ${(res.stderr || res.stdout || '').trim() || '(nincs kimenet)'}`,
    }
  }
  let prs
  try {
    prs = JSON.parse(res.stdout)
  } catch (error) {
    return { ok: false, error: `a gh pr list kimenete nem parse-olható JSON-ként: ${error.message}` }
  }
  // A `null`/objektum válasz NEM "üres queue": az a szerződés megsértése. Az
  // ÜRES TÖMB viszont legitim állapot (nincs nyitott next-PR) — a kettőt a
  // bash oldal is szétválasztja (`jq 'if type == "array"'`).
  if (!Array.isArray(prs)) {
    return { ok: false, error: `váratlan gh pr list válasz (nem tömb): ${JSON.stringify(res.stdout).slice(0, 200)}` }
  }
  return { ok: true, prs }
}

/**
 * A fetchStalenessProbe ASZINKRON párja — BÁJTRA ugyanaz az aláírás és
 * hiba-kontraktus (közös parse-oló és argv), szabad event looppal. A
 * hunk-zárás utáni háttér-reload poll-bázisát ez adja (5/2).
 */
export async function fetchStalenessProbeAsync({ label = process.env.NEXT_WORK_NEXT || 'next' } = {}) {
  const parsed = parseStalenessListResult(await spawnCollect('gh', stalenessProbeArgs(label)))
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, signature: stalenessSignature({ prs: parsed.prs, mainSha: await fetchMainShaAsync() }), error: null }
}

/**
 * A FEJLÉC-SOR összeállítása, DISPLAY-CELLÁBAN mérve és DEGRADÁLVA.
 *
 * MIÉRT TISZTA FÜGGVÉNY, nem string-konkatenáció a render-fában: a fejléc több
 * elemet hordoz (cím, betöltés-időpont, core-SHA, poll-jelzés, notice), és a
 * projekt NÉGYSZER bejelentett hibaosztálya pontosan az, hogy egy hozzáadott elem
 * a szűk terminálon tördel. Így a viselkedés a teljes columns-tartományon
 * unit-tesztelhető, nem csak élő renderben.
 *
 * A DEGRADÁCIÓ SORRENDJE tervezési döntés — a legkevésbé fontos esik ki előbb:
 *   1) a CORE-SHA,
 *   2) a betöltés-időpont,
 *   3) a cím rövidített alakja,
 * és a POLL-JELZÉS MARAD LEGTOVÁBB: az a CSELEKVÉST kívánó információ. Egy
 * fejléc, ami a címet mutatja, de az "elavult" jelzést elhagyja, épp azt veszíti
 * el, amiért a user ránéz.
 *
 * (wf31/28) A `R: refresh` HINT MÁR NINCS A FEJLÉCBEN: a lenti legend (KEYS)
 * mindig hirdeti, tehát a fejléc-példány duplikáció volt (user-lelet: "két helyen
 * jelenik meg, fent és lent. Elég lent").
 *
 * A SHA viszont a BETÖLTÉS-IDŐPONT és a POLL-JELZÉS MÖGÖTT marad: a SHA
 * SESSION-ÁLLANDÓ (egyszer elolvasva a user tudja, mit futtat), az időpont és a
 * jelzés viszont VÁLTOZÓ, a MOSTANI munkáról szóló információ, amit ismételten
 * kell leolvasni. Egy állandót el lehet veszíteni a szűk terminálon; egy
 * változót nem.
 *
 * A `coreSha` NULL/ÜRES esetén a szegmens ELMARAD — nincs "unknown", nincs lógó
 * szeparátor (a `filter` a join előtt dobja). Lásd a fetchCoreSha fejét: a hazug
 * szegmens költségesebb, mint a hiányzó.
 */
/**
 * @param {object} [opts]
 * @param {string} [opts.notice] (wf31/23) A JOBBRA IGAZÍTOTT VISSZAJELZÉS — az
 *   akciók eredménye (`#895: merged`) és az input-válaszok (`megszakítva`).
 *
 *   A USER DÖNTÉSE: a képernyő ALJÁN álló globális status-sor megszűnt ("hülyén is
 *   néz ki ott lent"), és ezek a rövid visszajelzések a FEJLÉCBE kerültek, JOBBRA
 *   igazítva. A pending-jelzés NEM ide tartozik: az a triggerelő legend mellé
 *   került (kontextuálisan, a kulcs mellett).
 *
 *   MIÉRT JOBBRA, ÉS MIÉRT NEM EGY TOVÁBBI `SEP`-SZEGMENS: a fejléc bal oldala
 *   ÁLLANDÓ (cím · időpont · SHA) — a szem ott a rendszer-azonosságot olvassa. Egy
 *   akciónként VÁLTOZÓ szöveg ugyanabban a tömbben minden akció után ELTOLNÁ a bal
 *   oldali szegmenseket, tehát a stabil rész sem lenne stabil. Jobbra igazítva a
 *   két információ-osztály tipográfiailag is szétválik.
 *
 *   A DEGRADÁCIÓ SORRENDJE FORDÍTOTT, mint a bal oldalon: ha nincs hely, a
 *   NOTICE esik ki ELŐBB, nem a cím/SHA. Ok: a notice EFEMER (a következő akció
 *   felülírja), a SHA viszont a képernyő egyetlen helye, ahol a futó kód
 *   azonossága megjelenik — ez a `R: refresh` kiszorításánál már kimondott elv.
 */
export function headerLine({
  loadedAt = null,
  coreSha = null,
  pollLabel = '',
  columns = 80,
  notice = '',
  // (wf31/44) A REBUILD-JELZÉS: `{ state, at }` vagy `null` (nincs mit jelezni).
  // A `fetchRebuildStatus` CSAK a nem-`success` állapotot adja vissza, tehát a
  // `null` a NORMÁL eset — a jó állapotot nem hirdetjük.
  rebuild = null,
} = {}) {
  const limit = Math.max(0, Math.floor(columns))
  const note = typeof notice === 'string' ? notice.trim() : ''
  // (wf31/44) AZ EM DASH UTÁN KÉT SZÓKÖZ — TIPOGRÁFIAI, NEM CELLA-KÉRDÉS.
  //
  // A user leletе: "a »review-munkaállomás« előtti nagykötőjel után legyen szóköz".
  // A forrásban VOLT szóköz (`— r`, kódpontok: 2014 20 72 — mérve), a
  // `displayWidth` is 1 cellát ad az em dashra. A képen mégis `—review` látszik: a
  // font az em dasht a CELLA TELJES szélességében rajzolja (sőt gyakran túl is
  // lóg), tehát a szomszédos szóköz optikailag ELNYELŐDIK.
  //
  // A JAVÍTÁS EGY MÁSODIK SZÓKÖZ, nem szűkebb kötőjel: a `–` (en dash) vagy a `-`
  // megoldaná a rajzolást, de a cím MÁS tipográfiai súlyt kapna — az em dash a
  // „cím — alcím" bejáratott alakja. A cella-aritmetika sértetlen: a `displayWidth`
  // a szóközt is 1-nek méri, tehát a degradáció (jelölt-lista) helyesen számol.
  const TITLE = 'next queue —  review-munkaállomás'
  const SHORT_TITLE = 'next queue'
  const SEP = '  ·  '
  const label = typeof pollLabel === 'string' ? pollLabel : ''
  // BETÖLTÉS ALATT A FEJLÉC CSAK A CÍM + SHA (user-kérés): a `betöltés…` a
  // fejlécben DUPLIKÁLTA a lenti, önálló betöltés-feliratot, a `R: refresh`
  // pedig egy MÉG NEM LÉTEZŐ listára hivatkozott — mindkettő zaj.
  const loading = !loadedAt
  const stamp = loadedAt ? `betöltve: ${loadedAt}` : ''
  // A CSUPA-WHITESPACE SHA is "nincs SHA": a `.source-sha`/`package.json` úton
  // egy szóközös fájl-tartalom különben egy néma, üres szegmenst adna (" core  ·").
  const sha = typeof coreSha === 'string' && coreSha.trim() !== '' ? `core ${coreSha.trim()}` : ''
  // (wf31/44) A REBUILD-JELZÉS SZEGMENSE. A `⚠` TEXT-alak (1 cella — mérve), nem
  // az emoji `⚠️` (2 cella): a projekt kimondott döntése, hogy a cella-aritmetika
  // ne csússzon el (lásd a `rows.mjs` flag-fejezetét).
  //
  // AZ IDŐPONT RÖVIDÍTVE: a teljes ISO-stamp (`2026-08-05T02:30:16Z`) 20 cella, ami
  // a fejléc legszűkebb szegmenseinek kétszerese. A DÁTUM+ÓRA elég a döntéshez
  // („mikori a kép?"), a másodperc nem — ez ugyanaz a tömörítés, amit a
  // `betöltve:` szegmens is alkalmaz (ott HH:MM:SS, mert az MA van).
  const rebuildNote = rebuild && typeof rebuild.state === 'string' && rebuild.state !== ''
    ? `⚠ rebuild: ${rebuild.state}${typeof rebuild.at === 'string' && rebuild.at !== '' ? ` (${rebuild.at.slice(0, 16).replace('T', ' ')})` : ''}`
    : ''

  // A JELÖLTEK a legbővebbtől a legszűkebbig. Az ELSŐ, ami CELLÁBAN befér,
  // nyer. A lista explicit (nem gépi kombinatorika): a degradáció sorrendje
  // TERVEZÉSI döntés, és így olvasható is marad.
  const candidates = loading
    ? [
        // Betöltés alatt: cím + SHA (+ poll-jelzés, ha van). Se stamp, se refresh.
        [TITLE, sha, label],
        [TITLE, sha],
        [SHORT_TITLE, sha],
        [TITLE],
        [SHORT_TITLE],
      ]
    : [
    // (wf31/28) A `R: refresh` HINT KIVEZETVE A FEJLÉCBŐL — a user kérése: "A
    // »R: refresh« most két helyen jelenik meg, fent és lent. Elég lent."
    //
    // A LENTI LEGEND (KEYS) MINDIG HIRDETI, tehát a fejléc-példány tiszta
    // duplikáció volt. A korábbi indoklás (a SHA a hint ELŐTT áll, mert a hint
    // máshol is megvan) MÁR EZT A KÖVETKEZTETÉST TARTALMAZTA — csak félúton állt
    // meg: ha a hint máshol is megvan, akkor nem csak a SHA MÖGÉ kell tenni,
    // hanem el is lehet hagyni. A helyet a `notice` kapja meg (jobbra igazítva).
    // A REBUILD-JELZÉS a SHA UTÁN, a poll-jelzés ELŐTT: mindkettő
    // FRISSESSÉG-információ, de a poll a KÉP elavultságát mondja (amit az `R`
    // orvosol), a rebuild pedig a NEXT BRANCH-ét (amit a CI). A poll marad
    // legtovább — az a közvetlenül cselekvést kívánó jelzés.
    [TITLE, stamp, sha, rebuildNote, label],
    [TITLE, stamp, sha, label],
    [TITLE, stamp, rebuildNote, label],
    [TITLE, stamp, label],
    [TITLE, label],
    [SHORT_TITLE, label],
    // A jelzés EGYEDÜL: a legszűkebb ág, ahol a cím is elveszik. Ha van jelzés,
    // az fontosabb, mint a cím (a user tudja, milyen programot néz).
    [label],
    [TITLE, stamp],
    [TITLE],
    [SHORT_TITLE],
  ]
  // (wf31/23) A NOTICE JOBBRA IGAZÍTÁSA. A `GAP` a minimális hézag a bal oldali
  // blokk és a notice között — enélkül szűk terminálon a kettő ÖSSZEÉRNE, és egy
  // `…core abc123megszakítva` alakú, olvashatatlan sor jönne ki.
  const GAP = 2
  const noteRoom = note === '' ? 0 : displayWidth(note) + GAP
  const render = (parts) => parts.filter((p) => typeof p === 'string' && p !== '').join(SEP)
  // (wf31/27) KÉT TELJES KÖR, NEM JELÖLTENKÉNTI ELÁGAZÁS.
  //
  // MÉRT HIBA volt a jelöltenkénti alak (a user leletéből: a `20 PR a queue-ban`
  // NEM jelent meg): a ciklus az ELSŐ jelöltnél elfogadta a notice NÉLKÜLI sort,
  // tehát a szűkebb jelöltekig SOSEM jutott el. 100 cellás táblánál a
  // `[cím·időpont·SHA·R: refresh]` alak 87 cella, a notice +19 → nem fér; a
  // notice nélkül viszont befér, és a ciklus ott meg is állt. A notice így akkor
  // is elveszett, amikor egy SZŰKEBB bal oldal (pl. `R: refresh` nélkül) mellett
  // KIFÉRT volna.
  //
  // AZ ELSŐ KÖR: MINDEN jelölt a notice-szal. A degradáció így a bal oldalt
  // szűkíti, hogy a notice kiférjen — épp azt a sorrendet adva, amit a user kért
  // (a felirat a tábla szélén legyen).
  //
  // A MÁSODIK KÖR: a notice nélkül. Ide csak akkor jutunk, ha a notice EGYETLEN
  // bal oldali alak mellett sem fér ki — ilyenkor a cím/SHA nyer, mert a notice
  // EFEMER (a következő akció felülírja), a rendszer-azonosság viszont nem.
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
  // Semmi sem fért be (extrém szűk terminál): a CÍMET csonkoljuk cellában. A
  // clampCells a VS16-os lookaheadot is helyesen kezeli (lásd a fejét).
  return clampCells(label !== '' ? label : SHORT_TITLE, limit)
}

