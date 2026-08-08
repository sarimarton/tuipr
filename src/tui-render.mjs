// A REVIEW-MUNKAÁLLOMÁS RENDER-RÉTEGE: a queue-sor és a HÁROM overlay-BODY.
//
// MIÉRT EZ A VÁGÁS (a (3) fázis első modulja), ÉS MIÉRT PONT ITT A HATÁR:
//
// Ez a fájl a TUI azon részét tartalmazza, ami PROPBÓL renderel és NULLA
// App-állapotot zár be — MÉRVE: a blokk egyetlen modul-szintű hivatkozása a
// saját `ERROR_BODY_MAX_LINES` konstansa volt, minden más a core tiszta
// függvényeitől jött. Nincs `useState`, nincs `useRef`, nincs setter a
// closure-jében, tehát az áthelyezés MECHANIKUS: a hook-sorrend (a React néma
// hibaosztálya) érintetlen, mert itt nincs hook.
//
// A HÁROM BODY NEM Ink-fát ad, hanem SOR-LEÍRÓKAT (`{ text, color?, … }`) — a
// magasság-vágás (`clipBodyLines`) a MEGJELENÍTENDŐ sorokat számolja, és egy
// összeállított Ink-fából a tördelt sorszám nem olvasható ki. A leíró → Ink
// konverzió EGY helyen (`renderLines`), a vágás UTÁN.
//
// AMI SZÁNDÉKOSAN NEM KERÜLT IDE: a `useInput` kezelője és az akció-flow-k
// (`doAiReview`/`openReview`/`doMerge`/…). Azok 50 körüli ÉLŐ bindingot zárnak be
// (setterek, refek, származtatott értékek); egy modulba emelve mindegyik egy
// 50 mezős context-objektum paraméterévé válna, ami már NEM mozgatás, hanem
// ÚJRATERVEZÉS — és pont azt a felületet hozná létre, ahol egy kimaradt mező
// némán `undefined`-ot ad. Lásd a jelentés indoklását.

import { Box, Text as InkText } from 'ink'

// (wf31/39) MINDEN `Text` NEM-TÖRDELŐ — EZ A WRAP-FLICKER VALÓDI JAVÍTÁSA.
//
// A MÉRT GYÖKÉROK (az ink 7.1.1 forrásából): az Ink `resized` handlere NEM indít
// React-rendert, hanem KÖZVETLENÜL rajzol:
//     calculateLayout(); dom.emitLayoutListeners(rootNode); onRender()
// A `calculateLayout` a GYÖKÉR yoga-node-ra állítja az új terminál-szélességet, de
// a `Text` gyerekek TARTALMA a KORÁBBI React-render eredménye — a mi
// `clampCells`-ünk tehát a RÉGI, szélesebb mértékkel vágott. A Yoga a hosszabb
// stringet a szűkebb gyökérben TÖRDELI, és ez a tördelés az, ami az Ink
// törlés-számítását elcsúsztatja (a flicker).
//
// EZÉRT NEM SEGÍTETT A wf31/38-AS AZONNALI CAP: az a MI render-utunkon frissül, a
// resize-frame-et viszont nem a mi kódunk építi — a React-render csak a debounce
// után jön.
//
// A `wrap: 'truncate'` A YOGA SZINTJÉN oldja meg: a `Text` SOSEM tördel, hanem
// LEVÁG. Ez pontosan a hunk viselkedése, amit a user megfigyelt ("Hunk valahogy
// megoldja hogy ne legyen wrap flicker, csak átmeneti cap") — szűkítéskor a
// tartalom azonnal csonkolódik, és a helyes layout a következő renderben áll be.
//
// MIÉRT WRAPPER, ÉS NEM 13 HELYEN EGY PROP: egy kihagyott `Text` NÉMÁN visszahozná
// a flickert (egyetlen tördelő sor elég hozzá), és a hiba csak élő resize-nál
// derülne ki. Így strukturálisan lehetetlen elfelejteni.
//
// A `wrap` FELÜLÍRHATÓ: a hívó explicit `wrap`-je nyer (a spread a default UTÁN
// jön). Ma egyetlen hívó sem ad meg mást — de ha valaha kell egy tördelő blokk
// (pl. egy hosszú hibaszöveg), az ne kívánja a wrapper átírását.
export function Text(props) {
  return h(InkText, { wrap: 'truncate', ...props })
}
import React, { createElement as h } from 'react'

import {
  MODAL_CHOICES,
  branchLabel,
  budgetLine,
  buildInfoModel,
  approveBlockers,
  canMergeRow,
  clampCells,
  displayWidth,
  frictionLines,
  mergeBlockers,
  mergeWarnings,
  mergePlan,
  modalHasChoices,
  modelLine,
  stackIndent,
  lerpHex,
  wrapCells,
} from './tui-core.mjs'


/**
 * Egy queue-sor renderelése.
 *
 * A `tailLevel` a listLayout degradációs szintje: keskeny terminálon a
 * státusz-tail fokozatosan elmarad, hogy a sor NE tördelődjön. A tördelés nem
 * kozmetikai baj — az Ink a túlfutó sort új sorba tolja, amitől a mark-oszlop
 * soronként más cellába csúszik (élőben mérve: 15/17/19 a 60 oszlopos panelen),
 * és a lista olvashatatlanná válik. Ezt a user HÁROMSZOR bejelentette.
 */
/**
 * A TOMPÍTOTT SZÖVEG SZÍNE — NYITOTT OVERLAY / LEZÁRT SOR ALATT.
 *
 * (wf31/55) A user kérése: "dimmelt betűk lenyitott info panelnél legyen picit
 * jobban dimmelve".
 *
 * MIÉRT NEM ELÉG A `dimColor`: az az ANSI SGR 2, EGYETLEN fix fokozat — nincs
 * "erősebb dim". A tompított szegmensek ráadásul MÁR elvesztik a saját színüket
 * (`color: faded ? undefined : …`), tehát a terminál ALAPSZÍNÉT kapják halványítva:
 * világos terminál-témán ez alig különbözik az éles sortól.
 *
 * A MEGOLDÁS EXPLICIT SZÍN A `dimColor` MELLÉ: a hex a terminál-témától
 * FÜGGETLENÜL rögzíti a fakó szintet, a `dim` pedig még egy fokozatot visz rajta.
 * A `#6b7280` szándékosan a kiemelés hátterének (`#3a4250`) családjából való —
 * ugyanaz a hűvös szürke-kék tengely, tehát a kép nem esik két színvilágra.
 *
 * A HÁROM FOKOZAT, amiből ez a KÖZÉPSŐ (a user kérdésére: "van köztük lépcsőfok?"):
 *
 *   1. alapszín + `dim`        — az EREDETI. A terminál alapszövege halványítva;
 *                                világos témán alig különbözik az éles sortól.
 *   2. `FADED_COLOR`, dim NÉLKÜL  ← EZ VAN MOST. A hex rögzíti a szintet, a
 *                                terminál-témától függetlenül.
 *   3. `FADED_COLOR` + `dim`   — a KETTŐ EGYMÁSON. Ez volt az első kísérlet, és a
 *                                user szerint túllőtt: a `dim` a hexet is ~50%-ra
 *                                viszi (≈ `#363940`), ami már majdnem olvashatatlan.
 *
 * A HANGOLÁS EGY SZÁMON MÚLIK: sötétebb kell → `#5a6270`; világosabb → `#7d8694`
 * vagy `#8a93a3`. A `dim` VISSZAKAPCSOLÁSA NEM finomhangolás, hanem egy egész
 * fokozat ugrás — azért esik ki a fakó szegmenseknél.
 *
 * MIÉRT NEM SÖTÉTEBB: a tompított sor OLVASHATÓ kontextus marad (a user a panel
 * mellett is látja, melyik PR-ok állnak a sorban) — nem eltüntetni akarjuk, csak
 * hátrébb tolni. A user szava is "picit".
 */
export const FADED_COLOR = '#6b7280'

/**
 * A NEVESÍTETT SZÍNEK HEX-KÖZELÍTÉSE — KIZÁRÓLAG A TWEEN KEZDŐPONTJÁHOZ.
 *
 * (wf31/61) A user lelete: "a jobb részen lévő zöld, sárga, cián, piros fehérre
 * villan" — mert a tompított szegmens ELVESZTETTE a saját színét, és a (fehérről
 * induló) fade-színt kapta. A javítás: minden szegmens a SAJÁT színéből tweenel a
 * dim felé — ehhez viszont a nevesített Ink-színek hex-értéke kell.
 *
 * KÖZELÍTÉS, ÉS EZ ITT ELÉG: a terminál valódi palettáját nem lehet kikérdezni
 * (ugyanaz a korlát, mint az alapszínnél — OSC query a stdin-be). A tévedés ára
 * kicsi és lokális: az adott szegmens ELSŐ fade-frame-je ugrik egy hajszálnyit,
 * a VÉGPONT (FADED_COLOR) exakt, a NYUGALMI szín pedig érintetlen (azt továbbra
 * is a téma adja — a map CSAK faded állapotban olvasódik).
 *
 * Az értékek tipikus sötét-témás palettákhoz igazodnak (a user környezete is az).
 */
const NAMED_COLOR_HEX = {
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  cyan: '#22d3ee',
  blue: '#60a5fa',
  magenta: '#d946ef',
  gray: '#9ca3af',
  grey: '#9ca3af',
  white: '#e5e7eb',
  whiteBright: '#ffffff',
}

/**
 * A tween kezdőpontja egy szegmens-színhez: hex marad, nevesített felold,
 * ismeretlen a téma előtérszíne (vagy fehér).
 *
 * (wf31/62) A `palette` a RUNTIME MÉRT terminál-paletta (OSC 4/10, lásd a
 * `term-colors.mjs` fejét) — ha van, az ÜT: a user lelete szerint az "in queue"
 * zöldje nem egyezett a beépített közelítéssel ("árnyaltabb, zöldes-sárgás").
 * A `NAMED_COLOR_HEX` a fallback marad, nem válaszoló terminálokra.
 */
function fadeStartOf(color, palette) {
  if (typeof color === 'string' && color.startsWith('#')) return color
  return palette?.[color] ?? NAMED_COLOR_HEX[color] ?? palette?.fg ?? '#ffffff'
}

export function Row({
  row, selected, titleWidth, tailLevel, dimmed = false, columns = 0, terminalColumns = 0,
  // (wf31/61) A TOMPULÁS ELŐREHALADÁSA (0..1) A HÍVÓTÓL JÖN — nem kész szín,
  // hanem a `t`, mert a tween szegmensenként MÁS kezdőpontból fut (a zöld a
  // zöldből, a fehér a fehérből — a user lelete a fehérre villanó színekről).
  // A default 1 (végállapot): aki nem tud a fade-ről, a kész, jóváhagyott
  // tompítást kapja — bájtra a wf31/55-ös kép.
  fadeT = 1,
  // (wf31/62) A RUNTIME MÉRT terminál-paletta (vagy null) — a tween kezdőpontjai
  // ebből jönnek, hogy a színek a TÉMA színéből induljanak, ne közelítésből.
  fadePalette = null,
}) {
  const cursor = selected ? '❯ ' : '  '
  // A BEHÚZÁS LÉPCSŐZŐS: 2*indentDepth cella (a modellből jött TRANZITÍV
  // mélység). Korábban binárisan 2 volt minden stacked sorra, tehát egy A→B→C
  // láncban a C ugyanott állt, mint a B — a hierarchia eltűnt a képről.
  //
  // A `?? (indent ? 1 : 0)` fallback a régi sor-alakot tartja életben (a
  // listLayout ugyanezt a fallbacket használja — a kettőnek egyeznie KELL,
  // különben a mark-oszlop elcsúszik).
  const depth = typeof row.indentDepth === 'number' ? row.indentDepth : row.indent ? 1 : 0
  // (1b) A BEHÚZÁS-PREFIX a core KÖZÖS függvényétől jön (`stackIndent`), nem itt
  // épül: a title-büdzsé (`listLayout`) UGYANEZT a mértéket használja, és két
  // számítás ugyanarra a fogalomra garantáltan elcsúszik — ez a projekt MÉRT
  // hibaosztálya (a `floor` binárisan 3 volt, míg a renderelő 2*depth-et
  // számolt, és 56/57 oszlopon némán túllógott a sor).
  //
  // A LÉPCSŐS JELÖLÉS a user szó szerinti kérése (`#911` / `╰─#933`), és a
  // SZÉLESSÉG VÁLTOZATLAN: a `╰─` CELLÁBAN 2 (MÉRVE), tehát a behúzás utolsó két
  // celláját foglalja el, nem ad hozzá. Ezért a mark-oszlop nem csúszik el.
  const indentPrefix = stackIndent(depth)
  const indentCells = displayWidth(indentPrefix)
  // A cím a büdzséhez csonkolódik/paddolódik; a behúzott sor a behúzására adott
  // cellákkal rövidebb címoszlopot kap — így a mark-oszlop MINDEN szinten
  // ugyanabban a cellában kezdődik (ugyanaz a szabály, mint a lista-nézetben).
  const tw = Math.max(1, titleWidth - indentCells)
  const showRmark = tailLevel < 2 && row.rmark
  const showFlags = tailLevel < 1
  // OVERLAY NYITVA: a lista TOMPÍTVA marad renderelve. Ez a refaktor lényege — a
  // korábbi teljes-képernyős csere elvette a kontextust (a user nem látta, melyik
  // PR-ról szól a dialog). A tompítás egyszerre mondja, hogy a lista MÉG OTT VAN,
  // és hogy a fókusz NEM rajta van: a színek eldobása és a dimColor együtt.
  //
  // A KIVÁLASZTOTT SOR VISZONT KIVÉTEL (user-kérés, szó szerint): "amikor lenyitok
  // egy elemet, annak a sora a főlistán maradhatna eredeti színezésben dimmed
  // helyett, hiszen az egy highlighted sor".
  //
  // MIÉRT JOGOS A KIVÉTEL: a tompítás ÜZENETE az, hogy "ez nem a fókusz". A
  // kurzor sora viszont PONT a fókusz tárgya — a panel ARRÓL a PR-ról szól, és a
  // pozíciója (a panel közvetlenül alatta nyílik) is ezt mondja. Az EGÉSZ lista
  // tompítva a kurzor sorát is „mellékessé" degradálta, tehát a kép elvesztette
  // azt a horgonyt, amihez a panel tartozik.
  //
  // A TOMPÍTÁS NEM SZŰNIK MEG, csak a hatóköre szűkül a NEM-kiválasztott sorokra:
  // a kontraszt (egy éles sor sok tompa között) ERŐSEBB kontextus-jelzés, mint a
  // homogén tompaság volt.
  // (wf31/25) A LEZÁRT (mergelt) SOR IS TOMPÍTOTT — a MI akciónk optimista
  // eredménye (lásd a `rows.mjs` MARKS `merged` ágát). A user kérése: "legyen
  // merged az állapota és dimmeld le".
  //
  // A KETTŐ KÜLÖNBÖZŐ FOGALOM, ezért két külön forrás:
  //   · `dimmed` — az OVERLAY nyitva van, tehát a lista nem a fókusz (a kurzor
  //     sora KIVÉTEL, mert a panel épp arról szól);
  //   · `settled` — a sor SORSA lezárult (lemergeltük). Ez a sorról szól, nem a
  //     fókuszról, tehát a kurzoron IS érvényes: egy kiválasztott, mergelt sor is
  //     halkan látszik — a kiemelése azt sugallná, hogy még van vele teendő.
  const faded = (dimmed && !selected) || row.settled === true
  const dim = faded || undefined
  // A SOR SAJÁT TWEEN-ÁLLÁSA. A `settled` (mergelt) sor a VÉGÁLLAPOTRA pinnelt:
  // az MÁR tompa volt a panel nyitása ELŐTT is — ha a globális `fadeT`-t kapná, a
  // panel nyitásakor Ő IS felvillanna a kezdőszínére, holott vele nem történt
  // semmi. (Ez a hibaosztály a wf31/56-ban is ott volt, csak settled sor híján
  // nem látszott.)
  const rowT = row.settled === true ? 1 : fadeT
  // A TOMPÍTOTT SZEGMENS A SAJÁT SZÍNÉBŐL TWEENEL a dim felé (wf31/61) — a zöld
  // a zöldből, a színtelen a fehérből. A `dim` attribútum tompításkor kiesik: a
  // színes tween már maga a tompítás, a dim rajta egy fokozattal túllőne.
  const fadePaint = (seg) => lerpHex(fadeStartOf(seg.color, fadePalette), FADED_COLOR, rowT)
  // A CÍM CELLÁBAN csonkolódik/paddolódik. A `.slice` UTF-16 code unitot vág:
  // emojis címnél cellában TÚLLÓGOTT (a mark-oszlop soronként elcsúszott), és a
  // padEnd is a rossz mértéket pótolta. A clampCells + cella-alapú pad ugyanazt a
  // mértéket használja, amit a listLayout a büdzsé kiszámolásához.
  const clipped = clampCells(row.title, tw)
  const title = clipped + ' '.repeat(Math.max(0, tw - displayWidth(clipped)))
  // (wf31/26) A KIVÁLASZTOTT SOR HÁTTÉRSZÍNT KAP — a user lelete: "a highlight
  // karakter: »❯ « ezzel nem lehet követni a selected sort rendesen, túl széles a
  // monitor."
  //
  // MIÉRT A HÁTTÉR, ÉS NEM EGY MÁSODIK NYÍL A JOBB SZÉLEN (a user rám bízta): a
  // nyíl-pár csak a sor KÉT VÉGÉT jelöli meg — a 190 cellás monitoron pont a
  // KÖZÉP marad jelöletlen, ahol a cím és a markok vannak, tehát a szem továbbra
  // is „ugrálna" a két horgony között. A háttér VÉGIGVISZI a jelölést: bárhol
  // nézsz a sorra, látszik, hogy az a kiválasztott.
  //
  // A SZÍN `#3a4250` — SÖTÉT, KÉK FELÉ HÚZÓ SZÜRKE.
  //
  // A user KÉT pontosítása vezetett ide:
  //   1) "feltételezhetjük, hogy sötét a háttér […] a betűk világosak. Tehát egy
  //      világos háttéren nem látszanak a betűk. Minimál kontraszt" — ezért nem
  //      `blue`/`white`, hanem sötét, alacsony kontrasztú háttér;
  //   2) "egy fokkal világosabb legyen, és menjen szürke felé, mert a mostani
  //      valami barna fos színű" — a `#2a2a2a` túl sötét volt (alig látszott), és
  //      a legtöbb terminál-renderelőn melegebbnek tűnt a szándékoltnál.
  //
  // A HARMADIK ITERÁCIÓ (a user: "menjen a kék felé mert még mindig barnás, és
  // még egy picit világosabb lehet"): `#3a4250` — a KÉK csatorna a legerősebb
  // (0x50 > 0x42 > 0x3a), tehát a hue definíció szerint a kék-szürke tartományban
  // van, meleg (barnás) irányba NEM tud elmenni. A világosság is emelkedett: a
  // luma ~0x42 a korábbi 0x3a-ról.
  //
  // MIÉRT KELLETT HÁROM KÖR: a `#2a2a2a`/`#3a3a3a` SEMLEGES szürke volt
  // (R=G=B), de a terminálok gamma-kezelése és a betűk anti-aliasingja mellett
  // melegebbnek látszott a számított értéknél. Egy EXPLICIT kék eltolás ezt a
  // renderelési torzítást is elnyeli.
  //
  // MIÉRT NEM A NÉVVEL MEGADOTT ANSI-SZÍNEK: a `blue`/`cyan`/`white` a terminál
  // 16-színes palettájának tagjai, amiket a témák VILÁGOSRA is állíthatnak — a
  // `blue` a legtöbb sötét témában épp elég világos ahhoz, hogy a világos
  // betűszínek beleolvadjanak (ez volt a lelet). A hex-érték viszont a TRUE COLOR
  // csatornán megy, tehát a téma nem írja át: a `#2a2a2a` a tipikus sötét
  // terminál-háttérnél (`#1e1e1e`…`#000`) EGY FOKKAL világosabb, ami elég a sor
  // kijelöléséhez, de a világos előtér-színeket (a mark zöld/sárga/piros, az
  // author magenta) érintetlenül hagyja.
  //
  // FALLBACK: 256-színes vagy 16-színes terminálon a chalk a legközelebbi
  // paletta-taghoz kvantál — az a sötét szürke/fekete, tehát a viselkedés ott is
  // "alig világosabb háttér", nem elmosott szöveg.
  //
  // MINDEN SZEGMENSRE KELL: az Ink a `backgroundColor`-t Text-enként alkalmazza,
  // tehát egy kihagyott szegmens LYUKAT hagyna a kiemelésben. Ezért egy közös
  // `bg` objektum spreadelődik mindenhová — így egy jövőbeli új szegmens
  // hozzáadásakor a hiba SZEMBESZÖKŐ (a lyuk látszik), nem néma.
  //
  // A LEZÁRT (mergelt) SOR NEM KAP HÁTTERET akkor sem, ha kiválasztott: ott a
  // `faded` a szándék (a sorsa lezárult), és egy kiemelt-de-halk sor önmagával
  // vitatkozna.
  const bg = selected && !faded ? { backgroundColor: '#3a4250' } : {}
  // (wf31/29) A SOR SZEGMENSEI ELŐBB LISTÁBA, AZTÁN CELLÁRA VÁGVA — EZ A
  // RESIZE-GLITCH VALÓDI JAVÍTÁSA.
  //
  // A MÉRT MECHANIZMUS (a user paste-elt képéből: a fejléc többször íródik ki
  // ugyanabba a sorba, a sorok egymásba folynak): az Ink `log-update`-je a
  // KORÁBBI frame SORSZÁMÁT törli (`eraseLines(previousLineCount)`), és ezt a
  // szám[ot] a SAJÁT layoutjából ismeri. Ha viszont egy kiírt sor SZÉLESEBB a
  // terminálnál, a terminál TÖRDELI — a képernyőn TÖBB fizikai sor lesz, mint
  // amennyit az Ink számol. A törlés így ALULMARAD, és a maradék ott ragad. Az
  // Ink `resized` handlere csak SZŰKÍTÉSNÉL töröl teljes képernyőt
  // (`currentWidth < lastTerminalWidth`), szélesítésnél NEM — ezért esett szét
  // mindkét irányban.
  //
  // MIÉRT NEM VOLT ELÉG A `layout.width` (wf31/27-28): az a TARTALOMBÓL számolt
  // tábla-szélesség, ami a terminálnál SZŰKEBB szokott lenni — de a resize
  // KÖZBEN a React-state és a valódi terminál-méret ELTÉR (az Ink
  // `useWindowSize`-a egy tickkel késik). Abban a résben a sor a MÉG RÉGI,
  // szélesebb mértékkel épül, miközben a terminál MÁR szűkebb.
  //
  // A FAIL-SAFE TEHÁT A RENDERELŐBEN KELL, nem a layoutban: bármit is ad a
  // layout, a KIÍRT sor SOSEM lehet szélesebb a terminálnál. A vágás CELLÁBAN
  // megy (`clampCells`), tehát az emojis markokat (⚠️/⛔/⬆️, 2 cella) sem hasítja
  // félbe.
  const segs = [
    { text: cursor, color: selected ? 'cyan' : undefined },
    { text: indentPrefix, dimOverride: dim || !row.selectable },
    { text: `#${String(row.number).padEnd(5)} `, bold: selected },
    { text: `${String(row.author).slice(0, 5).padEnd(5)} `, color: 'magenta' },
    { text: `${title} ` },
    { text: row.mark.label, color: row.mark.color },
    // (wf31/52) A CONFLICT-TENGELY JELZŐI A MARK MELLÉ, AZ RMARK ELŐTT.
    //
    // A user lelete: `⚠️ conflict · ○ approve vár (forrás?)` — "ahol a »forrás?« a
    // conflictra vonatkozik". A régi sorrend (mark → rmark → MINDEN flag) az
    // approve-oszlop mögé vitte azt, ami a markról beszél, és a szem oda is
    // olvasta: mintha a jóváhagyás várna a forrásra.
    //
    // A CSOPORTOSÍTÁS ADATBÓL JÖN (`axis: 'mark'`, lásd a `flagsFor` fejét), nem a
    // renderelő találgatásából — így a lista és a bash-nézet ugyanarról a tényről
    // ugyanazt a csoportosítást mondja, és egy új jelző hozzáadásakor a HELYE is a
    // definíciójában dől el, nem itt.
    ...(showFlags
      ? row.flags
          .filter((f) => f.axis === 'mark')
          .map((f) => ({ text: ` ${f.label}`, color: f.color }))
      : []),
    ...(showRmark
      ? [
          { text: ' · ', dimOverride: true },
          { text: row.rmark.label, color: row.rmark.color },
        ]
      : []),
    // A TÖBBI JELZŐ (stack-tengely, meta: review-nyom, cache-státusz, spinner) a
    // sor VÉGÉN marad: a tail-degradáció ezeket dobja el először, és ez szándékos —
    // a metaadat nem tolhatja jobbra azt, amiért a user a sort olvassa.
    ...(showFlags
      ? row.flags
          .filter((f) => f.axis !== 'mark')
          .map((f) => ({ text: ` ${f.label}`, color: f.color }))
      : []),
  ]
  // A KIEMELÉS HÁTTERE a sor VÉGÉIG (a `columns` a TÁBLA szélessége — lásd a
  // hívási helyet). Csak a kiválasztott soron, és csak ha van maradék hely.
  const used = segs.reduce((n, seg) => n + displayWidth(seg.text), 0)
  if (Object.keys(bg).length > 0 && columns > used) {
    segs.push({ text: ' '.repeat(columns - used) })
  }
  // A KEMÉNY PLAFON: a terminál TÉNYLEGES szélessége. A `columns` a táblát írja
  // le (ami szűkebb lehet), a `terminalColumns` a fizikai korlátot — a kettő
  // közül a KISEBB nyer, és a `clampCells` szegmensenként fogyasztja a büdzsét.
  const hardLimit = terminalColumns > 0 ? terminalColumns : Number.POSITIVE_INFINITY
  let left = hardLimit
  const out = []
  for (const [i, seg] of segs.entries()) {
    if (left <= 0) break
    const text = clampCells(seg.text, left)
    if (text === '') continue
    left -= displayWidth(text)
    out.push(h(Text, {
      key: `s${i}`,
      ...bg,
      // A FAKÓ SZÍN CSAK OTT, AHOL NINCS SAJÁT: a tompított szegmensek a hívónál
      // már `undefined` színt kapnak (`faded ? undefined : …`), tehát ez a `??`
      // pontosan azokra üt, amiket tompítani akarunk — az éles sorok szemantikus
      // színeit (zöld approved, piros conflict) NEM írja felül.
      //
      // ÉS AHOL A SZÍN TOMPÍT, OTT A `dim` KIESIK (`fadedByColor`): a kettő
      // EGYMÁSON egy egész fokozattal túl sötét (lásd a `FADED_COLOR` fejénél a
      // három lépcsőt). Egy `dimOverride: true` szegmens (pl. a ` · ` szeparátor)
      // ettől függetlenül dim marad — az EXPLICIT szándék, nem a fakulás
      // mellékhatása.
      // A NYUGALMI SZÍN A TÉMÁÉ (`undefined` = a terminál alapszíne) — SOSEM a
      // miénk (wf31/59: a témát átíró `baseColor` mért hiba volt). Tompításkor
      // viszont MINDEN szegmens a saját színéből tweenel (wf31/61) — a nevesített
      // színek is, ezért nem `seg.color ?? …`, hanem teljes csere faded alatt.
      color: faded ? fadePaint(seg) : seg.color,
      bold: seg.bold,
      dimColor: seg.dimOverride ?? (faded ? undefined : dim),
    }, text))
  }
  return h(Box, null, ...out)
}

  // AZ EGYESÍTETT INFO-PANEL ('i'). KÉT SÁV, a KÖLTSÉG szerint elválasztva:
  //
  //   GYORS (fent): amit a queue-modell MÁR tud — dep-metszet, mergeMethod,
  //     landolás-blokkolók, stacked-info. Nulla várakozás, mindig teljes.
  //   MÉRT (lent): a merge-tree próbák eredménye. Amíg fut, ÉLŐ status-sor
  //     ("mérés: 3/7 jelölt…"); amikor kész, beilleszkedik. Esc: megszakítás.
  //
  // A sávok NEM keverednek: a mérés alatt (és abortálás után) a mért állításokat
  // NEM írjuk ki. Egy félbehagyott próba-sorozat se conflictot, se annak hiányát
  // nem bizonyítja — a "✓ main: nincs conflict (mérve)" sor ott HAZUG lenne.
//
// A PANEL MOSTANTÓL OVERLAY, nem teljes képernyő: a lista TOMPÍTVA alatta marad.
// A cím és a lábléc az overlay KERETÉÉ (core: overlayFrame) — a body csak a
// tartalmat adja, tehát a cím/lábléc EGY forrásból jön minden overlayre, és nem
// csúszhat szét panelenként (ez volt a keybind-hivatkozások régi bug-osztálya).
// A HÁROM BODY (info / confirm / error) NEM Ink-fát ad, hanem SOR-LEÍRÓKAT:
// `{ text, color?, dimColor?, bold?, key? }`.
//
// MIÉRT (MÉRT BUG, ÉLŐ RENDERBŐL): a panelt a MAGASSÁG szerint el kell tudni
// vágni (a `panelViewport` + `clipBodyLines` szerződése), és a MEGJELENÍTETT
// sorok számához a SZÖVEGET kell megmérni — egy már összeállított Ink-fából a
// tördelt sorszám nem olvasható ki. Az első változat pontosan ezért hazudott: a
// nézet KIÍRTA, hogy "a panel csonkolva", de a törzs teljes egészében
// renderelődött, és 12 soros terminálon a FEJLÉC kicsúszott.
//
// === A MÉRÉSI CAVEAT LÁBJEGYZETE — a Verdict-blokk progresszív disclosure-je ==
//
// A USER BEJELENTÉSE: a `Verdict: clean` alatti 3-4 soros magyarázat MINDEN
// nem-blokkoló PR-on SZÓ SZERINT UGYANAZ, tehát warning fatigue-ot termel (a
// negyedik PR-nál a user már át sem olvassa). Lábjegyzetet kért: jelölés + "több
// info", és billentyűre nyíljon ki.
//
// A JELÖLÉS `…`, ÉS EZ NEM ÖNKÉNYES: ez a projekt MEGLÉVŐ "van még" idiómája —
// a dep-fájllista (`… +N további`), az error-body (`… és további N sor`), a
// panel-csonkolás és az AI-verdict csonkolása is ezt használja. Egy ötödik,
// konkurrens jelölés (`*`) új szótárat nyitna ugyanarra a fogalomra.
//
// AZ AFFORDANCE A SORON VAN, NEM A LÁBLÉCBEN: a lábléc már 7 szegmens, és 100
// oszloposnál a `clampCells` határán áll — egy nyolcadik szegmens ott MÁST
// vágna le. A soron álló jelzés amúgy is erősebb: ott van, ahol a tartalom.
//
// AMI CSUKVA IS MEGMARAD (kötelem): a `git rebase` MAGA a UI EGYETLEN helye,
// ahol a felszólítás elhangzik, és MÉRT tényen áll (a merge-tree MERGE-öt
// szimulál, a CI REBASE-el — fixture-ön mérve: merge-tree exit 0, git rebase
// CONFLICT). A csukott sor ezért az ACTIONABLE MAGOT hordozza ("a mérés
// MERGE-öt szimulál, a CI REBASE-el"), csak a kifejtést és a parancsot rejti el.
//
// A NYITOTT ALAKBAN A LÉNYEG A BLOKK ELEJÉN áll: szűk terminálon a magasság-vágás
// a VÉGÉT viszi el (`clipBodyLines`), tehát a fenntartás magja nem kerülhet a
// blokk aljára.

// (wf31/10) A MÉRÉSI SOROK IS A TOGGLE MÖGÉ KERÜLNEK — DE CSAK A `clean` ÁGON.
//
// A USER LELETE, szó szerint: "Az a két pipás sor még mindig nem tetszik. […] Egy
// negatív információt fogalmaznak meg. Miért nincsenek a »Verdict: clean« rejtése
// mögött?"
//
// A MÉRT REDUNDANCIA a clean-panelen HÁROM sor, EGY állítással:
//     ✓ main: nincs conflict (mérve) — a landolásod nincs veszélyben
//     ✓ next-en belül: nincs ütközés (4 jelölt megmérve)
//     Verdict: clean
// A `clean` verdict DEFINÍCIÓ SZERINT azt jelenti, hogy egyik tengelyen sincs
// conflict (lásd a bash `$verdict` levezetését: `mainConflict` → main-conflict,
// `queueConflicts` → next-only-conflict, EGYÉBKÉNT clean). A két pipás sor tehát
// a verdict KIFEJTÉSE, nem új információ — pontosan az, amit a wf31/4-ben a
// negyedik (összegző) sorral már megtettünk. Ugyanaz a fogalom, ugyanaz a hely.
//
// MIÉRT CSAK A `clean` ÁGON: a NEGATÍV ágakon a sor MAGA a hír. A
// `✗ main: VALÓDI conflict — <fájlok>` a fájlneveket is hordozza (amit a verdict
// nem), a `⚠ next-en belül: ütközik` alatt pedig a culprit-fájlsorok állnak. Ott
// az elrejtés a legfontosabb információt vinné a toggle mögé — a szabály tehát
// nem "a mérési sorok rejtve", hanem "a REDUNDANCIA rejtve".

// (wf31/30) A CSUKOTT/NYITOTT TOGGLE KIVEZETVE — KÉT ÁLLAPOT VAN, NEM HÁROM.
//
// A USER DÖNTÉSE, szó szerint: "az info panelben három állapota van a detailed
// infónak a main-nel szemben: idle (nincs infó, felajánlja a c-t), verdict
// collapsed, és verdict expanded. És az Enter itt foglalt. Ez így nem jó. KETTŐ
// állapot legyen. Idle és betöltött részletek. Igy felszabadul az Enter az info
// toggle-ra".
//
// AMI MEGSZŰNT: a `caveatOpen` state, a `…`-affordance sor (`CAVEAT_HINT`), a
// tömörített mag (`CAVEAT_GIST`) és a degradáló `caveatClosedLine`. A caveat
// MOSTANTÓL MINDIG a kifejtett alakjában látszik, ha egyáltalán van mérés.
//
// MIÉRT NEM VESZÍTÜNK VELE: a toggle a wf31/4-ben azért született, hogy a MINDEN
// PR-on azonos, 3-4 soros magyarázat ne termeljen warning fatigue-ot. Azóta
// viszont a mérés maga EXPLICIT gesztus lett (`c`, wf31/10): a caveat CSAK akkor
// jelenik meg, ha a user KÉRTE a mérést — tehát nincs mit „minden PR-on"
// átolvasni. A fatigue-érv elesett, a toggle költsége (egy foglalt kulcs +
// harmadik állapot) megmaradt.
//
// AZ ENTER ÍGY FELSZABADULT a panel-zárásra (lásd az app `key.return` ágát).

/**
 * A caveat-lábjegyzet SOR-LEÍRÓI — a KIFEJTETT blokk.
 *
 * A `caveat` a `conflictAdvice` KÜLÖN mezője (`{ text, command, detail }` vagy
 * `null`). A `null` ág ÜRES listát ad, nem egy üres sort: caveat nélkül (stackelt
 * PR, main-conflict, nem mért sor) nincs mit kifejteni.
 *
 * @param {Array} hidden (wf31/10) A blokk ELEJÉRE kerülő, KÉSZ sor-leírók — a
 *   `clean` ág két mérési sora. MIÉRT PARAMÉTER, és miért nem a `detail`
 *   stringjébe fűzve: ezek SZÍNEZETT, GLIFES sorok (`✓` + zöld/dim), a `detail`
 *   viszont egyetlen, dimmelt PRÓZA-blokk, amit a `wrapCells` tördel. Egy
 *   stringbe fűzve elvesztenék a színüket és a sortörésük is a próza-tördelésre
 *   csúszna — a `✓ main: …` és a `✓ next-en belül: …` egy bekezdésbe olvadna.
 */
function caveatLines(caveat, innerWidth, hidden = []) {
  if (!caveat) return []
  // A PRÓZA a keret belső szélességére tördelve — a core wrapCells-ével, azzal a
  // MÉRTÉKKEL, amivel a keret is számol (nem az Ink saját tördelésével, ami a
  // keretet szétvetné). A folytatás-sorok 2 cellával behúzva, hogy a blokk
  // egyben látszódjon.
  //
  // A BEHÚZÁS A TÖRDELÉS MÉRTÉKÉBE VAN BESZÁMÍTVA, nem utólag hozzátéve — MÉRT
  // HIBA volt (élő 56 oszlopos render): a behúzást a `wrapCells` UTÁN adva a
  // folytatás-sor CELLÁBAN túllógott (61 cella egy 60-as keretben), az Ink
  // újratördelte, és egy szó önálló sorra került. A keret nem esett szét, de a
  // `clipBodyLines` MÉRÉSE és a valóság elcsúszott — és a magasság-vágás
  // MEGJELENÍTETT sorokat számol, tehát egy Ink-újratördelés több sort renderel,
  // mint amennyit mértünk (a fejléc kicsúszásának mért osztálya).
  //
  // UGYANAZ AZ ELV, mint a `Row` behúzás-prefixe és a `listLayout` title-büdzséje
  // között: EGY mérték, és a behúzás a büdzséből jön le, nem a sor végéhez adódik.
  const CAVEAT_INDENT = '  '
  const proseRoom = Math.max(1, innerWidth - displayWidth(CAVEAT_INDENT))
  // (wf31/32) AZ ÜRES `text` NEM SZÜL SORT. A `nextFrom: 'ci'` ágon nincs
  // fenntartás (a CI tényleges rebase-e ment át, nem a mi merge-szimulációnk),
  // tehát a caveat CSAK a `detail`-t hordozza. Egy üres prózából a naiv
  // `⚠ ${text}` egy magányos `⚠`-ot adna — figyelmeztetés tartalom nélkül, ami a
  // legrosszabb: a szem odaugrik, és nincs mit elolvasni.
  const caveatText = String(caveat.text ?? '').trim()
  const prose = caveatText === '' ? [] : wrapCells(`⚠ ${caveatText}`, proseRoom)
  // (wf31/4) A MÉRÉS EREDMÉNYE (`detail`) A NYITOTT BLOKK ELSŐ BEKEZDÉSE.
  //
  // A user lelete: a `Verdict: clean` alatti "A merge-tree próba NEM talált
  // conflictot (N jelölt megmérve)…" mondat ugyanazt mondta, mint a Verdict ÉS a
  // két mérési sor fölötte — "elrejtendő részlet". A mondat tehát ide került, a
  // MEGLÉVŐ Enter-toggle mögé: csukva csak a `Verdict: clean` + az egysoros `…`
  // affordance látszik, nyitva a mért tény is előjön.
  //
  // AZ ELREJTÉS NEM TÖRLÉS: a jelölt-szám a MÉRÉS TERJEDELMÉT mondja ki, ami
  // attesztációs tény — a `detail` megőrzi.
  //
  // MIÉRT A BLOKK ELEJÉN, ÉS NEM A CAVEAT-PRÓZA UTÁN: a `detail` a MÉRT TÉNY, a
  // `text` pedig a FENNTARTÁS róla — a tény előbb jön, mint a hozzá tartozó
  // kikötés. Ez egyben a magasság-vágást is helyesen rendezi: a `clipBodyLines` a
  // blokk VÉGÉT viszi el, tehát a legfontosabb rész nem kerülhet az aljára
  // (ugyanaz az elv, ami e fejezet fejében ki van mondva).
  //
  // DIMMELT, NEM SÁRGA: ez NEM figyelmeztetés, hanem egy mért, kedvező eredmény —
  // a sárga a caveat sajátja (a valódi fenntartás). A szín-inflálás ugyanaz a
  // hibaosztály, amit a Verdict-blokk zöldje kapcsán a modul kimond.
  const detailLines = String(caveat.detail ?? '').trim() === ''
    ? []
    : wrapCells(String(caveat.detail), proseRoom).map((line, i) => ({
        key: `cav-d-${i}`,
        dimColor: true,
        text: i === 0 ? line : `${CAVEAT_INDENT}${line}`,
      }))
  return [
    // (wf31/10) A MÉRÉSI SOROK LEGELŐL: ezek a MÉRT TÉNYEK, a `detail` az
    // összegzésük, a `prose` pedig a fenntartás róluk — a sorrend a konkréttól az
    // általánosig megy. A blokk-vég vágása (`clipBodyLines`) így a legkevésbé
    // fontos részt viszi el, ami e fejezet kimondott elve.
    ...hidden,
    ...detailLines,
    ...prose.map((line, i) => ({
      key: `cav-${i}`,
      color: 'yellow',
      text: i === 0 ? line : `${CAVEAT_INDENT}${line}`,
    })),
    // A PARANCS CYAN, külön sorban: a panel MINDEN végrehajtandó parancsát így
    // írja (a stackelés-ajánlás és a branch-név is cyan). A behúzás a
    // "parancs, amit begépelsz" tipográfiája.
    //
    // (wf31/32) ÜRES PARANCS → NINCS SOR: a `nextFrom: 'ci'` ágon nincs teendő (a
    // PR már beépült), tehát egy üres, behúzott cyan sor csak MAGASSÁGOT vinne el a
    // render-fából — ugyanaz a hibaosztály, amit a wf28/3-as gap-sor kimondott.
    ...(String(caveat.command ?? '').trim() === ''
      ? []
      : [{ key: 'cav-cmd', color: 'cyan', text: clampCells(`    ${caveat.command}`, innerWidth) }]),
    // (wf31/30) A ZÁRÓ AFFORDANCE-SOR KIVEZETVE a toggle-lal együtt: nincs mit
    // összecsukni, tehát egy `… Enter: összecsukás` sor DEAD KEY-t hirdetne (az
    // Enter mostantól a PANELT zárja).
  ]
}

// A LEÍRÓ → Ink konverzió EGY helyen (renderLines) történik, a vágás UTÁN.
//
// (wf31/30) A `caveatOpen` PARAMÉTER KIVEZETVE: a caveat MINDIG kifejtve látszik
// (két állapot: nincs mérés / van mérés). Az indoklás a `caveatLines` fejénél áll.
export function infoBody(info, innerWidth = 100, reviewLines = []) {
  const model = buildInfoModel(info)
  const { row, fast, slow } = model
  const dep = fast.dep
  // (wf31/10) A MÉRT SÁV KÉT TENGELY-SORA — EGY helyen összeállítva, mert KÉT
  // helyre kell: `clean` verdicten a caveat-toggle MÖGÉ (`hidden`), egyébként a
  // látható részbe. Két másolatban írva pontosan az az elcsúszás jönne, amit ez a
  // modul máshol is tilt (a bash riportjával EGYEZŐ mondatokat egy teszt köti —
  // két helyre írva az egyik példány maradna le a javításokról).
  //
  // A `slow.state !== 'done'` ágakon ÜRES: nincs mért diagnózis, tehát nincs mit
  // sorba tenni (a `measuring`/`aborted`/`error` ágak SAJÁT sorokat adnak).
  //
  // A QUEUE-TENGELY SOR-PÁRJA — GLIF = KATEGÓRIA, SZÍN = SÚLY.
  //
  // A USER BEJELENTÉSE: a main-ág zöld+pipás volt, a queue-ág pipa nélküli és
  // szürke — ez INKONZISZTENS SÚLYT sugallt, holott mindkettő ugyanolyan mért
  // tény, ugyanabból a próba-sorozatból.
  //
  // A JAVÍTÁS KÉT RÉSZE:
  //   (1) a `✓` bekerül a pozitív queue-ágra is (a glif a KATEGÓRIÁT mondja:
  //       "megmértük, és rendben van");
  //   (2) DE a sor DIM MARAD, nem lesz zöld. MIÉRT NEM ZÖLD: a zöld a
  //       MAIN-tengelyé — az dönti el, veszélyben van-e a landolás. Ha a queue-ág
  //       is zöldet kapna, a zöld INFLÁLÓDNA, és a main mért ELSŐBBSÉGE elmosódna
  //       (a fordított hiba ugyanabból a családból).
  //
  // A MONDATSZERKEZET PÁRHUZAMOS: EGY alany ("next-en belül"), KÉT állítmány
  // ("nincs ütközés" / "ütközik"). A régi pár két KÜLÖN fogalmat nevezett meg
  // ("queue-belső ütközés" vs. "a next-en belül"), amitől a két sor nem is
  // látszott egy tengely két állásának.
  //
  // A ⚠ (text-presentation, 1 cella) az EMOJI ⚠️ (2 cella) HELYETT — MÉRVE valódi
  // terminálban (tmux cursor_x: 2 vs. 1), és a `displayWidth` MINDKETTŐT helyesen
  // számolja (a VS16-lookahead miatt), tehát a váltás a cella-aritmetikát NEM
  // érinti; a sor 3 cellával rövidebb is lett. A text-alak amúgy is ELŐZMÉNY a
  // kódbázisban: a caveat-sorok (ai-review-view) és a sor-flagek (rows) is így írják.
  //
  // A CULPRIT-FÁJLSOROK CYAN-ok, mint a dep-fájllista: ugyanaz a fogalom
  // (érintett fájlok), tehát ugyanaz a szín — szín nélkül a két fájllista két
  // külön dolognak látszott.
  const measurementLines = slow.state !== 'done' ? [] : [
    slow.diag.mainConflict
      ? { key: 'mt-main', color: 'red', text: `✗ main: VALÓDI conflict — ${slow.diag.mainConflictFiles.join(', ')}` }
      : { key: 'mt-main', color: 'green', text: '✓ main: nincs conflict (mérve) — a landolásod nincs veszélyben' },
    ...(slow.diag.queueConflicts.length > 0
      ? [
          { key: 'mt-q', color: 'yellow', text: `⚠ next-en belül: ütközik (${slow.diag.probed} jelölt megmérve)` },
          ...slow.diag.queueConflicts.map((c) =>
            ({ key: `cul-${c.number}`, color: 'cyan', text: `    #${c.number}  ${c.files.join(', ')}` })),
        ]
      // (wf31/32) A SOR KIMONDJA, HONNAN TUDJUK — a `nextFrom` mezőből, nem a
      // `probed` számból. A `0 jelölt megmérve` a `ci` ágon HAZUG lenne: ott nem
      // mértünk, hanem a next gráfjából tudjuk (a CI kumulatív rebase-e átment). A
      // `probed: 0` amúgy is KÉTFÉLEKÉPPEN áll elő („megkerültük" / „nincs
      // jelölt"), tehát következtetni sem lehetne belőle.
      : slow.diag.nextFrom === 'ci'
      ? [{ key: 'mt-q', dimColor: true, text: '✓ next: beépült (a CI kumulatív rebase-e átment)' }]
      : [{ key: 'mt-q', dimColor: true, text: `✓ next-en belül: nincs ütközés (${slow.diag.probed} jelölt megmérve)` }]),
  ]
  // A `clean` VERDICT A REJTÉS KAPUJA — a MÉRT verdictből, nem a sorok
  // tartalmából visszakövetkeztetve. MIÉRT A VERDICT: a bash `$verdict`-je a
  // DÖNTÉS forrása (`mainConflict` → main-conflict, `queueConflicts` →
  // next-only-conflict, egyébként clean), tehát ez az EGYETLEN hely, ahol a
  // "nincs semmi baj" tény egyetlen mezőben áll. A sorokból következtetni
  // (mindkettő `✓`-vel kezdődik?) szöveg-parszolás lenne a MÉRT adat helyett.
  const verdictClean = slow.state === 'done' && slow.diag.verdict === 'clean'
  // A BRANCH-NÉV külön sorban, KÖZVETLENÜL a merge-method alatt (user-kérés: a
  // method a névből ellenőrizhető, tehát a kettő egymás mellett kell). A
  // csonkolás a keret belső szélességéhez van kötve, és a "branch: " előtag
  // szélességét is levonjuk — különben pont az előtaggal lógna túl a sor.
  const BRANCH_PREFIX = 'branch: '
  const branchRoom = Math.max(1, innerWidth - displayWidth(BRANCH_PREFIX))
  return [

    // --- AZ AI-REVIEW SZEKCIÓ (3) — LEGFELÜL, ha van -----------------------
    //
    // A user 3. pontja: a megerősítés, a progressz, a végállapot, a findingok
    // rövid listája és a betöltés-ajánlat MIND a PR-panelben él. A szekció a
    // panel TETEJÉN áll: futó review alatt ez a legfrissebb (másodpercenként
    // mozgó) információ, és a user pontosan ezért nyitja a panelt. A sorokat a
    // core tiszta függvénye adja (aiReviewPanelLines), cellában clampelve.
    ...(reviewLines.length > 0 ? [...reviewLines, { text: ' ' }] : []),

    // --- GYORS SÁV -------------------------------------------------------
    { dimColor: true, text: `állapot: ${fast.state}${fast.mergeMethod ? ` · merge-method: ${fast.mergeMethod}` : ''}` },
    // A branch neve a metódus FORRÁSA: a prefix (`squash-`/`rebase-`/minden más)
    // dönti el a metódust, tehát ez a sor az, amivel a user a fenti
    // merge-method sort ELLENŐRZI. Ezért áll közvetlenül alatta, és ezért
    // középen csonkolunk (a prefix ÉS a névvég is látszik) — lásd branchLabel.
    { color: 'cyan', text: `${BRANCH_PREFIX}${branchLabel(fast.headRefName, branchRoom)}` },
    ...(fast.stackedOn !== null
      ? [{ color: 'cyan', text: `⬆️ stackelt PR — a talapzata a #${fast.stackedOn}, a sorsa ott dől el` }]
      : []),
    ...(fast.landableBlockers.length > 0
      ? [
          { color: 'yellow', text: 'a landolás blokkolói:' },
          // A KULCSOK PREFIXÁLTAK, nem puszta indexek. Ez a panel EGY Box
          // gyerekei közé HÁROM listát terít szét (blokkolók, közös fájlok,
          // culpritok); puszta index mellett mindhárom a 0-ról indulna, és a
          // React ("two children with the same key, `0`") duplikálhatja vagy
          // ELHAGYHATJA a sorokat. Élő renderben ez négy warningot adott.
          ...fast.landableBlockers.map((b, i) => ({ key: `blk-${i}`, color: 'yellow', text: `    · ${b}` })),
        ]
      : [{ color: 'green', text: '✓ landolható (approved + green + mergeable)' }]),
    { text: ' ' },
    dep.hasDep
      ? { color: 'cyan', text: `⚡ dep: #${dep.dep} (a queue-ban ELŐTTE áll, még nyitott)` }
      : { dimColor: true, text: dep.summary },
    ...(dep.hasDep
      ? dep.filesUnknown
        // Fail-closed dep adathiánnyal: a függés ténye áll, a MIBEN nem. Ezt
        // ki kell mondani — az üres fájl-lista NEM "nincs közös fájl".
        ? [
            { color: 'yellow', text: '⚠️ a közös fájlok listája NEM tudható' },
            { dimColor: true, text: '   (a files-adat hiányzik — nagy PR-nál a GitHub limitálja)' },
            { dimColor: true, text: '   a függést ezért fail-closed jelentjük: inkább jelezzük, mint elnyeljük' },
          ]
        : [
            { text: `közös fájlok (${dep.files.length}):` },
            ...dep.shown.map((f, i) => ({ key: `depf-${i}`, color: 'cyan', text: `    ${f}` })),
            ...(dep.more > 0 ? [{ dimColor: true, text: `    ${dep.moreLabel}` }] : []),
            // A metszet HEURISZTIKA, a conflict MÉRÉS. Ezt azért mondjuk ki,
            // hogy a user ne olvasson mért tényt egy fájl-metszetből — a mért
            // választ a panel alsó sávja adja.
            { dimColor: true, text: 'a metszet nem jelent conflictot — azt az alábbi mérés adja' },
          ]
      : []),
    { text: ' ' },

    // --- MÉRT SÁV --------------------------------------------------------
    ...(!model.measurable
      ? [{ dimColor: true, text: 'conflict-mérés: nincs — a stackelt PR sorsa a talapzatán dől el, diagnosztizáld azt' }]
      : slow.state === 'measuring'
      ? [
          { color: 'cyan', text: `⏳ ${slow.label}` },
          { dimColor: true, text: '   (merge-tree próbák a queue-ban előtte álló PR-okra — Esc: megszakítás)' },
        ]
      : slow.state === 'aborted'
      ? [
          { color: 'yellow', text: `⚠️ ${slow.label}` },
          { dimColor: true, text: '   a részleges mérés NEM bizonyít se conflictot, se annak hiányát' },
        ]
      : slow.state === 'error'
      ? [
          { color: 'red', text: `✗ ${slow.label}` },
          { dimColor: true, text: '   a mérés NEM futott le — ebből nem következik, hogy nincs conflict' },
        ]
      : slow.state === 'done'
      ? [
          // (wf31/10) A `clean` ÁGON A KÉT MÉRÉSI SOR A TOGGLE MÖGÉ MEGY — a
          // szekció fejében álló indoklás szerint (a verdict kifejtése, nem új
          // információ). A `measurementLines` alább áll össze; itt a `clean`
          // esetben ÜRES a látható rész, és a sorok a `caveatLines` `hidden`
          // paraméterén jutnak a nyitott blokkba.
          //
          // A NEGATÍV ágak VÁLTOZATLANOK: ott a sor maga a hír (fájlnevekkel,
          // culprit-listával), tehát nem rejthető.
          ...(verdictClean ? [] : measurementLines),
          // A GAP-SOR CSAK AKKOR KELL, HA VAN MIT ELVÁLASZTANI: `clean` ágon a
          // mérési sorok a toggle mögé kerültek, tehát a `Verdict` a szekció ELSŐ
          // sora — egy fölötte álló üres sor ott dupla kihagyást adna (a MÉRT SÁV
          // fölött már van egy). Egy üres sor-leíró ugyanazt a MAGASSÁGOT viszi el
          // a render-fából, mint egy tartalmas (a `clipBodyLines` MEGJELENÍTETT
          // sorokat számol) — ez a wf28/3 gap-sorával megegyező hibaosztály.
          ...(verdictClean ? [] : [{ text: ' ' }]),
          { bold: true, text: `Verdict: ${slow.diag.verdict}` },
          // (wf31/4) AZ ÜRES SUMMARY NEM SZÜL SORT. A `clean` ág summary-ja
          // ÜRES lett (a mérési eredmény a caveat `detail`-jébe került — lásd a
          // diagnosis `conflictAdvice` clean-ágát), és egy üres sor-leíró
          // ugyanazt a MAGASSÁGOT vinné el a render-fából, mint egy tartalmas:
          // a `clipBodyLines` MEGJELENÍTETT sorokat számol. Ez a `menuExtraRows`
          // gap-sorával megegyező hibaosztály (wf28/3) — a sor tehát MEG SEM
          // SZÜLETIK, nem "üresen renderelődik".
          // (wf31/52) A SUMMARY TÖRDELVE, NEM CSONKOLVA. A user lelete: "a
          // verdictben le van cappelve vízszintesen a stack célra vonatkozó
          // megjegyzés" — a mondat közepén, "ha funkcionális…"-nál.
          //
          // AZ OK: a `renderLines` a render-modul `Text`-jét használja, ami
          // `wrap: 'truncate'` (a resize-flicker miatt, wf31/39) — egy hosszú
          // egysoros leíró tehát NÉMÁN a jobb szélen véget ér. A summary itt 3-4
          // mondat, vagyis STRUKTURÁLISAN nem egysoros tartalom.
          //
          // A JAVÍTÁS a `wrapCells`: cellában tördel a panel belső szélességére,
          // és MINDEN sor önálló leíró lesz. Ugyanaz a minta, amit az AI-összegző
          // már használ (`aiReviewPanelLines`) — ott is 2-4 mondatot kell
          // megjeleníteni, ugyanabban a panelben.
          //
          // SOR-PLAFON NINCS: a `clipBodyLines` a panel MAGASSÁGÁT amúgy is
          // kezeli, és KIMONDJA a csonkolást ("… a panel csonkolva"). Egy második,
          // itteni plafon pont azt a hibát hozná vissza, amit az AI-összegzőnél a
          // wf31/50 megszüntetett: a verdict a legfontosabb tartalom a panelben.
          ...(String(slow.advice.summary ?? '').trim() === ''
            ? []
            : wrapCells(String(slow.advice.summary).trim(), innerWidth)
                .map((t, i) => ({ key: `adv-sum${i}`, text: t }))),
          // (wf31/68) A PARANCS INFORMÁCIÓKÉNT MARAD, AJÁNLÁSKÉNT NEM. A `s` gomb
          // a láblécben kínálja fel a végrehajtást, de az CSAK a PR SAJÁT
          // branchén működik (`doStack` branch-ellenőrzése) — aki máshol áll,
          // annak a parancs kell. A fejléc ezért feltételt mond, nem javaslatot:
          // hogy funkcionálisan rá épülsz-e, azt a gép nem tudja.
          ...(slow.advice.offerStack
            ? [
                { text: ' ' },
                { dimColor: true, text: `Ha funkcionálisan a #${slow.advice.stackOn}-re épülsz, a PR saját branchéről:` },
                { color: 'cyan', text: `  ${slow.advice.command}` },
              ]
            : []),
          // A MÉRÉSI CAVEAT LÁBJEGYZETE — LEGALUL, a TEENDŐK UTÁN.
          //
          // MIÉRT A VÉGÉN: ez FENNTARTÁS, nem teendő. A summary (mért tény) és a
          // stackelés-ajánlás (végrehajtható lépés) elé kerülve pont azt a
          // sorrendet állítaná vissza, ami a warning fatigue-ot termelte — a user
          // a tennivaló előtt olvasott egy minden PR-on azonos bekezdést.
          //
          // A `caveat` a `conflictAdvice` KÜLÖN mezője (nem a summary vége): a
          // disclosure így CSAK a fenntartást viszi el, a teendő látható marad.
          // (wf31/10) A `clean` ág MÉRÉSI SORAI a NYITOTT blokkba mennek. A
          // negatív ágakon a `hidden` ÜRES — ott a sorok a látható részen állnak
          // (a `verdictClean` kapuja fentebb), tehát duplikáció nem keletkezhet.
          ...caveatLines(
            slow.advice.caveat,
            innerWidth,
            verdictClean ? measurementLines : [],
          ),
        ]
      // (wf31/10) A NEM MÉRT ÁLLAPOT — EZ AZ ÚJ DEFAULT, ÉS NEM LEHET ÜRES.
      //
      // Korábban ide `[]` került (a panel-nyitás mindig mért, tehát ez az ág
      // gyakorlatilag elérhetetlen volt). Most, hogy a mérés EXPLICIT gesztus
      // (`c`), ez a TIPIKUS állapot — és egy üres sáv itt a legdrágább hiba lenne:
      // a user "nincs conflict"-ként olvasná a hallgatást. Ez ugyanaz az érv, ami
      // az `openInfo` cache-találat-ágában is ki van mondva ("a cache-találat sem
      // lehet csendes").
      //
      // A CI-BŐL SZÁRMAZÓ TUDÁS VISZONT NEM HALLGATÁS: a `next-conflict` /
      // `next-blocked` címke és a next-gráfba való beépülés a queue-modellből
      // ISMERT, mérés nélkül. A sor tehát KIMONDJA, amit tudunk, és a `c`-t csak
      // arra ajánlja, amit NEM tudunk (kivel ütközöm, ütközöm-e a main-nel).
      : [
          ...(fast.state === 'queue'
            // BEÉPÜLT A NEXT-BE: a CI kumulatív rebase-e ÁTMENT. Ez ERŐSEBB tény,
            // mint a lokális páros próba (az merge-öt szimulál) — tehát itt a
            // mérés nem hozzáad, hanem bizonytalanabb választ adna ugyanarra.
            ? [{ key: 'mt-ci', color: 'green', text: '✓ next: beépült (a CI kumulatív rebase-e átment)' }]
            : fast.state === 'conflict'
            // KIESETT: a címke ezt mondja, de azt NEM, hogy KIVEL ütközöm — ezt
            // csak a mérés adja meg (culprit-lista + stackelés-cél).
            ? [{ key: 'mt-ci', color: 'yellow', text: '⚠ next: kiesett (next-conflict — a CI rebase-e conflictolt)' }]
            : fast.state === 'blocked'
            ? [{ key: 'mt-ci', color: 'yellow', text: '⚠ next: kihagyva (next-blocked — workflow-fájlt módosít)' }]
            // MISSING: még nem futott rebuild ezzel a PR-ral. Nem tudunk semmit —
            // és ezt kimondjuk, nem hallgatjuk el.
            : [{ key: 'mt-ci', dimColor: true, text: '· next: még nem épült be (nem futott rebuild ezzel a PR-ral)' }]),
          // A MAIN-TENGELY NINCS MÉRVE, és ezt KI KELL MONDANI: a `next-conflict`
          // címke NEM mondja meg, hogy a main-nel ütközöm-e (a #911 mért esete: a
          // PR a main-nel MERGEABLE volt, a conflict forrása négy queue-belső PR).
          // Ez az egyetlen tengely, amit SEMMILYEN CI-jelzés nem ad meg.
          // (wf31/40) A „culpritok" ZSARGON KIVEZETVE. A user kérdése: "Mit jelent a
          // »main + culpritok«? Mi az hogy culprit?" — jogos: a szó a KÓDBAN
          // bejáratott (a `queueConflicts` elemei), a UI-ban viszont magyarázat
          // nélkül állt. A helyére az kerül, amit a mérés VALÓJÁBAN ad: a main-nel
          // való ütközés ténye, és hogy KIVEL ütközöl a queue-ban.
          { key: 'mt-hint', dimColor: true, text: clampCells('· main: nem mérve — c: mérés (ütközöm-e a main-nel, és kivel a queue-ban)', innerWidth) },
        ]),

    // (wf31/73) A FELOLDÁS AJÁNLATA — A `c: mérés` SOR HELYÉN, MÉRÉS UTÁN.
    //
    // A user kérése: "A parancs a status soron csak elemzés után jelenjen meg, és
    // legyen 'v: resolve', és a conflict parancs helyén jelenjen meg."
    //
    // A HELY EZÉRT UGYANAZ, mint a `mt-hint`-é: a mért sáv alja. Mérés ELŐTT ott a
    // `c: mérés` áll (nem tudjuk, van-e mit feloldani), mérés UTÁN — ha EGY culprit
    // van — a `v: resolve`. A kettő sosem látszik egyszerre: az egyik a mérés
    // hiányát, a másik az eredményét hirdeti.
    //
    // EGY CULPRIT A FELTÉTEL: a feloldás egy BÁZIS ellen megy (a rebase egy célra
    // mutat), és a `conflictAdvice` több culprit mellett `offerStack: false`-ot ad —
    // ugyanaz a forrás dönt itt is, tehát a `v` és a stackelés-ajánlat nem csúszhat szét.
    ...(slow.state === 'done' && slow.advice?.offerStack === true
      ? [{
          key: 'mt-resolve',
          color: 'cyan',
          text: clampCells(`· v: resolve — AI-feloldás a #${slow.advice.stackOn} culprittal (elemzés + a kód a worktree-ben)`, innerWidth),
        }]
      : []),

    // --- A KÖVETKEZŐ LÉPÉSEK: A PANEL SAJÁT LÁBLÉCE MONDJA, NEM A BODY -------
    //
    // ITT KORÁBBAN EGY MÁSODIK AKCIÓ-SOR ÁLLT:
    //   'tovább innen: d: diff-review · r: AI-review · a: approve · m: merge'
    //
    // TÖRÖLVE (user-kérés, szó szerint): "a lenyíló panelben két action sor van,
    // gyakorlatilag ugyanazokkal az opciókkal, ez teljesen felesleges".
    //
    // A MÉRT DUPLIKÁCIÓ: a panel keret-lábléce (core `panelFooter`, INLINE ág)
    // EGY SORRAL LEJJEBB pontosan ugyanazt a négy kulcsot hirdeti
    // (`d: diff · r: AI-review · a: approve · m: merge · j/k: sor · Esc: bezárás`),
    // sőt TÖBBET is: a j/k-t és az Esc-et. A body-sor tehát nem hordozott olyan
    // információt, ami máshol ne jelenne meg — a törléssel semmi nem veszett el.
    //
    // MIÉRT A LÁBLÉC A MEGFELELŐ HELY (és nem a body): a lábléc az overlay-keret
    // EGY forrásból jövő vezérlő-sávja, tehát a kulcs-hirdetés panelenként nem
    // csúszhat szét (ez volt a keybind-hivatkozások tanult bug-osztálya). A body
    // a TARTALOM — a kettő összemosása pont azt a kettős forrást hozta létre,
    // amit a refaktor máshol megszüntetett.
    //
    // A REFAKTOR EREDMÉNYE ÉL: az `a`/`m`/`r`/`d` a panelen BELÜL is éles (lásd a
    // panel-ágat a keybind-kezelőben) — csak nem hirdetjük kétszer.
  ]
}

/**
 * A HIBA-overlay tartalma: a nyers üzenet, CELLÁRA tördelve.
 *
 * A tördelés a core wrapCells-e (nem az Ink saját tördelése): a keret belső
 * szélességét MI számoljuk, tehát a tartalomnak is ugyanahhoz a mértékhez kell
 * igazodnia, különben a keret szétesik.
 *
 * A HOSSZ-KORLÁT: egy elhasalt `gh` több száz sort is önthet (pl. egy teljes
 * GraphQL-hibaobjektum). Az overlay ilyenkor kitolná a listát a képernyőről —
 * tehát pont a KONTEXTUST vinné el, amiért az overlay-refaktor készült. Az első
 * sorok a fontosak (ott van a hibakód/ok), a maradékot megszámolva jelezzük, nem
 * némán elhagyva: a user tudja, hogy van még, és hol keresse (a status-sor +
 * a terminál scrollback).
 */
const ERROR_BODY_MAX_LINES = 12

export function errorBody(errorState, innerWidth) {
  const lines = wrapCells(errorState.message, Math.max(1, innerWidth))
  const shown = lines.slice(0, ERROR_BODY_MAX_LINES)
  const hidden = lines.length - shown.length
  return [
    ...shown.map((line, i) => ({ key: `err-${i}`, color: 'red', text: line })),
    ...(hidden > 0
      ? [{ key: 'err-more', dimColor: true, text: `… és további ${hidden} sor (a teljes szöveg a terminál scrollbackjében)` }]
      : []),
  ]
}

/**
 * A SOR-LEÍRÓK → Ink-fa konverzió. EGY helyen, a magasság-vágás UTÁN.
 *
 * A `key` a leíróból jön, ha van; egyébként pozíció-alapú, DE `line-` prefixszel.
 * MIÉRT PREFIX: ez a panel EGY Box gyerekei közé HÁROM listát terít szét
 * (blokkolók, közös fájlok, culpritok), és puszta index mellett mindhárom a 0-ról
 * indulna — a React "two children with the same key" hibája duplikálhatja vagy
 * ELHAGYHATJA a sorokat. Élő renderben ez már adott négy warningot.
 */
export function renderLines(lines) {
  return lines.map((l, i) => {
    const key = l.key ?? `line-${i}`
    // (2) SZEGMENTÁLT SOR: egy soron BELÜL több színnel. A review-cascade-menü
    // második lépcsője kell ilyet — ott a figyelmeztetés PIROS, a `y`/`esc`
    // kulcsok viszont dimmeltek, EGY sorban (a user: horizontális menü).
    //
    // MIÉRT AZ INK Text-EGYMÁSBA-ÁGYAZÁSA, ÉS MIÉRT NEM EGY Box row-IRÁNNYAL: a
    // Box flex-elemként MÉRETET kap, és egy szűk kereten belül a saját tördelését
    // hozná — pontosan az a keret-szétesés, amit a layout-modul feje kimond. Az
    // egymásba ágyazott Text viszont TISZTA szöveg-folyam: az Ink a szülő Text
    // szélességét használja, tehát a mi `displayWidth`-ünkkel mért sor marad a
    // mérték.
    //
    // A `text` MINDIG ott van a szegmensek mellett (a core `joinSegments`-e
    // mindkettőt adja, ugyanabból a listából): a szélesség-tesztek és a
    // frame-assertek AZT mérik, tehát a kettő nem tud szétcsúszni.
    if (Array.isArray(l.segments) && l.segments.length > 0) {
      return h(Text, { key }, ...l.segments.map((s, j) =>
        h(Text, { key: `${key}-s${j}`, color: s.color, dimColor: s.dimColor, bold: s.bold }, s.text)))
    }
    return h(Text, {
      key,
      color: l.color,
      dimColor: l.dimColor,
      bold: l.bold,
    }, l.text)
  })
}

// AZ APPROVE / MERGE MODÁL PROPJAI — EGY forrásból, MODUL-SZINTEN.
//
// MIÉRT NEM a hívási helyeken inline: mindkét akció KÉT helyről indul (a listáról
// ÉS a panelen belülről), és a régi kódban a `blockers` kiszámítása a `setConfirm`
// hívásába volt beágyazva. Ha a panel-ág ezt lemásolná, egy elmaradt
// `canApproveRow`-ellenőrzés NÉMÁN engedne át egy tiltott approve-ot pont azon az
// egy úton, amit elfelejtettünk frissíteni — és a UI ugyanúgy nézne ki.
//
// A `row`-t a modál NEM hordozza: azt a PANEL adja (panelToModal megtartja). Egy
// második `row` a modálban két forrást jelentene ugyanarra a tényre, ami pont az
// az elcsúszás-osztály, amit a konszolidáció megszüntet.
// (wf31/14) A BLOKKOLÓK FELSOROLVA, mint a merge-nél. A régi alak EGYETLEN
// generikus stringet adott ("sajátod / draft / stacked / már eldöntött"), amiből
// a usernek KI KELLETT TALÁLNIA, melyik ok áll — és meg is kérdezte. A
// `approveBlockers` a konkrét okot adja; a "már approved" pedig MÁR NEM blokkoló
// (a második approve engedett — az indoklás a core `approveBlockers` fejénél).
export function approveModalProps(row) {
  return { kind: 'approve', blockers: approveBlockers(row) }
}

/**
 * (wf31/73) A CONFLICT-FELOLDÁS MEGERŐSÍTŐ MODÁLJA.
 *
 * BLOKKOLÓ NINCS: a feloldhatóság feltétele (van mérés, van EGY culprit) már a
 * hirdetésnél eldőlt — a body csak akkor kínálja a `v`-t. Egy itteni második
 * ellenőrzés két igazságot csinálna ugyanabból a kérdésből.
 *
 * A `stackOn` a modálba kerül, mert a KÉRDÉS szövege megnevezi a célt: a user a
 * megerősítésnél lássa, MELYIK PR-ral szemben oldunk fel.
 */
export function resolveModalProps(row, stackOn) {
  return { kind: 'resolve', blockers: [], stackOn }
}

export function mergeModalProps(row) {
  return { kind: 'merge', blockers: canMergeRow(row) ? [] : mergeBlockers(row) }
}

// A MEGERŐSÍTŐ overlay tartalma. A CÍM (heading) NEM itt születik: a core
// OVERLAY_TITLES-e adja, hogy a lista fölötti keret és a kódbeli állapot-nevek
// ne tudjanak elcsúszni.
export function confirmBody(confirm, innerWidth = 100, { hasTrace = false, choiceIndex = 0 } = {}) {
  const { kind, row, blockers, summary, paths, pathIndex, costWarning, budget, model } = confirm
  // A landolási terv (metódus / branch-sors / commit-üzenet). Csak a merge-ágon
  // kell; a `mergePlan` metódus nélkül null-t ad, és akkor a blockers-lista
  // amúgy is nem-üres (a mergeMethod-hiány ott van felsorolva).
  const mergeSummary = kind === 'merge' ? mergePlan(row) : null
  // A BRANCH-NÉV a megerősítő ekrányon is kell (user-kérés): a döntés PILLANATÁBAN
  // kell látnia, MELYIK branchre vonatkozik a metódus, mert a "branch törlődik"
  // sor önmagában nem mondja meg, MELYIK branch. A csonkolás előtagja itt
  // hosszabb ("branch-név: "), ezért külön mérjük.
  const BRANCH_PREFIX = 'branch-név: '
  const branchRoom = Math.max(1, innerWidth - displayWidth(BRANCH_PREFIX))
  return [
    ...(blockers.length > 0
      ? [
          { key: 'cb-h', color: 'red', text: 'Megtagadva — blokkolók:' },
          // PREFIXÁLT kulcs: ez a lista EGY Box gyerekei közé kerül a többi
          // keyelt sorral együtt (summary-sorok, 'cw', 'ph', 'p0'…). Puszta
          // indexszel a 0/1/2 ütközhetne a sibling summary-sorokkal, és a React
          // ('two children with the same key') duplikálhatja vagy ELHAGYHATJA a
          // sorokat — élő renderben ezt már egyszer kimértük az info-panelen.
          ...blockers.map((b, i) => ({ key: `cb-${i}`, color: 'red', text: `  · ${b}` })),
        ]
      : [
          // Az AI-review ekránya a MÉRT tényeket sorolja: PR-méret, scope, a
          // kizárt generált fájlok NEVE, a modell és a KÖLTÉS-PLAFON. A
          // sorrend a summary-ban van eldöntve (tiszta függvény, teszt alatt);
          // itt csak megjelenítjük. A nagy-PR figyelmeztetés és a "saját
          // tokenjeid" mondat SZÍNT kap, hogy a szem rájuk essen.
          ...(kind === 'ai-review'
            ? summary.lines.map((line, i) => ({
                key: `sum-${i}`,
                color: /^FIGYELEM/.test(line) ? 'red' : /saját Claude-token/.test(line) ? 'yellow' : undefined,
                bold: /^FIGYELEM/.test(line),
                text: line,
              }))
            : []),
          // A KÖLTSÉG-figyelmeztetés (>30 fájl VAGY >2000 sor) külön, PIROSAN:
          // ez a legdrágább döntés az ekrányon.
          ...(kind === 'ai-review' && costWarning
            ? [{ key: 'cw', color: 'red', bold: true, text: costWarning }]
            : []),
          // A REVIEW-ÚT választása. A default az `agent-review` (CI-vel
          // bit-azonos); a TAB váltja ciklikusan, a SZÁM (1/2) közvetlenül —
          // a nyíl NEM (user: "zavar, hogy jobbra-balra nyilat kell használnom").
          // Mindkét út `note`-ja LÁTSZIK, mert a
          // választás következménye (CI-egyezés vs. eltérő szabályok) nem
          // magától értetődő.
          ...(kind === 'ai-review' && Array.isArray(paths)
            ? [
                // Szellőzés a szekció-határon (a user: "össze van nyomva az egész").
                { key: 'sp-paths', text: ' ' },
                { key: 'ph', bold: true, text: 'Review-út (Tab: váltás · 1/2: közvetlen):' },
                ...paths.map((p, i) => ({
                  key: `p${i}`,
                  color: i === pathIndex ? 'green' : undefined,
                  bold: i === pathIndex,
                  dimColor: i !== pathIndex,
                  text: `  ${i === pathIndex ? '▸' : ' '} ${p.label}`,
                })),
                { key: 'pn', dimColor: true, text: `    ${paths[pathIndex]?.note ?? ''}` },
              ]
            : []),
          // A MERGE-OVERLAY a döntés KÉT ellenőrizhető adatát adja: a metódust és a
          // branch-nevet (amiből a metódus következik).
          //
          // (wf31/23) A `branch sorsa` ÉS A `commit-üzenet` SOR KIVEZETVE — a user
          // kérése: "megintcsak szájbarágós szarság, cut it (mind a két sort)".
          //
          // MI VOLT OTT, ÉS MIÉRT NEM HIÁNYZIK:
          //     branch sorsa: a branch megmarad (ticketes branch — a changelog
          //                   hivatkozik rá)
          //     commit-üzenet: a repo beállítása adja (nem írjuk felül)
          // Az első a MI SZABÁLYUNKAT magyarázta (miért marad a branch), a második
          // pedig azt, hogy NEM tesszük semmit ("a repo beállítása adja"). Egy
          // sor, ami arról szól, hogy nem nyúlunk valamihez, nem információ.
          //
          // AMI MEGMARAD: a `metódus` és a `branch-név`. Ez a kettő a DÖNTÉS
          // ellenőrzése — a prefix a metódus forrása, tehát a névből látszik, hogy
          // jó-e a metódus (ez a user eredeti kérése volt a branch-név sorra).
          ...(kind === 'merge'
            ? [
                { key: 'mm', text: `metódus: ${mergeSummary?.methodLabel ?? row.mergeMethod}` },
                { key: 'mn', color: 'cyan', text: `${BRANCH_PREFIX}${branchLabel(row.headRefName, branchRoom)}` },
                // (wf31/22) A FIGYELMEZTETÉSEK — LÁTSZANAK, DE NEM TILTANAK.
                //
                // A user döntése: "github UI enged merge-ölni, approve az
                // egyetlen feltétel. […] Max warningokat hagyhatsz benne." A piros
                // checkek, a BEHIND és a többi tehát ITT jelenik meg, a döntés
                // adatai UTÁN, a megerősítő kérdés ELŐTT.
                //
                // SÁRGA, NEM PIROS: a piros a MEGTAGADÁST jelöli (a `denied` ág
                // fejléce), és ha a warning is piros lenne, a kettő
                // összemosódna — pont az a szigorúbb-vagyok-a-platformnál
                // olvasat, amit ez a változás megszüntet.
                ...mergeWarnings(row).map((w, i) =>
                  ({ key: `mw-${i}`, color: 'yellow', text: `⚠ ${w}` })),
              ]
            : kind === 'ai-review'
            ? [{ key: 'sp-nx', text: ' ' },
               { key: 'nx-ai', dimColor: true, text: 'a findingokat az AGENT írja a hunk sessionbe — feltöltés csak a te átnézésed után, "f"-fel' }]
            : kind === 'upload'
            // A KÖVETKEZMÉNY kimondva: ez KÍVÜLRŐL LÁTHATÓ. A darabszámot még
            // nem tudjuk (a doUpload olvassa ki), de azt igen, hogy a hunk
            // sessionben MEGMARADT megjegyzések mennek fel — tehát amit a user
            // már kiszűrt, az nem.
            ? [{ key: 'nx-up', dimColor: true, text: 'a hunk sessionben MEGMARADT megjegyzések mennek fel EGY review-ként (event=COMMENT, nem approve) — a PR-on láthatóan, a te nevedben' }]
            : [{ key: 'nx-def', dimColor: true, text: 'attesztációs kommenttel, a meglévő non-interaktív úton' }]),
          // --- A FRICTION-SÁV + A DÖNTÉS ------------------------------------
          //
          // A user 1. elve: az approve/merge NEM tiltott review-nyom híján —
          // csak JELÖLT, és a kérdés KIMONDJA a tétet. A sorok a core TISZTA
          // függvényéből jönnek (frictionLines), ott van a szín/dim döntés is:
          // a jelzés NEM sárga (a sárga a KÖLTSÉGNEK és a BLOKKOLÓKNAK van
          // fenntartva), és a kérdés sem virít — a user kifogása szó szerint az
          // volt, hogy "a »Megerősíted« feleslegesen virít sárgával, mikor a
          // doboz aljában is ott van".
          //
          // A FRICTION CSAK az approve/merge ágon él: a findings-feltöltés és az
          // AI-review NEM a review MEGTÖRTÉNTÉT állítja (az egyik maga a review,
          // a másik költés-döntés), tehát ott a nyom-jelzés értelmetlen zaj lenne.
          ...(modalHasChoices(kind)
            ? [
                { key: 'fr-sep', text: ' ' },
                // (wf31/73) A `stackOn` ÁTADVA: a resolve-kérdés megnevezi a célt. A
                // `confirm`-ból jön (a `resolveModalProps` tette bele), tehát a
                // modál és a kérdés UGYANARRÓL a PR-ról beszél.
                ...frictionLines({ kind, hasTrace, stackOn: confirm.stackOn ?? null }).map((l, i) =>
                  ({ key: `fr-${i}`, color: l.color, dimColor: l.dim, text: l.text })),
                // A NYILAS VÁLASZTÁS (a user 2. elve: modálban a fel/le a
                // VÁLASZTÁST lépteti, nem a listát). A default a NEM —
                // fail-closed, lásd a core MODAL_CHOICES fejét. A `y` továbbra is
                // közvetlen igen: a lista a nyilas ÚT, nem a helyettesítője.
                // A KÉT VÁLASZTÁS EGY SORBAN: `▸ Nem   Igen`. Egy sorba fűzve,
                // nem külön Textekben — a magasság-vágás MEGJELENÍTETT sorokat
                // számol, tehát a leíró egy sor kell legyen, különben a becslés
                // és a valóság elcsúszik.
                {
                  key: 'ch',
                  text: MODAL_CHOICES.map((c, i) => `${i === choiceIndex ? '▸' : ' '} ${c.label}`).join('   '),
                  color: 'cyan',
                },
              ]
            : [{ key: 'sp-q', text: ' ' },
               { key: 'q', dimColor: true, text: 'Megerősíted? [y/N]' }]),
          // A BUDGET-SOR: az overlay LEGALSÓ sora, DIMMELTEN, egy sorban.
          //
          // MIÉRT ITT ÉS MIÉRT ÍGY (user-döntés): a `--max-budget-usd` a `claude
          // --help` szerint API-költésre vonatkozik, a user viszont
          // subscription-limitet fogyaszt — tehát még az sem biztos, hogy vág
          // egyáltalán. Egy bizonytalan hatású kapcsoló nem érdemel kiemelést
          // vagy magyarázó bekezdést: "lehet nagyon hangsúlytalan helyen". A
          // HANGSÚLYOS rész a MÉRET-INFO fölötte (fájlszám + diff-sorok, nagy
          // PR-on pirosan) — az bizonyítottan hasznos védelem a limitre.
          //
          // A SZÖVEG a core budgetLine-jából jön, nem itt épül: a "budget: off"
          // alak és a fokozat-lista így EGY forrásból, teszt alatt él.
          // A MODELL-SOR (5b): a KONKRÉT modellnév látszik és váltható (`m`).
          // A budget-sor FÖLÖTT, mert a modell a NAGYOBB költség-kar: a
          // budget-flag subscription alatt bizonytalan hatású, a modell-tier
          // viszont mérten nagyságrendet dönt (a user kerete egy Fable-futásra
          // ment rá). Dimmelt, mint a budget-sor (a user 3. elve: a vezérlés a
          // keret alján, a hangsúly a tartalmi méret-infón) — a SZÖVEG a core
          // modelLine-jából jön (egy forrás, teszt alatt).
          ...(kind === 'ai-review' && model
            ? [{ key: 'ml', dimColor: true, text: modelLine(model) }]
            : []),
          ...(kind === 'ai-review' && budget
            ? [{ key: 'bl', dimColor: true, text: budgetLine(budget) }]
            : []),
          // AMI SZÁNDÉKOSAN NINCS ITT: a dwell-kapu MAGYARÁZATA. A user
          // kifogása szerint a "(a megerősítés röviddel az ekrán megjelenése
          // után él — a mérés közben leütött y nem számít)" próza
          // érthetetlen, és nem is ide való: a kapu a NORMÁL használatban
          // láthatatlan (a szem-kéz kör lassabb, mint a 250 ms), tehát a
          // fejlesztő 99%-ban olyan mechanizmusról olvasna, ami nem érinti.
          // Aki tényleg belefut, EGY rövid sort kap a status-sorban ("túl korai
          // y" — lásd a useInput y-ágát). A mechanizmus INDOKLÁSA kódkommentben
          // él: itt, a useInput confirm-ágában, és a core confirmAccepts
          // fejében (typeahead / Ink raw-mode puffer).
        ]),
  ]
}
