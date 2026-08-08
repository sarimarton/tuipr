// tuipr — ROWS: a queue-modell és a sor-layout.
//
// `queue --json` → megjelenítendő sorok (tranzitív stackelés, jelzők,
// státusz-mark), plusz a sor-szélesség / cím-büdzsé mérése.
//
// RÉTEGREND: lefelé importál (layout: cella-mérés; cache: a lista-jelző és a
// review-nyom glifjei). SEMMIT nem importál a core-ból vagy felette.
//
// A MARKS/RMARKS konstansok ITT laknak, mert az EGYETLEN fogyasztójuk a
// buildRows/flagsFor ág. (A core-ban a deklaráció és az `export` a fájl két
// végén állt szét — a névnek egy helyen kell élnie a használatával.)
import { cacheIndicatorFlag, reviewTraceFlag } from './cache.mjs'
import { displayWidth } from './layout.mjs'

// --- A státusz-feliratok és színek (a lista-nézet queue_mark_def párja) -----
//
// Egy forrás a TUI oldalán: a felirat és a szín state-enként. A szélességet itt
// NEM kell deklarálni — az Ink Box/Text a layoutot maga méri, szemben a bash
// printf-fel, ami bájtban számol.
// IKON-SZEMANTIKA: a felfele nyíl (⬆️) KIZÁRÓLAG a stackelést jelenti, és
// egyedül a flagsFor() stacked ágán szerepel. Korábban a queue-mark is ⬆️ volt
// ("⬆️ in queue"), és mivel a next MINDEN sora queue-tag, a nyíl minden soron
// ott állt — tehát nem különböztetett meg semmit. A queue-tagság ezért semleges
// telt kört (● U+25CF, 1 cella) kap; a telt/üres kontraszt szándékos: telt =
// benne van a next-ben, üres (○, RMARKS) = approve-ra vár.
const MARKS = {
  queue: { label: '● in queue', color: 'green' },
  conflict: { label: '⚠️ conflict', color: 'yellow' },
  blocked: { label: '⛔ blocked', color: 'red' },
  missing: { label: '❓ missing', color: 'yellow' },
  draft: { label: 'draft (kimarad)', color: 'gray' },
  // (wf31/25) OPTIMISTA VÉGÁLLAPOTOK — a MI akciónk eredménye, nem a GitHub
  // lekérdezéséből.
  //
  // MIÉRT KELL (mért lelet, a user #895-ös esete): a `gh pr merge` exit 0-val
  // visszatért, a `reload()` LEFUTOTT, és a PR MÉGIS ott maradt a listán — mert a
  // GitHub GraphQL-INDEXE aszinkron frissül, tehát a merge utáni MÁSODPERCEKBEN a
  // `gh pr list --state open` MÉG a régi állapotot adja. A user így egy olyan sort
  // látott „in queue"-ként, amit ő maga mergelt le másodpercekkel korábban.
  //
  // A MEGOLDÁS OPTIMISTA, ÉS EZ SZÁNDÉKOS: a saját akciónk eredményét ISMERJÜK
  // (exit 0), tehát nem kérdezzük vissza attól az API-tól, ami épp késik. A user
  // döntése: "ok legyen optimistic, de ne kivegyük a listából, hanem legyen merged
  // az állapota és dimmeld le. R reload-dal úgyis ki tudja szedni a user."
  //
  // MIÉRT NEM VESSZÜK KI A LISTÁBÓL: a sor eltűnése a kurzort is elmozdítaná, és a
  // user elveszítené a kontextust ("mi történt?"). A dimmelt, `merged` sor
  // KIMONDJA az eredményt, és a helyén marad, amíg a user (vagy a poll) nem
  // frissít.
  merged: { label: '✔ merged', color: 'gray' },
}

const RMARKS = {
  approved: { label: '✔ approved', color: 'green' },
  changes: { label: '✗ changes requested', color: 'red' },
  can_approve: { label: '○ approve-olhatod', color: 'cyan' },
  waiting: { label: '○ approve vár', color: 'gray' },
}


/** A queue --json egy sorának rmark-kulcsa (approve-oszlop), vagy null. */
function rmarkKey(r) {
  if (r.stackedOn !== null && r.stackedOn !== undefined) return null
  if (r.isDraft || r.state === 'draft') return null
  if (r.reviewDecision === 'APPROVED') return 'approved'
  if (r.reviewDecision === 'CHANGES_REQUESTED') return 'changes'
  return r.canApprove ? 'can_approve' : 'waiting'
}

/**
 * A META-JELZŐK (review-nyom + cache-státusz) a flag-sáv VÉGÉRE fűzve.
 *
 * A SORREND NEM ÖNKÉNYES: a tartalmi jelzők (dep / conflict / landolható) a
 * DÖNTÉST hordozzák, a meta-jelzők csak a mérésről/review-ról szóló metaadat. A
 * metaadat nem tolhatja jobbra azt, amiért a user a sort olvassa — és keskeny
 * terminálon a tail-degradáció is a VÉGÉT dobja el először, tehát a
 * legkevésbé fontos jelző esik ki elsőként.
 */
/**
 * (wf31/72) A FUTÓ AKCIÓ SOR-JELZŐJE — a hátrahagyott PR-on.
 *
 * A user kérése: "a táblázatban is jelenjen meg a pending approve, hogy amikor
 * elnavigálok, lássam, hogy a régi sor pending."
 *
 * MIÉRT KELL EGYÁLTALÁN: a pending eddig KIZÁRÓLAG a legendben élt (wf31/45), ami
 * a KÉPERNYŐ ALJÁN, a kurzortól függetlenül áll. Amíg a navigáció tiltva volt a
 * futó akció alatt, ez elég volt — a user ott állt, ahol az akció futott. A
 * wf31/72 óta viszont EL LEHET NAVIGÁLNI, és onnantól a legend már nem mondja meg,
 * MELYIK soron fut: a jelzésnek a SORHOZ kell tapadnia.
 *
 * A CÍMKE MEGNEVEZI AZ AKCIÓT (`⏳ approve…`), nem csak azt, hogy "dolgozik": egy
 * hátrahagyott soron a "min dolgozik" a lényegi kérdés — a user épp azért ment el,
 * mert mással foglalkozik.
 *
 * A SZÍN CYAN, mint a review-spinneré: mindkettő FOLYAMATBAN lévő munka jelzése,
 * és a projekt színkódja szerint a cyan az aktivitásé (a sárga a figyelmeztetésé,
 * a zöld az approve-oszlopé).
 */
const PENDING_ROW_LABELS = {
  a: '⏳ approve…',
  m: '⏳ merge…',
  f: '⏳ review feltöltése…',
  d: '⏳ hunk…',
  s: '⏳ stackelés…',
}

export function pendingActionFlag(key) {
  const label = typeof key === 'string' ? PENDING_ROW_LABELS[key] : undefined
  return label === undefined ? null : { label, color: 'cyan' }
}

function appendMetaFlags(flags, { cacheState: state, hasTrace, spinnerFrame, pendingKey }) {
  // A FUTÓ AKCIÓ A META-JELZŐK ELEJÉN: időben ez a legfrissebb tény a sorról, és
  // a tail-degradáció a VÉGÉT dobja el először — a pending tehát a leghosszabb
  // ideig marad látható. (Ugyanaz az érv, amiért a spinner is elöl áll.)
  const pending = pendingActionFlag(pendingKey)
  if (pending) flags.push(pending)
  // A SPINNER ELÖL a meta-jelzők között: a MOST zajló aktivitás időben
  // elsőbb, mint a múltbeli nyom/mérés-státusz. 1 cellás Braille (MÉRVE), a
  // ticker frame-indexével — külön timer NINCS (a 4. pont kikötése).
  if (spinnerFrame !== undefined && spinnerFrame !== null) flags.push(reviewSpinnerFlag(spinnerFrame))
  const trace = reviewTraceFlag(hasTrace)
  if (trace) flags.push(trace)
  const cached = cacheIndicatorFlag(state)
  if (cached) flags.push(cached)
  return flags
}

/**
 * A sor végi jelzők (dep / conflict / drift / landolható / stacked).
 *
 * (wf31/52) AZ `axis: 'mark'` JELÖLÉS — A CONFLICT-TENGELY JELZŐI A MARK MELLÉ.
 *
 * A user lelete: a sor `⚠️ conflict · ○ approve vár (forrás?)` alakban áll, "ahol a
 * »forrás?« a conflictra vonatkozik" — de az approve-oszlop MÖGÉ került, mert a
 * renderelő sorrendje mark → rmark → flags, és a `(forrás?)` a flags-ben volt. A
 * szem így az approve-hoz olvassa: mintha a jóváhagyás várna a forrásra.
 *
 * AZ `axis: 'mark'`-os jelzőket a renderelő a MARK UTÁN, az rmark ELŐTT rajzolja —
 * a conflict-tengely (`⚡dep`, `(forrás?)`, `⛔ conflict #N`) így egy blokkban áll
 * azzal a markkal, amiről beszél. A jelölés ADAT, nem stílus: a bash lista-nézet
 * ugyanezt a csoportosítást a saját sorrendjével oldja meg.
 *
 * A `measured` A MÉRÉS TÉNYE (van-e diagnózis ezen a PR-on) — lásd a 3-as ág
 * indoklását: a kérdőjel nem élheti túl a saját válaszát.
 */
function flagsFor(r, { measured = false } = {}) {
  const flags = []
  if (r.stackedOn !== null && r.stackedOn !== undefined) {
    flags.push({ label: `⬆️ stacked #${r.stackedOn} után`, color: 'gray' })
    // A LÁNC-DIAGNÓZIS a stacked soron jelenik meg (a main-bázisú sor definíció
    // szerint 0 mély és nem lehet körben). A sorrend NEM önkényes: a CIKLUS
    // előbb áll, mert ott a mélység nem is értelmezhető — a "túl mély" mellette
    // félrevezető lenne. A feliratoknak EGYEZNIE kell a bash queue_flag_def
    // "stackcycle"/"toodeep" ágaival, különben a lista és a TUI MÁST mond
    // ugyanarról a sorról.
    if (r.stackCycle === true) {
      flags.push({ label: '⚠ körkörös', color: 'red' })
    } else if (r.stackTooDeep === true) {
      // A mélységet KIÍRJUK: a puszta "túl mély" nem mondja meg, mennyivel — és
      // a user döntése (kivárom / szétvágom a láncot) ettől függ.
      flags.push({ label: `⚠ túl mély (${r.stackDepth ?? '?'} szint)`, color: 'yellow' })
    }
    return flags
  }
  // A klasszifikáció a (b) modellből jön: 2 = soft dep, 3 = conflict ismeretlen
  // forrással, 4 = dep-fájlt is érintő conflict (NE oldd fel).
  // NINCS szóköz a ⚡ után — a bash queue_flag_def "dep" ágával EGYEZŐEN, és nem
  // elírásból. A ⚡ (U+26A1) két cellát LÉPTET (MÉRVE: advance=2, ugyanannyi,
  // mint a ⛔/🚀), tehát a layout helyes — a `·` szeparátor oszlopa mérve nem
  // csúszik. A ⚡ viszont text-presentation jel (nincs VS16, Emoji_Presentation
  // hamis), így a foglalt 2 cellába a legtöbb font keskenyen rajzolja: a második
  // cella üresen látszik, és a literál szóköz mellé állva ez KÉT résnek
  // olvasódik. Pontosan ezt jelentette be a user. A foglalt cella maga a
  // szeparátor. A ⛔/🚀/⬆️ emoji-presentation, azokat a user nem jelentette be —
  // ott a szóköz MEGMARAD (célzott javítás, lásd test/next-tui.test.ts).
  if (r.classification === 2 && r.dep) flags.push({ label: `⚡dep #${r.dep}`, color: 'cyan', axis: 'mark' })
  // A 3-as eset felirata korábban "(main-drift)" volt, és MÉRT tényt állított,
  // amit a queue nem tud (itt csak labelek + fájl-metszet van). Az éles #911
  // pontosan ezen bukott meg: a main-nel MERGEABLE volt, a conflict forrása négy
  // queue-belső PR. A kérdőjel azt jelenti: a forrás még nem ismert — a 'c'
  // billentyű (`tuipr conflict`) megméri. A feliratnak EGYEZNIE kell a bash
  // queue_flag_def "unmeasured" ágával.
  // (wf31/52) A KÉRDŐJEL NEM ÉLHETI TÚL A SAJÁT VÁLASZÁT. A user lelete:
  // "megmértem a forrást c-vel, és egy pipa megjelent, de a forrás kérdés nem tűnt
  // el" — a sor egyszerre mondta, hogy MÉRVE van (`✓`) és hogy a forrás ISMERETLEN.
  //
  // AZ OK: a `classification` a queue-modellből jön (a bash a CÍMKÉKBŐL és a
  // fájl-metszetből számolja), a mérés eredménye viszont a session-cache-ben él —
  // a `3`-as osztály tehát a mérés után is `3` marad, mert a bemenete nem változott.
  // A `dep` sem segít: az a FÁJL-METSZET dep-je, nem a MÉRT culprit.
  //
  // A JELZŐ EZÉRT A MÉRÉS TÉNYÉRE IS NÉZ: ha van diagnózis ezen a PR-on, a kérdés
  // MEG VAN VÁLASZOLVA — a válasz (a culprit-lista, a stack-cél) a panelben áll,
  // ahová a mérés írja. Egy sor végi kérdőjel ott már csak hazug.
  if (r.classification === 3 && !measured) flags.push({ label: '(forrás?)', color: 'yellow', axis: 'mark' })
  if (r.classification === 4 && r.dep) flags.push({ label: `⛔ conflict #${r.dep}`, color: 'red', axis: 'mark' })
  // (wf31/24) A `🚀 landolható` FLAG KIVEZETVE — a user kérése: "Vedd ki ezt a
  // jelzést, idétlen. approved már közli amit kell."
  //
  // MIÉRT DUPLIKÁCIÓ VOLT: a `landable` mező a wf31/23 óta PONTOSAN azt jelenti,
  // hogy VAN APPROVE (a merge egyetlen blokkolója az approve lett). Az approve
  // tényét viszont az `rmark` MÁR kimondja (`✔ approved`), ugyanabban a sorban,
  // néhány cellával balra. Két jelölés ugyanarra a tényre.
  //
  // A `landable` MEZŐ MEGMARAD a modellben: a gépi fogyasztók (Claude-skill,
  // `mergeBlockers` egyezés-szerződés) használják, és a bash lista-nézet
  // klasszifikációja is erre épül. Csak a SOR-FLAG tűnt el — a tény nem.
  return flags
}

/**
 * A `queue --json` tömb → megjelenítendő sorok.
 *
 * A rendezés a lista-nézettel egyezik: a stacked sor a base-e MÖGÉ kerül akkor
 * is, ha a száma jóval nagyobb (#150 a #101 után, a #102 előtt) — a kulcs
 * [(stackedOn // number), number].
 *
 * A MÁSODIK ARGUMENTUM OPCIONÁLIS: `{ cacheStates, reviewTraces }`, PR-számra
 * kulcsolt egyszerű objektumok. MIÉRT ELŐRE KISZÁMOLT LEKÉPEZÉS, és nem a
 * cache-objektum: a `buildRows` MINDEN renderben lefut, és a user 4. pontja
 * kimondja, hogy a jelző nem lassíthatja a listát. Egy előre kigyűjtött
 * leképezésen a soronkénti munka egy objektum-index — se gh, se hunk, se git
 * hívás nem fér ide. (A cache→leképezés összeállítása az app dolga, egyszer
 * renderenként.) Argumentum nélkül a flag-sáv VÁLTOZATLAN: a régi hívók (a
 * bash-oldal és a meglévő tesztek) nem hasalhatnak el.
 */
export function buildRows(json, {
  cacheStates = null,
  reviewTraces = null,
  reviewSpinners = null,
  // (wf31/72) A FUTÓ AKCIÓ: `{ pr, key }` vagy `null`. Egyetlen akció fut
  // egyszerre (`actionLock`), tehát egy szám-kulcs pár elég — egy térkép azt
  // sugallná, hogy több párhuzamos akció is lehet.
  pendingAction = null,
  // (wf31/25) OPTIMISTA ÁLLAPOTOK: PR-szám → `'merged'` | `'approved'`. A MI
  // akciónk eredménye, amit a GitHub API-ja MÉG nem tükröz (aszinkron index) —
  // lásd a MARKS `merged` ágának indoklását.
  optimistic = null,
} = {}) {
  // A LÁNC-MEZŐK a MODELLBŐL jönnek (stackDepth / stackRoot), nem itt
  // számolódnak újra: a tranzitív feloldás a bash jq-passzban él, és két
  // implementáció ugyanarra a fogalomra garantáltan elcsúszik (ez a
  // hazug-státusz bug-osztály, amit a user már bejelentett).
  //
  // FAIL-SAFE a szerződés-eltolódásra: ha egy régebbi `queue --json` nem adja a
  // mezőket, a `stackedOn`-alapú EGYSZINTŰ képre esünk vissza — a lista
  // megjelenik, csak lépcső nélkül. Egy kivétel itt a TELJES TUI-t megölné.
  const depthOf = (r) => {
    if (typeof r.stackDepth === 'number' && Number.isFinite(r.stackDepth)) {
      return Math.max(0, Math.floor(r.stackDepth))
    }
    return r.stackedOn !== null && r.stackedOn !== undefined ? 1 : 0
  }
  const rootOf = (r) => {
    if (typeof r.stackRoot === 'number' && Number.isFinite(r.stackRoot)) return r.stackRoot
    return r.stackedOn ?? r.number
  }
  // A rendezés a GYÖKÉR szerint csoportosít, azon belül MÉLYSÉG, majd szám.
  // MIÉRT NEM a régi `[(stackedOn // number), number]`: az a KÖZVETLEN talapzat
  // szerint csoportosított, ami egy A→B→C láncnál szétvágta a csoportot (a C
  // kulcsa a B száma volt, nem az A-é), és egy köztes számú független PR
  // beékelődhetett a lánc közepébe. A `stackRoot` tranzitív, tehát a lánc minden
  // eleme UGYANAZT az elsődleges kulcsot kapja.
  const rows = [...json].sort((a, b) =>
    rootOf(a) - rootOf(b) || depthOf(a) - depthOf(b) || a.number - b.number)
  return rows.map((r) => {
    const isStacked = r.stackedOn !== null && r.stackedOn !== undefined
    // (wf31/25) AZ OPTIMISTA ÁLLAPOT FELÜLÍRJA A MÉRTET. A sorrend load-bearing:
    // ha a MODELL már utolérte magát (a reload friss adatot adott), az optimista
    // bejegyzést a hívó törli — tehát amíg itt van, a modellnél FRISSEBB tényt
    // hordoz.
    const opt = optimistic?.[r.number] ?? null
    // Az `approved` optimista állapot CSAK az rmark-ot írja felül (a PR nyitva van,
    // a mark továbbra is `in queue`); a `merged` a MARK-ot is — az a PR sorsa.
    const rk = opt === 'approved' ? 'approved' : rmarkKey(r)
    return {
      ...r,
      // A BOOLEAN `indent` MEGMARAD: a listLayout/renderelő oldal ezt olvassa, és
      // a mező törlése NÉMA layout-elcsúszást adna (a falsy 0 behúzást számolna).
      // Az `indentDepth` MELLÉ kerül — a lépcsőzős behúzás mértéke.
      indent: isStacked,
      indentDepth: depthOf(r),
      // A stacked sor nem önállóan aktionölhető: a sorsa a talapzatán dől el.
      selectable: !isStacked,
      // A stacked sor markja "in queue" — a next a talapzatán KERESZTÜL
      // tartalmazza (így adja a lista-nézet queue_marks_from_model is). A
      // stacked-séget a sor végi jelző mondja ki, hogy ne duplikálódjon.
      mark: opt === 'merged'
        ? MARKS.merged
        : MARKS[isStacked ? 'queue' : r.state] ?? MARKS.missing,
      rmark: rk ? RMARKS[rk] : null,
      // A DIMMELÉS JELZÉSE a renderelőnek: a mergelt sor LEHALKUL (a user kérése).
      // A `Row` a `dimmed` propból amúgy is tud tompítani (overlay-nyitáskor), de
      // az EGÉSZ listára szól — ez PER SOR, és a sor SORSÁRÓL beszél, nem a
      // fókuszról. Ezért külön mező, nem a meglévő `dimmed` újrahasznosítása.
      settled: opt === 'merged',
      // A META-JELZŐK a tartalmi jelzők UTÁN fűződnek — EGY helyen, a
      // `flagsFor` KÉT return-ága (stacked / trunk) fölött. Ha a `flagsFor`-ba
      // tettük volna, a stacked ág korai return-je miatt a stacked sorról a
      // jelző NÉMÁN lemaradt volna, és a lista két sor-osztályról MÁST mondana.
      flags: appendMetaFlags(flagsFor(r, {
        // A MÉRÉS TÉNYE A CACHE-ÁLLAPOTBÓL: `fresh` VAGY `stale` — mindkettő azt
        // jelenti, hogy a mérés LEFUTOTT. A `stale` szándékosan benne van: az csak
        // annyit mond, hogy a main azóta elmozdult, a culpritokat viszont MEGMÉRTÜK,
        // és a `~` jelző az elavultságot amúgy is kimondja. Ha csak a `fresh`
        // számítana, a kérdőjel a main minden elmozdulásánál visszatérne — "de hát
        // megmértem" —, holott a válasz ott áll a panelben.
        measured: cacheStates?.[r.number] === 'fresh' || cacheStates?.[r.number] === 'stale',
      }), {
        cacheState: cacheStates?.[r.number],
        hasTrace: reviewTraces?.[r.number] === true,
        spinnerFrame: reviewSpinners?.[r.number],
        pendingKey: pendingAction?.pr === r.number ? pendingAction.key : undefined,
      }),
      // A GÉPI FOGYASZTÓNAK (és a `--json`-nak) is ki kell mondani, nem csak a
      // glifnek: a szerződés az állapot NEVE, nem a megjelenítése.
      cacheState: cacheStates?.[r.number] ?? 'none',
      hasReviewTrace: reviewTraces?.[r.number] === true,
    }
  })
}

// --- (1b) A LÉPCSŐS STACKED-JELÖLÉS: `╰─` a behúzás VÉGÉN -------------------
//
// A USER SZÓ SZERINTI KÉRÉSE: "amikor stacked PR-ok vannak, akkor a bekezdett
// második PR mellett legyen derékszögű keret karakter:  #911 / ╰─#933" — és
// megerősítette, hogy TÖBB szintnél LÉPCSŐ legyen. A rekurzív stackelés (a
// tranzitív `stackDepth`/`stackRoot`) már működik, ez a jelölés a KÉPÉRE.
//
// A GEOMETRIA, ami a bevezetést egyáltalán megengedi: a `╰─` display-CELLÁBAN
// PONTOSAN 2 cella, és a behúzás eddig is 2*depth cella volt. A jelölés tehát a
// behúzás UTOLSÓ KÉT CELLÁJÁBA ÜL BE, nem ad hozzá — a prefix teljes szélessége
// VÁLTOZATLAN, és így a mark-oszlop sem csúszhat el.
//
// A SZÉLESSÉG MÉRVE, NEM TIPPELVE (élő tmux, CSI 6n cursor-advance):
//   `╰` U+2570 advance=1 · `─` U+2500 advance=1 · `╰─` együtt advance=2
// Ez nem formalitás: a user NÉGYSZER jelentette be az oszlop-csúszást, és
// mindegyik gyökere egy MEGTIPPELT glif-szélesség volt. A box-drawing blokk
// (U+2500–U+257F) EAW=Ambiguous, tehát nincs a WIDE_RANGES-ben — a saját
// displayWidth-ünk is 1-nek méri, és a teszt ezt FÜGGETLEN mérővel pineli.
//
// MIÉRT EGY KÖZÖS FÜGGVÉNY (és nem két helyen számolt string): a behúzást KÉT
// oldal olvassa — a `listLayout` title-büdzséje és a renderelő `Row`-ja. A
// kettőnek BÁJTRA egyeznie kell; ez a projekt MÉRT hibaosztálya (a `floor`
// binárisan 3 volt, míg a renderelő 2*depth-et használt, és 56/57 oszlopon
// némán 1-2 cellával túllógott a sor). Egy forrás, egy mérték.

/** A lépcső GLIFJE. 2 cella (MÉRVE — lásd a szekció fejét). */
const STACK_MARK = '╰─'

/**
 * A stacked sor BEHÚZÁS-PREFIXE a mélységből: `2*(depth-1)` szóköz + `╰─`.
 *
 * A depth=0 (gyökér vagy független PR) ÜRES stringet kap: ott nincs mihez
 * képest bekezdeni, és egy magában álló `╰─` azt hazudná, hogy a sor valamire
 * stackelve van.
 *
 * FAIL-SAFE a degenerált mélységre (negatív, NaN, nem-szám): a `stackDepth` a
 * MODELLBŐL jön (a bash jq-passzból), tehát egy szerződés-eltolódás bármit
 * adhat. Egy `' '.repeat(NaN)` RangeError-t dobna, és egy dobás itt a TELJES
 * listát vinné el — a jelölés kozmetika, a lista nem az.
 */
export function stackIndent(depth) {
  const d = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0
  if (d === 0) return ''
  return ' '.repeat(2 * (d - 1)) + STACK_MARK
}

export { STACK_MARK }

// --- Layout: a cím-oszlop büdzséje -----------------------------------------

// A soronkénti fix rész: kurzor(2) + "#" + szám(5) + szóköz + szerző(5) +
// szóköz + a cím utáni szóköz ≈ 16 cella, plusz 2 cella jobb margó.
const ROW_FIXED_W = 16
const ROW_MARGIN_W = 2

/** Egy sor státusz-tailjének szélessége a megadott degradációs szinten. */
function tailWidth(r, level) {
  const mark = displayWidth(r.mark.label)
  if (level >= 2) return mark // csak a mark
  const rmark = r.rmark ? 3 + displayWidth(r.rmark.label) : 0
  if (level >= 1) return mark + rmark // mark + approve-oszlop, jelzők nélkül
  const flags = r.flags.reduce((a, f) => a + 1 + displayWidth(f.label), 0)
  return mark + rmark + flags
}

/**
 * A LISTA-LAYOUT: a címoszlop szélessége ÉS a státusz-tail degradációs szintje.
 *
 * Miért nem elég egy puszta szélesség (ez volt a bug, amit a user HÁROMSZOR
 * bejelentett): ha a fix rész + a legszélesebb státusz-tail MAGA túllépi a
 * COLUMNS-t, a címoszlop 0-ra vitele NEM elég — a sor akkor is túllóg, az Ink
 * tördel, és a mark-oszlop soronként más cellába csúszik. ÉLŐ 60 oszlopos
 * tmux-renderben mérve: a #911 sora 65 cella lett, a `#926` jelző átcsúszott a
 * következő sorba, a mark-oszlop 15/17/19 cellába került (ALIGNED: false).
 * A címoszlop nullázása után tehát a TAILT kell fokozatosan elhagyni:
 *   0 = mark + approve-oszlop + jelzők (teljes)
 *   1 = mark + approve-oszlop (a jelzők elmaradnak)
 *   2 = csak a mark (a legszűkebb, még informatív forma)
 *
 * A behúzás (stacked sor) NEM megy bele a tail-számításba: a behúzás a cím
 * ELŐTT áll, és a renderelő a címoszlopot rövidíti vele (`titleWidth - 2`).
 * Ha itt is beszámítanánk, KÉTSZER vonnánk le — pont ez csúsztatta el a
 * mark-oszlopot a behúzott sornál.
 */
export function listLayout(rows, columns) {
  if (rows.length === 0) return { titleWidth: 0, tailLevel: 0, width: 0 }
  // A címoszlop a leghosszabb TÉNYLEGES címre clampelődik (nincs értelme üresen
  // paddolni). A behúzott sor 2 cellát a behúzásra ad, ezért a címét 2-vel
  // hosszabbnak számoljuk — így a saját címe nem csonkul feleslegesen.
  // A BEHÚZÁS MÉRTÉKE a MÉLYSÉGBŐL. A `indentDepth` a modellből jött tranzitív
  // mélység; a `?? (indent ? 1 : 0)` fallback a régi (egyszintű) sor-alakot
  // tartja életben.
  //
  // (1b) A MÉRTÉK a `stackIndent` CELLÁBAN MÉRT szélessége — UGYANAZ a forrás,
  // amit a renderelő is kiír. NEM egy MÁSODIK `2*depth` képlet: a duplikált
  // mérték ugyanarra a fogalomra ebben a projektben MÁR elcsúszott egyszer (a
  // bináris `floor` vs. a renderelő 2*depth-je, 56/57 oszlopon néma túllógás).
  // Ha a lépcső glifje valaha változik, itt SEMMIT nem kell hozzáigazítani.
  const indentOf = (r) =>
    displayWidth(stackIndent(typeof r.indentDepth === 'number' ? r.indentDepth : r.indent ? 1 : 0))
  const longest = Math.max(...rows.map((r) => displayWidth(r.title) + indentOf(r)))
  // A LEGMÉLYEBB sor behúzása szabja meg a padlót (lásd a `floor`-t lentebb).
  const maxIndent = Math.max(...rows.map((r) => indentOf(r)))
  for (const tailLevel of [0, 1, 2]) {
    const statusW = Math.max(...rows.map((r) => tailWidth(r, tailLevel)))
    const avail = columns - ROW_FIXED_W - ROW_MARGIN_W - statusW
    // A renderelő `Math.max(1, titleWidth - 2*depth)`-et használ, tehát a
    // legmélyebb sor legalább 1 + 2*depth cellát fogyaszt akkor is, ha itt 0-t
    // adnánk. A layoutnak ezt a padlót be kell számolnia, különben a garancia
    // hazug.
    //
    // MÉRT BUG: a padló korábban BINÁRISAN 3 volt (`indent ? 3 : 1`), tehát egy
    // 3 mély láncnál 2 cellát tartalékolt a 6 helyett — a layout ALULMÉRTE a
    // sort, és 56/57 oszlopon a renderelt sor 1-2 cellával TÚLLÓGOTT. A
    // tartomány szűk, épp ezért néma: a szem nem veszi észre, a terminál
    // tördel. (A test/next-tui.test.ts a teljes columns-tartományt pásztázza.)
    const floor = 1 + maxIndent
    if (avail >= floor) {
      const titleWidth = Math.min(longest, avail)
      // (wf31/27) A TÁBLA TÉNYLEGES SZÉLESSÉGE — a TARTALOMBÓL, nem a terminálból.
      //
      // A USER LELETE: "A TUI max szélességét bekorlátozza a leghosszabb PR title,
      // ezért béna, hogyha van valami, ami kimegy a terminál jobb széléig, ha ott
      // még van hely. […] Az app szélességét határozza meg a táblázat, és annak a
      // szélén legyen a felirat, és csak odáig menjen a highlight is."
      //
      // MIÉRT SZÁMOLHATÓ KI ITT, ÉS MIÉRT ITT A HELYE: a `titleWidth` MÁR a
      // tartalomra clampel (`Math.min(longest, avail)`) — vagyis ha a leghosszabb
      // cím rövidebb, mint a rendelkezésre álló hely, a tábla NEM nyúlik ki a
      // terminál széléig. Ez az információ eddig megvolt, csak nem adtuk ki: a
      // fejléc, a status-felirat és a kurzor-háttér a `columns`-ot használta, tehát
      // a TERMINÁL széléig ment, a tábla meg nem.
      //
      // A KÉPLET a `avail` levezetésének megfordítása, UGYANAZOKKAL a tagokkal —
      // nem egy második, önálló számítás (az garantáltan elcsúszna: ez a projekt
      // mért hibaosztálya, lásd a `floor` indoklását fentebb).
      //
      // A `statusW` a LEGSZÉLESEBB sor tailje: a tábla jobb szélét az adja meg, nem
      // az egyes sorok saját hossza — különben a szél soronként ugrálna.
      return {
        titleWidth,
        tailLevel,
        // (wf31/28) A TERMINÁL SZÉLESSÉGÉNÉL EGGYEL KEVESEBB A PLAFON. MÉRT
        // ARTIFACT (a user resize-leletéből): ha a tábla PONTOSAN a terminál
        // szélességéig ér, a kurzor-kiemelés háttér-kitöltése az UTOLSÓ CELLÁT is
        // beírja — és a legtöbb terminál (Ghostty, Terminal.app) ilyenkor
        // AUTOWRAP-ot tesz, tehát a következő sor elejére ugrik. Az így keletkező
        // fantom-sor pontosan a bejelentett „feltorlódás".
        //
        // A `-1` CSAK A PLAFONT érinti: ha a TARTALOM szűkebb (a tipikus eset,
        // ezért a `Math.min` másik ága nyer), a tábla változatlan.
        width: Math.min(Math.max(1, columns - 1), ROW_FIXED_W + ROW_MARGIN_W + statusW + titleWidth),
      }
    }
    // A legszűkebb szinten sincs hely: adjuk a legkevesebbet, amit a renderelő
    // egyáltalán elfogad. Ez a valóban degenerált eset (nagyon szűk terminál);
    // itt már nem tudunk nem tördelni, de nem MI tesszük rosszabbá.
    if (tailLevel === 2) return { titleWidth: 0, tailLevel: 2, width: Math.max(1, columns - 1) }
  }
  return { titleWidth: 0, tailLevel: 2, width: Math.max(1, columns - 1) }
}

/**
 * A cím-oszlop szélessége. Visszafelé kompatibilis burkoló a listLayout körül —
 * a bin/tuipr.sh és a tesztek ezt a nevet hivatkozzák.
 */
export function titleBudget(rows, columns) {
  return listLayout(rows, columns).titleWidth
}

// --- A SOR-SPINNER (4): amíg egy PR-on review fut ---------------------------

/**
 * EGYCELLÁS Braille-spinner frame-ek. NEM emoji: az emoji 2 cellát léptet, és
 * megbontaná a flag-sáv szélesség-számítását (a négyszer bejelentett
 * oszlop-csúszás osztálya). A Braille-blokk (U+2800–U+28FF) nincs a
 * WIDE_RANGES-ben, tehát a saját displayWidth-ünk is 1-nek MÉRI — a teszt ezt
 * assertáln is, nem tippeli.
 */
export const REVIEW_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * A spinner lista-jelzője. CYAN (aktivitás, nem figyelmeztetés — a sárga a
 * költségé/blokkolóké). A frame-index körbejár; degenerált index sem dob,
 * mert a spinner kozmetika — egy dobás itt a TELJES listát vinné el.
 */
export function reviewSpinnerFlag(frame) {
  const len = REVIEW_SPINNER_FRAMES.length
  const n = Number.isInteger(frame) ? frame : 0
  return { label: REVIEW_SPINNER_FRAMES[((n % len) + len) % len], color: 'cyan' }
}
export { MARKS, RMARKS }
