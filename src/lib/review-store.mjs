// tuipr — REVIEW-STORE: a review-eredmények DISZK-CACHE-E (/tmp).
//
// A USER KÉRÉSE (szó szerint): "a review-kat cache-elje diszkre az app, mert
// fárasztó mindig újraindítani. /tmp-be elég szerintem, az magától törlődik
// majd."
//
// RÉTEGREND: NULLA projekt-import, csak node-builtinok — ugyanaz a szint, mint a
// `proc.mjs`. Ez szándékos: a fogyasztója az app-réteg, tehát bármelyik
// core-modulból hívható lenne, és a felfelé-import (pl. a cache.mjs-ből) azonnal
// ciklus-veszélyt szülne. A ciklus-tilalom indoklása a
// bin/tui-core.mjs fejlécében áll, a gépi őr a
// scripts/check-next-modules.mjs.
//
// MIÉRT KÜLÖN MODUL, ÉS MIÉRT NEM A cache.mjs-BEN:
// a `cache.mjs`-nek GÉPILEG ŐRZÖTT NULLA-I/O INVARIÁNSA van — a
// test/next-cache.test.ts a fájl EGÉSZÉT beolvassa, és tiltja benne a
// `spawnSync`/`spawn`/`readFileSync`/`writeFileSync` hívásokat. Nem formalitás:
// a cache jelző-előállítói (cacheState, cacheIndicatorFlag) MINDEN renderben,
// MINDEN sorra lefutnak, tehát egy ott elhelyezett fájl-I/O PR-onként egy
// syscallt jelentene minden képkockán — pontosan az a lassulás, ami ellen a
// cache egyáltalán készült. A perzisztencia ezért külön rétegben él, és a
// render-úton továbbra is a memória-cache áll.
//
// A MEMÓRIA-CACHE SZEREPE VÁLTOZATLAN (a next-cache.test.ts fejlécének
// "nem lemezen" indoklása ARRA a cache-re vonatkozik, és érvényben van): a
// DIAGNÓZIS-mérések session-idejűek maradnak, mert a next kép óránként mozog. Ez
// a modul KIZÁRÓLAG a REVIEW-EREDMÉNYT perzisztálja, ami MÁS természetű adat:
// KIFIZETETT (tokent költött), és nem a queue-állapotról szól, hanem a PR
// diffjéről — tehát pontosan addig érvényes, ameddig a horgony áll.
//
// A HORGONY HÁROM FELE — DE NEM EGYENRANGÚAK, és ez a rangsor a lelke ennek a
// modulnak. KÉT FÉL a review TÁRGYÁT (a diffet) írja le, a HARMADIK a review
// SZERSZÁMÁT (a mérő kódot):
//
//   A TÁRGY (BLOKKOLÓ — eltérése betöltés-tilalom):
//   1) a PR `updatedAt` — új push/rebase: a reviewolt diff már nem ez;
//   2) a trunk (`origin/<main|dev>`, lásd trunkBranch) SHA — a diff a trunk
//      ELLEN értelmezett, tehát a trunk elmozdulása a review TÁRGYÁT
//      változtatja meg, a PR-t nem érintve.
//
//   A SZERSZÁM (NEM BLOKKOLÓ — eltérése JELZÉS, `tool-drift`):
//   3) a CORE SHA — MÁS KÓD futtatta a review-t.
//
// MIÉRT NEM BLOKKOL A CORE SHA (MÉRT LELET, a user leletéből — a #904 review a
// lemezen ült, séma-helyesen, egyező `updatedAt`-tel és `mainSha`-val, mégsem
// töltődött be): a `fetchCoreSha` élesben a FUTÓ TUI git HEAD-jét adja. A core
// FEJLESZTÉS ALATT van, tehát MINDEN core-commit — még egy komment-átfogalmazás
// is — GLOBÁLISAN invalidálta MINDEN repo MINDEN cache-elt review-ját. A cache
// így gyakorlatilag SOSEM élte meg a következő indítást, azaz pontosan azt a
// panaszt hozta vissza, amiért készült ("fárasztó mindig újraindítani").
//
// ÉS AMIÉRT ELVBEN IS HELYES ÍGY: a findingok a PR DIFFJÉRŐL szóló állítások.
// Ha a mérő kód verziója változik, a findingok NEM lesznek hamis állítások —
// legfeljebb egy MAI review MÁS findingot is adna. Ez FENNTARTÁS, nem
// érvénytelenség; a kifizetett (tokenbe került) eredmény eldobása aránytalan
// válasz rá. A SÉMA-KOMPATIBILITÁS — az eredeti indoklás, "más kód más sémát
// adhat" — NEM ezen a horgonyon áll, hanem a `REVIEW_STORE_SCHEMA`-n: az alak
// változásakor AZT növeljük, és a régi bejegyzés `null` lesz (lásd ott).
//
// A KÜLÖNBSÉG A UI-BAN LÁTSZIK, NEM ELHALLGATVA: a drift-es bejegyzés findingjai
// BETÖLTŐDNEK, de a panel `caveat`-sora kimondja, hogy MÁS core-verzió mérte —
// ugyanaz a "látszik, de a fenntartást nem hallgatjuk el" minta, amit a
// degradált review-utak caveat-je használ.
//
// FAIL-SOFT MINDEN ÚTON, és ez SZERZŐDÉS: ez egy KÉNYELMI réteg. Nem írható
// /tmp, romlott JSON, olvashatatlan fájl, séma-eltérés → a hívó `null`/`false`-t
// kap, a TUI a memória-cache-re esik vissza, és a UI-ba NEM megy nyers hiba. A
// review eredménye a memóriában MEGVAN; egy dobás a perzisztálás kedvéért épp a
// KIFIZETETT eredményt vinné el.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/**
 * A GYŰJTŐ-KÖNYVTÁR neve a TMPDIR alatt.
 *
 * MIÉRT /tmp (a user döntése, kimondott indokkal): "az magától törlődik majd".
 * A review-cache-nek nem is kell tovább élnie — egy hetekig őrzött bejegyzés
 * horgonya szinte biztosan elavult, tehát csak helyet foglalna. Az OS-szintű
 * takarítás így pont a helyes lejárati politika, ingyen.
 */
export const REVIEW_STORE_DIR_NAME = 'tuipr-review-cache'

/**
 * A SÉMA-VERZIÓ. NÖVELD, ha a bejegyzés ALAKJA (nem a tartalma) változik.
 *
 * MIÉRT NEM KONVERTÁLUNK a régi alakról: a review ÚJRAFUTTATHATÓ, egy
 * félreértelmezett finding viszont HAMIS ÁLLÍTÁS a kódról — és pont azt a
 * bizalmat rontja el, amiért a review készült. Az ismeretlen séma tehát `null`
 * (mintha nem lenne bejegyzés), nem találgatott migráció.
 *
 * EZ AZ EGYETLEN SÉMA-KAPU, és ez KÖTELEM: a `coreSha` horgony ELVESZTETTE ezt a
 * szerepet (lásd a fejléc rangsorát — az MOST már csak jelez). Ha tehát a
 * finding-objektumok ALAKJÁN változtatsz (mezőt átnevezel, jelentést váltasz),
 * ITT KELL növelni — a core-commit maga NEM fogja többé érvényteleníteni a régi
 * bejegyzéseket. A "majd a core-SHA elmozdul és megvéd minket" feltevés innentől
 * HAMIS.
 */
export const REVIEW_STORE_SCHEMA = 1

/** A repo-azonosító hash hossza. 12 hex karakter: az ütközés esélye elhanyagolható. */
const REPO_KEY_LEN = 12

/**
 * A CACHE-GYÖKÉR FELÜLÍRÁSA — TESZT-HORGONY, és szándékosan NEM a `TMPDIR`-en.
 *
 * MIÉRT KELL, ÉS MIÉRT MÉRT CSAPDA A TMPDIR-ÁTÁLLÍTÁS (ez a bug MEGTÖRTÉNT, a
 * teljes suite-on mérve — 31 teszt bukott el egyszerre): az első teszt-változat a
 * `process.env.TMPDIR`-t irányította egy tempdirbe, majd a `finally`-ben
 * visszaállította és a könyvtárat eldobta. Csakhogy a render-harness MINDEN
 * stubja (`bash`, `git`, `gh`, `hunk`, `claude`) is `os.tmpdir()` ALÁ készül —
 * ami UGYANEZT a `TMPDIR`-t olvassa. A globális env átírása tehát MÁS tesztek
 * stub-könyvtárait terelte el, és azok némán elvesztek: a hibák a
 * MELLÉKHATÁSTÓL függtek, nem a tesztelt viselkedéstől, és izoláltan futtatva
 * mind zöld volt. Egy globális env-változó process-szinten OSZTOTT állapot —
 * egy PARAMÉTER nem az.
 */
let baseOverride = null

/** A cache-gyökér átállítása (teszt). `null` visszaáll a `${TMPDIR:-/tmp}`-re. */
export function setReviewStoreBase(dir) {
  baseOverride = typeof dir === 'string' && dir !== '' ? dir : null
}

/** A `${TMPDIR:-/tmp}` szemantika, futásidőben olvasva. */
function tmpBase() {
  if (baseOverride !== null) return baseOverride
  // A `os.tmpdir()` MAGA is a TMPDIR-t olvassa, de a trailing separatort
  // normalizálja is — ezért ezt használjuk, nem a nyers env-változót.
  return os.tmpdir()
}

/**
 * A REPO AZONOSÍTÓJA: a gyökér-út rövid, determinisztikus hashe.
 *
 * MIÉRT HASH, és nem a nyers út (KÉT ok, mindkettő load-bearing):
 *   1) IZOLÁCIÓ: a user egyszerre több checkoutban dolgozik (élő `packages/*`,
 *      plusz worktree-k a PR-munkához). Ha a kulcs csak a PR-szám lenne, a #911
 *      review-ja az EGYIK repóból a MÁSIKBAN jelenne meg — más kód, más diff,
 *      ugyanaz a szám. Ez néma, félrevezető adat.
 *   2) BIZTONSÁG: egy nyers, szeparátorokat tartalmazó út a /tmp alatt
 *      tetszőleges mély fába (vagy `..`-ral azon KÍVÜLRE) írhatna. A hash
 *      GARANTÁLTAN egy könyvtár-szint, és `[0-9a-f]`-en kívül nincs benne semmi.
 *
 * DETERMINISZTIKUS: ugyanaz az út ugyanazt a kulcsot adja — enélkül a cache
 * minden induláskor elveszne, ami épp a user panaszát hozná vissza.
 */
function repoKey(repoRoot) {
  const src = typeof repoRoot === 'string' && repoRoot !== '' ? repoRoot : '(nincs-repo-gyoker)'
  return crypto.createHash('sha256').update(src).digest('hex').slice(0, REPO_KEY_LEN)
}

/** A repo bejegyzéseinek könyvtára. */
export function reviewStoreDir({ repoRoot } = {}) {
  return path.join(tmpBase(), REVIEW_STORE_DIR_NAME, repoKey(repoRoot))
}

/** EGY PR bejegyzésének útja. */
export function reviewStorePath({ repoRoot, pr } = {}) {
  // A PR-szám SZÁMKÉNT normalizálva kerül a fájlnévbe: egy `../x` alakú "pr"
  // különben útvonal-kilépést adna. A `Number` + `Math.trunc` után csak
  // számjegy (és esetleg `-`) marad.
  const n = Number.isFinite(Number(pr)) ? Math.trunc(Number(pr)) : 0
  return path.join(reviewStoreDir({ repoRoot }), `${n}.json`)
}

/**
 * A HORGONY összeállítása a három félből, a hiányzót `null`-ra normalizálva.
 *
 * MIND A HÁROM FÉL BENNE MARAD — a `coreSha` IS, noha nem blokkol: a
 * `tool-drift` jelzéshez PONTOSAN azt kell tudni, MELYIK core-verzió mérte a
 * bejegyzést, és ez az adat csak akkor van meg, ha KIÍRJUK. Egy "nem blokkol,
 * tehát ne is mentsük" lépés a jelzést tenné lehetetlenné (és a diagnosztikát is:
 * egy régi bejegyzésről utólag megállapítható, milyen kód készítette).
 *
 * AZ ÜRES STRING IS "NEM TUDHATÓ": ha csendben `''`-re vinnénk, két KÜLÖNBÖZŐ
 * állapotban mért bejegyzés horgonya EGYEZNE, tehát egy elavult review-t
 * "friss"-nek mutatnánk. Ez a memória-cache `cacheAnchor`-jának ugyanaz a
 * fail-closed doktrínája.
 */
export function reviewStoreAnchor({ row, mainSha, coreSha } = {}) {
  const norm = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null)
  return {
    updatedAt: norm(row?.updatedAt),
    mainSha: norm(mainSha),
    coreSha: norm(coreSha),
  }
}

/**
 * A TÁRGY-FELEK — a review-t ÉRVÉNYTELENÍTŐ horgony-mezők (lásd a fejlécet).
 * Konstansként, mert a mező-lista MINDKÉT olvasón (`subjectMatches` és a
 * hiány-ellenőrzés) végigmegy, és két helyre beírva szétcsúszhatna.
 */
const SUBJECT_KEYS = ['updatedAt', 'mainSha']

/**
 * A TÁRGY-HORGONY egyezése — a review-t ÉRVÉNYESSÉ tevő feltétel.
 * HIÁNYZÓ (null) fél SOSEM egyezik — még önmagával sem.
 *
 * FAIL-CLOSED: inkább újramérünk (a review újrafuttatható), mint hogy a
 * frissességről hazudjunk. Egy "friss"-nek mutatott, valójában elavult review a
 * legdrágább hiba ebben a rendszerben: a user annak alapján approve-ol.
 *
 * A `coreSha` ITT NEM SZEREPEL — az a SZERSZÁM, nem a tárgy (a fejléc
 * rangsora). Az eltérése a `toolDrifted`-en jelez, és NEM tilt betöltést.
 */
function subjectMatches(a, b) {
  if (!a || !b) return false
  for (const k of SUBJECT_KEYS) {
    if (a[k] === null || a[k] === undefined) return false
    if (b[k] === null || b[k] === undefined) return false
    if (a[k] !== b[k]) return false
  }
  return true
}

/**
 * ELMOZDULT-E A SZERSZÁM: MÁS core-verzió mérte a bejegyzést, mint ami MOST fut.
 *
 * A HÁROM ÁG, és mind a három szándékos:
 *   - mindkét oldal ISMERT és KÜLÖNBÖZIK → `true` (ez a jelzendő eset);
 *   - mindkét oldal ISMERT és EGYEZIK    → `false` (nincs mit jelezni);
 *   - BÁRMELYIK oldal NEM TUDHATÓ (null) → `false`.
 *
 * A HARMADIK ÁG NEM fail-closed, és ez KÜLÖNBÖZIK a tárgy-horgony doktrínájától
 * — szándékosan. A `toolDrifted` egy FIGYELMEZTETÉS-jelző, nem egy kapu: ha nem
 * tudjuk, hogy elmozdult-e, egy "MÁS core-verzió mérte" felirat ÁLLÍTÁS lenne
 * arról, amit nem mértünk (a nem-git checkoutban a `fetchCoreSha` `null`-t ad).
 * A hamis figyelmeztetés zaj, ami leszoktatja a usert a caveat-ek olvasásáról —
 * és pont azokat az igazi caveat-eket devalválja, amiket a degradált
 * review-utak írnak. A TÁRGY-oldalon a fail-closed a helyes, mert ott a tévedés
 * költsége egy hazug "friss" review; ITT a tévedés költsége egy hazug intelem.
 */
function toolDrifted(a, b) {
  const x = a?.coreSha ?? null
  const y = b?.coreSha ?? null
  if (x === null || y === null) return false
  return x !== y
}

/**
 * Egy review-eredmény KIÍRÁSA. `true` sikeren, `false` MINDEN hibán.
 *
 * AZ `applied` FLAG SOSEM MEGY KI A LEMEZRE (a task explicit kikötése, valódi
 * indokkal): a hunk-session REPO-szintű, és a TUI-val együtt meghal. Egy
 * perzisztált `applied: true` a KÖVETKEZŐ indításban azt hazudná, hogy a
 * findingok már a sessionben vannak — az új, ÜRES session betöltés nélkül
 * maradna, és a note-ok "eltűnnének". Pontosan ez volt a user 5/3-as leletének
 * magja, csak most a folyamat-határon átnyúlva. A paraméter azért FOGADOTT
 * (és eldobott), hogy a hívó a memória-cache bejegyzését VÁLTOZTATÁS NÉLKÜL
 * átadhassa — így nem a hívási helyeken kell emlékezni a szabályra.
 *
 * ATOMI ÍRÁS (tmp fájl + rename): egy félbeírt JSON pont azt a romlott
 * bejegyzést adná, amit az olvasó oldalon fail-softtal kezelünk — de jobb nem
 * előállítani. A `rename` ugyanazon a filesystemen atomi.
 */
export function reviewStoreWrite({ repoRoot, pr, anchor, findings, summary = null } = {}) {
  try {
    if (!Array.isArray(findings)) return false
    const dir = reviewStoreDir({ repoRoot })
    fs.mkdirSync(dir, { recursive: true })
    const target = reviewStorePath({ repoRoot, pr })
    const body = JSON.stringify({
      schema: REVIEW_STORE_SCHEMA,
      // A HORGONY a három félből, normalizálva — nem a hívó nyers objektuma.
      anchor: {
        updatedAt: anchor?.updatedAt ?? null,
        mainSha: anchor?.mainSha ?? null,
        coreSha: anchor?.coreSha ?? null,
      },
      pr: Number(pr),
      summary: typeof summary === 'string' ? summary : null,
      findings,
      // MIKOR írtuk — diagnosztikai adat (a fájl mtime-ja is ezt adja, de a
      // /tmp-t takarító OS-eszközök néha átírják). NEM a horgony része.
      writtenAt: new Date().toISOString(),
    })
    // Az `.tmp` ugyanabban a könyvtárban van, hogy a rename ne filesystem-határon
    // menjen át (ott nem atomi, és EXDEV-vel el is hasalhat).
    const tmp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(tmp, body, { mode: 0o600 })
    fs.renameSync(tmp, target)
    return true
  } catch {
    // FAIL-SOFT: nem írható /tmp (read-only mount, kvóta, sandbox), tele disk.
    // A review MEGVAN a memóriában — egy dobás itt a kifizetett eredményt vinné
    // el a perzisztálás kedvéért.
    return false
  }
}

/** Egy nyers bejegyzés → validált alak, vagy `null`. A séma-kaput ITT zárjuk. */
function parseEntry(raw) {
  let obj
  try {
    obj = JSON.parse(raw)
  } catch {
    return null // ROMLOTT JSON (félbeírás, /tmp-takarítás közbeni olvasás)
  }
  if (!obj || typeof obj !== 'object') return null
  // A SÉMA-KAPU: ismeretlen/régi verzió → mintha nem lenne bejegyzés (lásd a
  // REVIEW_STORE_SCHEMA fejét: nem találgatunk migrációt).
  if (obj.schema !== REVIEW_STORE_SCHEMA) return null
  if (!Array.isArray(obj.findings)) return null
  return {
    anchor: {
      updatedAt: obj.anchor?.updatedAt ?? null,
      mainSha: obj.anchor?.mainSha ?? null,
      coreSha: obj.anchor?.coreSha ?? null,
    },
    findings: obj.findings,
    summary: typeof obj.summary === 'string' ? obj.summary : null,
    writtenAt: typeof obj.writtenAt === 'string' ? obj.writtenAt : null,
  }
}

/**
 * A bejegyzés + az ÁLLAPOTA a MOSTANI horgonyhoz mérve.
 *
 * `null` — nincs bejegyzés, vagy nem értelmezhető (romlott / idegen séma /
 *          olvashatatlan). A hívó ilyenkor úgy viselkedik, mint eddig.
 * `{ state: 'fresh',      loadable: true,  toolDrift: false, … }`
 *          — a TÁRGY-horgony egyezik, és ugyanez a core-verzió mérte.
 * `{ state: 'tool-drift', loadable: true,  toolDrift: true,  … }`
 *          — a TÁRGY-horgony egyezik (a diff UGYANAZ), de MÁS core-verzió
 *            mérte. BETÖLTHETŐ, a fenntartást a UI kimondja (lásd a fejlécet).
 * `{ state: 'stale',      loadable: false, toolDrift: …,     … }`
 *          — VAN eredmény, de a TÁRGY (a diff) elmozdult: NEM betölthető.
 *
 * A `state` HÁROM ÉRTÉKŰ, a `loadable` viszont KÉT ÉRTŰ — és ez a szétválasztás
 * SZÁNDÉKOS: az ÁLLAPOT (mit tudunk a bejegyzésről) és a DÖNTÉS (betöltsük-e)
 * eddig egybeesett, most nem. A hívó, akit csak a döntés érdekel, továbbra is a
 * `loadable`-t olvassa, és a harmadik állapot megjelenése NEM törte el —
 * a `toolDrift` boolean pedig annak való, aki a fenntartást KI IS ÍRJA.
 *
 * MIÉRT NEM TÖRLÜNK ELAVULTSÁGNÁL (a memória-cache doktrínája, itt is): a
 * listán jelezni kell, hogy VAN mért eredmény, csak már nem érvényes (a `~`
 * jel). A törlés ("nincs review") és az elavulás ("volt, de a bázis elmozdult")
 * MÁS teendőt jelent a usernek.
 *
 * AZ `applied` MINDIG HAMIS: lemezről jövő bejegyzés definíció szerint "nem
 * betöltött" (a hunk-session nem élte túl a folyamatot) — így a megnyitás
 * (wf31/6 óta a `d`) újratölti, a session-identitáshoz kötött, MÁR MEGLÉVŐ
 * logikán.
 */
export function reviewStoreRead({ repoRoot, pr, anchor } = {}) {
  let raw
  try {
    raw = fs.readFileSync(reviewStorePath({ repoRoot, pr }), 'utf8')
  } catch {
    // NINCS FÁJL és OLVASHATATLAN FÁJL ugyanaz a válasz: nincs használható
    // bejegyzés. A kettő szétválasztása a hívónak semmit nem adna.
    return null
  }
  const entry = parseEntry(raw)
  if (!entry) return null
  const subjectOk = subjectMatches(entry.anchor, anchor)
  const drift = toolDrifted(entry.anchor, anchor)
  return {
    pr: Number(pr),
    anchor: entry.anchor,
    findings: entry.findings,
    summary: entry.summary,
    writtenAt: entry.writtenAt,
    state: subjectOk ? (drift ? 'tool-drift' : 'fresh') : 'stale',
    // A BETÖLTHETŐSÉG a TÁRGY-horgonyhoz kötött: elavult DIFFRE NEM töltünk
    // findingot (az a kódról szóló, MÁR NEM ÉRVÉNYES állítás lenne). A
    // szerszám-drift viszont NEM tilt — a findingok a diffről szólnak, ami áll.
    loadable: subjectOk,
    // A FENNTARTÁS a `loadable`-tól FÜGGETLENÜL utazik: a stale bejegyzésen is
    // igaz lehet, és a lista-jelzés (ami a stale-t is mutatja) tudhat róla.
    toolDrift: drift,
    // SOSEM perzisztált — lásd a reviewStoreWrite fejét.
    applied: false,
  }
}

/**
 * A bejegyzés TÖRLÉSE (az elvetés útja). `true`, ha volt mit törölni.
 *
 * MIÉRT KELL A LEMEZRŐL IS TÖRÖLNI: a dupla-`x` elvetés az `r` újraindításának
 * ELŐFELTÉTELE (szándékos súrlódás a véletlen dupla-költés ellen). Ha a lemezen
 * maradna, a KÖVETKEZŐ indításban az elvetett findingok visszatérnének — a user
 * explicit döntését vonná vissza némán a cache.
 *
 * IDEMPOTENS és FAIL-SOFT: nem létező bejegyzésre `false`, hibára `false` —
 * dobás nélkül. Az elvetés a memóriában MEGTÖRTÉNT; egy dobás itt a UI-t vinné
 * el egy takarítási művelet miatt.
 */
export function reviewStoreDelete({ repoRoot, pr } = {}) {
  try {
    fs.unlinkSync(reviewStorePath({ repoRoot, pr }))
    return true
  } catch {
    return false
  }
}

/**
 * A repo MINDEN bejegyzése, PR-számra kulcsolva — a TUI-indítás LAZY betöltése.
 *
 * MIÉRT KELL EGY KÖTEGES OLVASÓ: a lista-jelzőhöz tudni kell, MELY PR-oknak van
 * cache-elt findingja. PR-onkénti `reviewStoreRead` a render-úton
 * sor-onkénti fájl-I/O lenne minden képkockán — pontosan az, amit a cache
 * elkerülni akar. Ez EGYSZER fut (induláskor), és a hívó egy sima objektumot
 * kap, amin a soronkénti munka egy index-lekérés.
 *
 * A HORGONY-ELLENŐRZÉS NEM ITT TÖRTÉNIK: induláskor a mostani horgony
 * PR-onként MÁS (az `updatedAt` a queue-ból jön, ami ekkor még nincs is
 * betöltve). A hívó a queue megérkezése után dönt a frissességről — a
 * bejegyzés a saját horgonyát HORDOZZA, tehát az összevetés utólag is
 * elvégezhető, új fájl-olvasás nélkül.
 *
 * PER-BEJEGYZÉS FAIL-SOFT: egy romlott fájl a könyvtárban a TÖBBIT nem viszi
 * el. A régi (mindent egyben olvasó) minta itt azt jelentette volna, hogy egy
 * félbeírt fájl az ÖSSZES cache-elt review-t érvényteleníti.
 */
export function reviewStoreLoadAll({ repoRoot } = {}) {
  const out = {}
  let names
  try {
    names = fs.readdirSync(reviewStoreDir({ repoRoot }))
  } catch {
    // NINCS KÖNYVTÁR: első indítás ezzel a repóval. NEM hiba.
    return out
  }
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name)
    if (!m) continue // `.tmp` maradék, idegen fájl: átlépjük
    let raw
    try {
      raw = fs.readFileSync(path.join(reviewStoreDir({ repoRoot }), name), 'utf8')
    } catch {
      continue
    }
    const entry = parseEntry(raw)
    if (!entry) continue
    out[Number(m[1])] = {
      pr: Number(m[1]),
      anchor: entry.anchor,
      findings: entry.findings,
      summary: entry.summary,
      writtenAt: entry.writtenAt,
      // SOSEM perzisztált: indításkor MINDEN bejegyzés "nem betöltött", tehát a
      // megnyitás (wf31/6 óta a `d`) újratölt (a session-identitáshoz kötött,
      // meglévő logika).
      applied: false,
    }
  }
  return out
}

/**
 * Egy BETÖLTÖTT (loadAll-ból jött) bejegyzés állapota a mostani horgonyhoz:
 * `'none'` | `'fresh'` | `'tool-drift'` | `'stale'` — a `reviewStoreRead`
 * `state`-jével AZONOS szótár (ugyanaz a két predikátum dönt, egy forrásból).
 *
 * KÜLÖN FÜGGVÉNY, mert a `loadAll` a queue ELŐTT fut (ott még nincs
 * `updatedAt`), az összevetés viszont a queue megérkezése UTÁN kell — új
 * fájl-olvasás nélkül, a bejegyzés saját horgonyából.
 *
 * A HÍVÓ NE STRINGRE HASONLÍTSON, ha csak a döntés kell: arra a
 * `reviewStoreStateLoadable` van. Egy elszórt `!== 'fresh'` pontosan az a
 * hibaosztály, amiből ez a változás született — a `tool-drift` némán a
 * "ne töltsd be" ágra esett volna, ahogy a `coreSha` eddig is tette.
 */
export function reviewStoreEntryState(entry, anchor) {
  if (!entry) return 'none'
  if (!subjectMatches(entry.anchor, anchor)) return 'stale'
  return toolDrifted(entry.anchor, anchor) ? 'tool-drift' : 'fresh'
}

/**
 * BETÖLTHETŐ-E ez az állapot — a `state` → döntés leképezés EGY HELYEN.
 *
 * MIÉRT FÜGGVÉNY, ÉS NEM A HÍVÓBAN EGY ÖSSZEHASONLÍTÁS: a `state` szótára most
 * HÁROM értékű, és a hívási helyeken szétszórt `=== 'fresh'` a NEGYEDIK érték
 * bevezetésekor némán a tiltó ágra esne — pontosan az a néma-veszteség osztály,
 * amit ez a commit orvosol. Itt EGY helyen dől el, tehát nem tud szétcsúszni.
 */
export function reviewStoreStateLoadable(state) {
  return state === 'fresh' || state === 'tool-drift'
}
