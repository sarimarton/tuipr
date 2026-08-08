// tuipr — PANEL: a LEGFELSŐ core-réteg.
//
// Ami itt lakik: az overlay-keret + nyilas választás, a PR-panel állapotgépe
// (inline info / modális megerősítés), a viewport-korlát, a friction-szöveg
// (JELÖLT, de NEM TILTÓ) és az attesztációs body két ága.
//
// MIÉRT A LEGFELSŐ: ez a réteg fogyasztja a többit (layout: a keret CELLÁBAN
// mért tördelése; diagnosis: a progressz-reducer). Ezért itt VÉGZŐDIK a
// rétegrend — és épp ezért TILOS bármelyik alsó modulból visszahívni ide: az
// AZONNAL ciklus lenne (a scripts/check-next-modules.mjs gépileg őrzi).
import { clampCells, displayWidth, stepIndex, wrapCells } from './layout.mjs'
import { progressReducer } from './diagnosis.mjs'

// === OVERLAY-KERET + NYILAS VÁLASZTÁS =======================================


// A keret 1-1 cellát visz oldalanként, a vízszintes padding további 1-1-et. Az
// Ink `borderStyle` + `paddingX: 1` pontosan ennyit fogyaszt — ha itt kevesebbet
// számolnánk, a keret jobb oldala tördelődne le.
const OVERLAY_BORDER_W = 2
const OVERLAY_PADDING_W = 2
// A jobb margó: az overlay NE tapadjon a terminál jobb széléhez. A tördelést nem
// ez akadályozza meg (azt a fenti kettő), hanem az olvashatóságot javítja.
const OVERLAY_MARGIN_W = 2
// A legszűkebb belső hely, ami alatt már nincs értelme keretet rajzolni, de a
// hívónak akkor is konzisztens számot kell adnunk (nem 0-t és nem negatívot).
const OVERLAY_MIN_INNER_W = 1

/** Az overlay-fejlécek: állapot-kind → cím-prefix. Egy helyen, hogy ne csúszzon. */
const OVERLAY_TITLES = {
  approve: 'Approve',
  merge: 'Merge',
  upload: 'Findings feltöltése GitHubra',
  'ai-review': 'AI-review',
  // (wf31/73) A resolve MEGERŐSÍTÉSE: a feloldás AI-t hív (token) ÉS kódot ír egy
  // eldobható worktree-ben — mindkettő indokolja a kaput, ahogy az approve/merge-nél.
  resolve: 'conflict-feloldás',
  info: 'Info',
  error: 'Hiba',
}

/**
 * Az overlay KERETE (chrome): cím, lábléc, keret-szín és a CELLÁBAN mért
 * szélességek. A TARTALOM nem itt van — azt az app rendereli, a `innerWidth`-hez
 * clampelve.
 *
 * MIÉRT TISZTA FÜGGVÉNY: a "melyik állapotban milyen cím/lábléc/szín" döntés a
 * UX szerződése, és pont ez az, amit a user átalakíttatott (külön képernyő →
 * overlay). Renderben ez nem tesztelhető olcsón; itt igen, és a szélesség-illesztés
 * (60/100/190 oszlop, display-CELLA) is unit-teszt alá kerül.
 *
 * FAIL-CLOSED az ismeretlen `kind`: null. Egy találgatott cím ("Művelet") azt a
 * képet adná, hogy a UI tudja, mit kérdez — holott nem.
 */
export function overlayFrame({ state, columns = 120 } = {}) {
  if (!state || typeof state !== 'object') return null
  const heading = OVERLAY_TITLES[state.kind]
  if (heading === undefined) return null

  const width = Math.max(
    OVERLAY_BORDER_W + OVERLAY_PADDING_W + OVERLAY_MIN_INNER_W,
    Math.min(columns, Math.max(20, columns - OVERLAY_MARGIN_W)),
  )
  // A `width` sosem lépheti túl a terminált — a fenti Math.max padlója
  // elvileg megemelhetné egy nagyon szűk terminálon, ezért itt vágunk.
  const outer = Math.min(width, Math.max(1, columns))
  const innerWidth = Math.max(OVERLAY_MIN_INNER_W, outer - OVERLAY_BORDER_W - OVERLAY_PADDING_W)

  const denied = Array.isArray(state.blockers) && state.blockers.length > 0
  const isError = state.kind === 'error'
  const row = state.row ?? {}
  // A CÍM VISELI A PR-SZÁMOT: ez a kontextus, amiért az egész refaktor van. A
  // szám és a `#` SOSEM csonkolódik el — előbb a TÍTULUS fogy el, mert a
  // "melyik PR?" a fontosabb információ.
  const prefix = `${heading}: #${row.number}`
  const rest = row.title ? ` ${row.title}` : ''
  const title = clampCells(prefix + rest, innerWidth)

  const footer = clampCells(
    overlayFooter({ state, denied, isError }),
    innerWidth,
  )

  return {
    kind: state.kind,
    title,
    footer,
    // A KERET SZÍNE a legkorábban felfogott jelzés: a megtagadás és a hiba
    // PIROS, a token-költő AI-review SÁRGA, a többi CYAN.
    borderColor: denied || isError ? 'red' : state.kind === 'ai-review' ? 'yellow' : 'cyan',
    denied,
    width: outer,
    innerWidth,
  }
}

/**
 * A lábléc (footer) szövege. Külön függvény, hogy a kulcs-hirdetés EGY helyen
 * éljen — a korábbi bug osztálya pont az volt, hogy a keybind három forrásból
 * (kód, legenda, docs) csúszott szét.
 *
 * A SORREND szándékos: elöl a DÖNTÉS kulcsai (nyíl, y/N), hátul a zárás. Ha a
 * keskeny terminálon a `clampCells` vág, a döntés kulcsai maradnak meg — egy
 * olyan overlay, amiről nem látszik, hogyan kell igent mondani, használhatatlan.
 */
function overlayFooter({ state, denied, isError }) {
  // Az Esc SOSEM "kilépés" itt: overlay-t zár. A kettő összemosása a user 3.
  // pontja — nyitott overlaynél a q/Esc nem léphet ki a TUI-ból.
  if (isError) return 'Esc/q: overlay bezárása'
  if (denied) return 'bármely gomb (Esc/q is): vissza — a művelet blokkolva van'
  if (state.kind === 'info') {
    return 'j/k: másik sor (a mérés újraindul) · Esc/q: mérés megszakítása + overlay bezárása'
  }
  const parts = []
  // A NYÍL-affordance CSAK akkor jelenik meg, ha van MIRE váltani: egy útnál a
  // hirdetett nyíl dead key lenne, és a user azt hinné, hogy elromlott.
  if (state.kind === 'ai-review' && Array.isArray(state.paths) && state.paths.length > 1) {
    // A user ÚJABB kérése: "zavar, hogy jobbra-balra nyilat kell használnom" —
    // a nyíl TÖBBÉ NEM review-út-váltó. A Tab a ciklikus váltó (eddig is
    // működött, most hirdetjük), a számok (1..N) a közvetlen választás. A
    // nyíl a budget-lépcsőé marad, amikor a plafon be van kapcsolva — így
    // egyik funkció sem oszt billentyűt a másikkal.
    parts.push(`Tab/1-${state.paths.length}: review-út`)
  }
  // A MODELL-VÁLTÓ (5b) hirdetése: az `m` a megerősítés-módban szabad kulcs
  // (a merge `m`-je ide el sem jut), a mnemonika pedig pontos. Csak ott
  // hirdetjük, ahol él — az ai-review megerősítésén.
  if (state.kind === 'ai-review' && state.model) parts.push('m: modell')
  parts.push('y: megerősítés [y/N]')
  parts.push('Esc/q: mégse')
  return parts.join(' · ')
}


// === PANEL: EGY PR-PANEL (info + mérés + következő lépések) =================
//
// A REFAKTOR TÁRGYA (user-kérés, szó szerint): "Az alertek, üzenetek, dialog
// külön képernyőn van… jobb lenne ha a lista fölött keretes overlayben
// jelennének meg" + "info és rebase dialog összevonása: én összevonnám a kettőt.
// Mindkettőben van extra információ, ami alapján lehetne továbbmenni a review-ra."
//
// A KORÁBBI ÁLLAPOT: NÉGY külön dialógus (info, approve-confirm, merge-confirm,
// ai-review-confirm), mindegyik a maga kulcs-készletével, és a "megnézem →
// visszalépek → cselekszem" hurok minden döntésnél lefutott. Az info-panelről
// nem lehetett approve-olni; ki kellett lépni belőle, hogy az `a` éljen.
//
// AZ ÚJ MODELL EGY ÁLLAPOT, KÉT MÓDDAL — és a mód a DIALÓGUS-TIPOLÓGIÁBÓL
// következik (a user 2. elve), nem konfigurációból:
//
//   mode: 'inline'  — INFO. A kiválasztott sor ALATT ül, a lista végig látszik,
//                     és a panel alatt is lehet navigálni (j/k), MÉRÉS KÖZBEN is.
//                     Indok: az info KONTEXTUS, nem döntés — modálként elvenné a
//                     listát, ami épp az összehasonlítás alapja.
//   mode: 'modal'   — MEGERŐSÍTÉS (approve / merge / AI-review / findings-upload).
//                     Az 5a lelet óta a RENDER ugyanaz az inline panel (a lista
//                     LÁTHATÓ marad — a user: "az info panel az egyetlen dialog
//                     útvonal a PR műveletekhez"); a mód a KULCSOKBAN válik el:
//                     a fel/le a VÁLASZTÁST lépteti, NEM a listát. Indok: egy
//                     várakozó, visszavonhatatlan döntésnél a lista-navigáció
//                     fegyver — a kurzor elmozdulhatna a döntés alól (a
//                     poll-fejezet ugyanezért nem tölt újra magától).
//
// NINCS KAPCSOLÓ a kettő között. A user kimondott indoka: "egy kapcsoló, amit
// senki nem állít, csak kódutat duplikál".
//
// A MODÁL A PANELBŐL NYÍLIK, nem helyette: a `panelToModal` MEGTARTJA a `row`-t
// és a `progress`-t, tehát az Esc a MODÁLBÓL az INFO-panelre lép vissza, nem a
// listára. Így a "megnézem → cselekszem → visszanézem" kör a panelen belül
// zárul — pontosan az, amit a user kért.

/**
 * A panel megnyitása INLINE módban (az `i`, illetve bármely sor-kiválasztás).
 *
 * A `progress` a mérés-állapotgép (progressInit/Reducer) állapota, vagy null. A
 * panel ÁLLAPOTA HORDOZZA — nem külön state, mert a mérés a panel egyik sávja,
 * és a kettő szétválasztása pont azt a négy-dialógusos szétesést hozná vissza.
 */
export function panelOpen({ row, progress = null } = {}) {
  return { mode: 'inline', row: row ?? null, progress, modal: null }
}

/**
 * A panel bezárása. NULL-t ad — és ez load-bearing: a hívó EGY state-et null-oz,
 * tehát ORPHAN MODÁL nem maradhat.
 *
 * MIÉRT KELL EZ FÜGGVÉNYKÉNT (és nem egy `setPanel(null)` a hívóban): a korábbi
 * kódban a `confirm` és az `info` KÜLÖN state volt, és a zárási utak
 * szétcsúsztak — volt ág, ami az egyiket zárta, a másikat nem. Egy nyitva maradt
 * confirm a lista fölött azt jelentette, hogy a következő `y` egy MÁR ELFELEJTETT
 * PR-t approve-olt volna. Egy állapot + egy zárás = az osztály kiirtva.
 */
export function panelClose() {
  return null
}

/**
 * Átmenet MODÁL módba: a megerősítés a panelből nyílik.
 *
 * A `row` és a `progress` MEGMARAD: (a) a modál fejléce ugyanarról a PR-ról
 * beszél, tehát nem kell újra átadni (két forrás = elcsúszás), és (b) az Esc a
 * modálból az INFO-panelre lép vissza — a mért diagnózis nem veszik el egy
 * meggondolt-magam gesztus miatt.
 *
 * Az `armedAt` a dwell-kapu horgonya (confirmAccepts). Itt, az ÁTMENETNÉL
 * születik, nem a render alatt: a dwell azt méri, mióta van a döntés a szem
 * előtt, és egy renderben felvett időpont minden újrarendereléssel újraindulna —
 * a typeahead-védelem néma no-op lenne.
 */
export function panelToModal(st, { kind, blockers = [], armedAt = Date.now(), ...rest } = {}) {
  if (!st || typeof st !== 'object') return null
  return {
    ...st,
    mode: 'modal',
    modal: { kind, blockers: Array.isArray(blockers) ? blockers : [], armedAt, ...rest },
  }
}

/** Vissza a modálból az INLINE panelre (Esc a döntésről). */
export function panelToInline(st) {
  if (!st || typeof st !== 'object') return null
  return { ...st, mode: 'inline', modal: null }
}

/**
 * Egy mérés-esemény beépítése a PANEL állapotába, a `pr`-hoz kötött
 * stale-védelemmel. TISZTA: stale eseményre a KAPOTT state-et adja vissza
 * (referencia-azonos), így a React setState no-op marad.
 *
 * MIÉRT KÜLÖN FÜGGVÉNY az `applyProgressToInfo` MELLETT (és miért nem hívjuk azt
 * közvetlenül a paneire): az `applyProgressToInfo` az INFO-alakot
 * (`{row, progress}`) építi újra spreaddel. Panel-alakra hívva működni LÁTSZANA,
 * de ha bárki később a spreadet szűkíti (vagy egy új kulcs kerül a panelbe), a
 * `mode` és a `modal` ELVESZNE. A következmény ÉLŐBEN: egy nyitott modál fölött
 * befutó mérés-esemény NÉMÁN bezárná a modált (`mode === undefined`), és a user
 * döntése a semmibe futna — a mérés a háttérben fut, tehát ez pont a
 * legrosszabb pillanatban történne. A KÜLÖN függvény + a rá írt teszt kizárja.
 *
 * A HÁROM ELDOBÁSI OK, mind más hibaosztály:
 *   - `null` panel (közben zárták): zárt panel nem éled újra;
 *   - `row.number !== pr`: a user MÁS sorra lépett, a régi mérés callbackje az
 *     ÚJ panel state-jébe írna — más PR mért conflict-tényét olvasná a user;
 *   - `progress` null (nem mérhető, stacked sor): nincs mit léptetni.
 */
export function applyProgressToPanel(cur, pr, ev) {
  if (!cur || typeof cur !== 'object') return cur
  if (cur.row?.number !== pr || !cur.progress) return cur
  return { ...cur, progress: progressReducer(cur.progress, ev) }
}

/**
 * MELYIK SÁV LÁTSZIK — a panel tartalmi szerződése, tiszta függvényben.
 *
 * A sávok NEVEI a render ágait vezérlik. Azért itt élnek és nem a renderben,
 * mert a "mi látszik melyik állapotban" a UX SZERZŐDÉSE: ez az, amit a user
 * átalakíttatott, és amit a nézetből csak élő Ink-renderrel (drágán) lehetne
 * visszamérni.
 *
 * INLINE: info + mérés + AKCIÓK. A harmadik a refaktor lényege — a következő
 *   lépések (`d`/`r`/`a`/`m`) a panelen BELÜL vannak, tehát a
 *   "visszalépek-hogy-cselekedjek" hurok megszűnt.
 * MODÁL: confirm. Az AKCIÓ-lista SZÁNDÉKOSAN NINCS itt: egy pufferelt vagy
 *   elgépelt `m` a döntés fölött egy MÁSIK visszavonhatatlan akciót indítana.
 */
export function panelSections(st) {
  if (!st || typeof st !== 'object') return []
  if (st.mode === 'modal') return ['confirm']
  return ['info', 'measure', 'actions']
}

/**
 * MELYIK BILLENTYŰ ÉLES — a kulcs-készlet EGY forrásból.
 *
 * A `'choice'` pszeudo-kulcs a fel/le VÁLASZTÁS-léptetést jelöli (modálban). Nem
 * betű, mert nem betű: a nyíl és a j/k is ide képződik le. A HALMAZ mondja ki,
 * hogy modálban a fel/le NEM lista-navigáció — ez a user 2. elvének gépi alakja,
 * és a régi kódban ez pont elcsúszott (a confirm ágon a j/k `undefined` ágra
 * futott, tehát NÉMÁN bezárta az overlayt).
 */
export function panelKeys(st) {
  if (!st || typeof st !== 'object') return []
  if (st.mode === 'modal') {
    // A BLOKKOLT művelet (denied) modálján a megerősítés SEM éles: nincs mit
    // megerősíteni. Csak a zárás — enélkül a `y` egy megtagadott műveletre
    // "sikerként" olvasható visszajelzést adna.
    const denied = (st.modal?.blockers?.length ?? 0) > 0
    if (denied) return ['escape']
    // A `'choice'` (fel/le választás-léptetés) CSAK ott éles, ahol VAN lista —
    // ugyanabból a forrásból, amiből a lábléc hirdeti (MODAL_CHOICE_KINDS).
    // Enélkül a kulcs-halmaz és a lábléc szétcsúszhatna, és a nyíl dead key lenne.
    // (wf31/69) A `'return'` (Enter) A VÁLASZTÓS ÁGON ÉLES — ÉS EDDIG HIÁNYZOTT
    // EBBŐL A HALMAZBÓL. Az Enter a KIVÁLASZTOTT ágat hajtja végre (a `'Nem'`-en
    // zár, az `'Igen'`-en a `y`-ra normalizál), tehát a szerződés eddig kevesebbet
    // mondott, mint amennyi működik — pont az az elcsúszás, amit ez a halmaz
    // hivatott megelőzni.
    return modalHasChoices(st.modal?.kind)
      ? ['y', 'n', 'choice', 'return', 'escape']
      : ['y', 'n', 'escape']
  }
  // INLINE: a lista-navigáció ÉS az öt akció (a feltöltéssel — 3. pont), plusz
  // az AI-review megszakítása (`x` — a progressz-sor a panelben hirdeti), a
  // caveat-lábjegyzet ki/becsukása (`return`) és a zárás.
  //
  // (wf31/30) A `'return'` (Enter) A PANELT ZÁRJA — TOGGLE. A listán az Enter
  // NYITJA, tehát ugyanaz a gomb zárja is: egy gomb, egy fogalom („részletek
  // ki/be"). A korábbi alak a caveat-lábjegyzetet togglézta, de az a lábjegyzet
  // MEGSZŰNT (a mérési részletek mindig látszanak) — a kulcs így felszabadult.
  // Az `Esc` VÁLTOZATLANUL zár: az muscle memory, és a lábléc is hirdeti.
  //
  // MIÉRT ITT ÉS NEM CSAK AZ App-BAN: ez a halmaz a "melyik gomb éles" GÉPI
  // forrása. A projekt MÉRT hibaosztálya, hogy a kulcs-készlet és a valódi
  // kezelő szétcsúszik (az `f` modálján a lábléc nyilat hirdetett, a body nem
  // adott listát — a nyíl DEAD KEY volt, és a user nem tudta, a gomb rossz-e
  // vagy a UI fagyott le).
  // (wf31/10) A `'c'` A CONFLICT-MÉRÉS EXPLICIT INDÍTÁSA. A panel-nyitás többé
  // NEM mér (a kumulatív igazságot a next-gráf és a CI-címkék adják, mérés
  // nélkül), tehát a drága út saját gesztust kapott — és ha nincs kulcs, ami
  // hirdeti, a mérés ELÉRHETETLEN lenne.
  //
  // (wf31/17) AZ `'f'` ITT MARAD, A LÁBLÉC FELTÉTELESSÉGE ELLENÉRE. MIÉRT: ez a
  // halmaz azt mondja meg, mely kulcsokat NE nyelje el a panel — a feltöltés
  // ELÉRHETŐSÉGÉT a `doUpload` maga dönti el (ott van a hunk-session mérése is,
  // amit a render-úton nem tehetünk meg). A lábléc a HIRDETÉST szűri (nincs dead
  // key), a kezelő a VÉGREHAJTÁST — a kettő nem ugyanaz a kérdés. Ha az `f` itt
  // kiesne, egy hirdetett `f` (van feltölthető anyag) NÉMÁN elhalna.
  // (wf31/53) AZ `'s'` A STACKELÉS. A mérés MÁR eldöntötte, hogy van-e stack-cél
  // (`conflictAdvice.offerStack` + `stackOn`) — eddig viszont csak a PARANCS volt
  // kiírva, a usernek kézzel kellett átgépelnie. A user kérése: "a stackelést fel
  // kellene ajánlani az info panel statusában ebben a state-ben (pending UI-jal)".
  //
  // A KULCS AKKOR IS ITT VAN, HA ÉPP NINCS AJÁNLAT — ugyanaz az elv, ami az `'f'`
  // ottmaradását indokolja: ez a halmaz azt mondja meg, mely kulcsokat NE nyelje
  // el a panel, a HIRDETÉST a lábléc szűri (`stackLabel`), a VÉGREHAJTHATÓSÁGOT
  // pedig a `doStack` dönti el — ott van a branch-mérés, amit a render-úton nem
  // tehetünk meg.
  // (wf31/73) A `'v'` A CONFLICT-FELOLDÁS. A kulcs akkor is itt van, ha épp nincs
  // mit feloldani (nincs mérés vagy nincs culprit) — ugyanaz az elv, mint az `'f'`
  // és az `'s'` esetén: ez a halmaz azt mondja meg, mely kulcsokat NE nyelje el a
  // panel, a HIRDETÉST a body szűri, a VÉGREHAJTHATÓSÁGOT a `doResolve`.
  return ['j', 'k', 'c', 'd', 'r', 'f', 'a', 'm', 's', 'v', 'x', 'return', 'escape']
}

/**
 * A MODÁL VÁLASZTÁSAI, és a DEFAULT a NEM.
 *
 * MIÉRT A NEM AZ ELSŐ (fail-closed): a modál egy visszavonhatatlan, kívülről
 * látható akciót erősít meg (approve / merge / GitHub-review-poszt). A nyitó
 * választás ezért a biztonságos ág: egy vaktában leütött Enter/le-fel NEM
 * indíthat semmit. A `y` továbbra is közvetlen igen (a dwell-kapu mögött) — a
 * választó-lista a NYILAS út, nem a helyettesítője.
 */
export const MODAL_CHOICES = [
  { id: 'no', label: 'Nem' },
  { id: 'yes', label: 'Igen' },
]

/**
 * MELY MODÁL-FAJTÁK KAPNAK NYILAS VÁLASZTÓ-LISTÁT — EGY forrásból.
 *
 * A választó-lista az approve/merge ágon él, mert az a FRICTION-döntés (a
 * review-nyom kimondása + a tét kimondása). A findings-feltöltés és az AI-review
 * NEM a review megtörténtét állítja (az egyik maga a review, a másik
 * költés-döntés), ott a lista értelmetlen zaj lenne.
 *
 * MIÉRT KELL EZ EXPORTÁLT KONSTANSKÉNT (ÉLŐ RENDERBEN MÉRT BUG): a lábléc és a
 * body KÜLÖN döntött arról, van-e lista. Az `f` (upload) modálján a lábléc
 * hirdette az `↑/↓: választás`-t, a body viszont csak egy sima
 * "Megerősíted? [y/N]" sort adott — a nyíl ott DEAD KEY volt. A user megnyomja,
 * semmi nem történik, és nem tudja, hogy a gomb nem működik, vagy a UI fagyott le.
 * Ugyanaz az elv, amiért az `overlayFooter` a review-út nyilát is CSAK két út
 * esetén hirdeti. EGY forrás → a kettő nem tud szétcsúszni.
 */
// (wf31/73) A `resolve` IS VÁLASZTHATÓ NYÍLLAL — ugyanaz a kapu-élmény, mint az
// approve/merge esetén: a modál nyitó választása a BIZTONSÁGOS ág (Nem), és a
// ←/→ + ⏎ út is él. Egy y/N-only kapu itt inkonzisztens lenne a másik két
// költő akcióval.
export const MODAL_CHOICE_KINDS = new Set(['approve', 'merge', 'resolve'])

/** Van-e nyilas választó-lista ezen a modál-fajtán? */
export function modalHasChoices(kind) {
  return MODAL_CHOICE_KINDS.has(kind)
}

/**
 * A választás léptetése fel/le nyíllal — a `stepIndex` szerződésével (körbejár,
 * a degenerált indexet ELŐBB normalizálja).
 *
 * Külön nevű függvény, nem a `stepIndex` közvetlen hívása a renderben: a modál
 * választás-tere FIX (két elem), és így a hívó nem tudja véletlenül más
 * hosszúsággal hívni (a `paths` tömbbel pl. — az egy MÁS választás-tér).
 */
export function modalChoiceStep(current, delta) {
  return stepIndex(current, MODAL_CHOICES.length, delta)
}

/**
 * A LEGKEVESEBB LISTA-SOR, amit a panel meghagy.
 *
 * A DÖNTÉS: szűk terminálon a PANEL rövidül, NEM a lista tűnik el.
 *
 * Az indok a refaktor eredeti oka: a régi kód a dialógust TELJES KÉPERNYŐS
 * cserével nyitotta, és a user elvesztette a listát — nem látta, MELYIK PR-ról
 * szól a kérdés. Ha a viewport a panelnek adná a helyet, ugyanoda érkeznénk
 * vissza, csak fokozatosan. A lista a KONTEXTUS; a panel tartalma pedig
 * scrollozható/csonkolható, tehát ott a veszteség VISSZANYERHETŐ.
 *
 * A 3 nem esztétikai szám: a kurzor sora + egy-egy szomszéd. Egyetlen sorral a
 * "hol vagyok a queue-ban" kérdés megválaszolhatatlan (nincs mihez képest), és
 * épp az összehasonlítás az, amiért a lista ott marad.
 */
export const PANEL_MIN_LIST_ROWS = 3

/**
 * A VIEWPORT: hány lista-sor és hány panel-sor látszik, és hol kezdődik a
 * lista-ablak.
 *
 * MIÉRT KELL EGYÁLTALÁN: a lista NEM virtualizált — eddig minden sor
 * renderelődött. Amíg a dialógus teljes képernyős volt, ez nem látszott (a lista
 * nem volt ott); az INLINE panel viszont a lista ALÁ kerül, tehát a
 * lista-magasság + panel-magasság + chrome együtt túllépheti a terminált. Az Ink
 * ilyenkor felfelé tolja a tartalmat: ELŐBB a FEJLÉC csúszik ki (az, ami a
 * betöltés idejét és az elavultság-jelzést hordozza), majd a lista teteje. A
 * user így pont azt veszíti el, amiért a fejléc-fejezet készült.
 *
 * A SZERZŐDÉS három pontja, mind teszt alatt:
 *   1) visibleRows + panelRows + chrome <= height  — SOHA nem lóg túl;
 *   2) a KURZOR SORA MINDIG az ablakban van — enélkül a panel egy nem látható
 *      sorról beszélne (a legrosszabb fajta hazug UI);
 *   3) a lista legalább `PANEL_MIN_LIST_ROWS` sort kap, ha van annyi sor —
 *      a panel csonkolódik, nem a kontextus.
 *
 * A CSONKOLÁS KIMONDVA: a `panelTruncated` a modellben van, hogy a nézet ki
 * tudja írni ("… még N sor"). Egy némán elvágott panel ugyanaz a hibaosztály,
 * mint a némán elnyelt hiba: a user nem tudja, hogy van még.
 */
export function panelViewport({ rowCount = 0, cursor = 0, height = 24, panelHeight = 0, chrome = 4 } = {}) {
  const rows = Math.max(0, Math.floor(Number(rowCount) || 0))
  // A magasság FAIL-SOFT: nem-TTY-n vagy resize közben a `rows` 0/undefined
  // lehet, és egy 0-s magasság minden sort elnyelne. A 24 a klasszikus default.
  const h = Number.isFinite(Number(height)) && Number(height) > 0 ? Math.floor(Number(height)) : 24
  const ch = Math.max(0, Math.floor(Number(chrome) || 0))
  const wanted = Math.max(0, Math.floor(Number(panelHeight) || 0))
  // A chrome (fejléc + status + legenda) FIX költség: ami utána marad, azon
  // osztozik a lista és a panel.
  const room = Math.max(0, h - ch)
  if (wanted === 0) {
    const visible = Math.min(rows, room)
    return { first: clampFirst(rows, cursor, visible), visibleRows: visible, panelRows: 0, panelTruncated: false }
  }
  // A LISTA KAP ELŐBB — de csak a minimumot (vagy amennyi sor van, ha kevesebb).
  // Így a panel a MARADÉKON osztozik, és ha a maradék kevesebb, mint amit kért,
  // a PANEL csonkol.
  const listFloor = Math.min(rows, PANEL_MIN_LIST_ROWS, room)
  const panelRoom = Math.max(0, room - listFloor)
  const panelRows = Math.min(wanted, panelRoom)
  const visible = Math.min(rows, Math.max(0, room - panelRows))
  return {
    first: clampFirst(rows, cursor, visible),
    visibleRows: visible,
    panelRows,
    panelTruncated: panelRows < wanted,
  }
}

/**
 * A PANEL TÖRZSÉNEK ELVÁGÁSA `maxRows` MEGJELENÍTETT sorra.
 *
 * MIÉRT KELL (MÉRT BUG, ÉLŐ RENDERBŐL): az első változatban a `panelViewport`
 * HELYESEN adta vissza a `panelTruncated: true`-t, a nézet KI IS ÍRTA ("a panel
 * csonkolva"), DE A TARTALMAT SENKI NEM VÁGTA EL. A panel a teljes törzsét
 * renderelte: 12 soros terminálon a frame 29 sorra hízott, és a FEJLÉC kicsúszott
 * — vagyis a UI ÁLLÍTOTTA a csonkolást, ami nem történt meg. Ez ugyanaz a
 * hibaosztály, mint a hazug status-sor: a legrosszabb fajta, mert a user a
 * jelzésnek hisz.
 *
 * A CSONKOLÁS EGYSÉGE A MEGJELENÍTETT SOR, NEM A BODY-ELEM. Egy hosszú
 * advice-bekezdés az Ink tördelésében 3-4 sort foglal; elem-számolással a becslés
 * ALULról tévedne, és pont az alul-becslés adja a túllógást. A mérték ugyanaz a
 * `wrapCells`/`displayWidth`, amivel a keret is számol — két különböző mérték
 * (karakter vs. cella) itt garantáltan szétcsúszna.
 *
 * A bemenet `{ text, … }` alakú elemek listája; a `text`-en KÍVÜLI kulcsok
 * (szín, dim, key) érintetlenül mennek vissza a `kept`-ben — a nézet dolga őket
 * Ink-fává alakítani.
 */
export function clipBodyLines(body, { width = 80, maxRows = 0 } = {}) {
  const items = Array.isArray(body) ? body : []
  const w = Number.isFinite(Number(width)) && Number(width) > 0 ? Math.floor(Number(width)) : 1
  const limit = Number.isFinite(Number(maxRows)) && Number(maxRows) > 0 ? Math.floor(Number(maxRows)) : 0
  const kept = []
  let rows = 0
  for (const item of items) {
    // A TÖRDELT SOROK SZÁMA. Az üres/whitespace szöveg 1 sort foglal (az Ink egy
    // üres Textet is kirajzol), a `wrapCells` viszont üres listát ad rá — ezért a
    // padló 1. Enélkül a panel üres elválasztó sorai "ingyen" lennének, és a
    // becslés alulról tévedne.
    const lines = Math.max(1, wrapCells(String(item?.text ?? ''), w).length)
    if (rows + lines > limit) return { kept, rows, truncated: true }
    kept.push(item)
    rows += lines
  }
  return { kept, rows, truncated: false }
}

/**
 * A lista-ablak KEZDŐ INDEXE úgy, hogy a KURZOR benne legyen.
 *
 * A kurzort KÖZÉPRE célozzuk, majd a tartomány két végéhez CLAMPELJÜK. A
 * "középre + clamp" azért jobb, mint a "csak akkor mozdulj, ha kifutott": a
 * panel megnyitása HIRTELEN csökkenti az ablakot, és a lusta változat ilyenkor a
 * kurzort a szélre szorítaná (nulla kontextus a mozgás irányában).
 */
function clampFirst(rowCount, cursor, visible) {
  if (visible <= 0) return 0
  const cur = Number.isFinite(Number(cursor)) ? Math.max(0, Math.floor(Number(cursor))) : 0
  const maxFirst = Math.max(0, rowCount - visible)
  const centered = cur - Math.floor(visible / 2)
  return Math.min(maxFirst, Math.max(0, centered))
}

// --- FRICTION: a review-nyom hiánya JELÖLT, de NEM TILTÓ -------------------
//
// A USER ELVE (szó szerinti indoklással): az approve/merge NEM tiltott
// review-nyom híján — csak JELÖLT, és a megerősítő szöveg KIMONDJA. Az érv: a
// "review megléte" csak PROXY (hunk-komment darabszám / lefutott `claude -p`), és
// egy hard gate arra tanítana, hogy a PROXYT teljesítsük — tokent költenénk
// hamis attesztációs nyomért. Vannak legitim review-mentes approve-ok
// (dependabot-bump, docs-tipó), és a `d` (hunk-diff) átnézés NEM hagy nyomot.
//
// AMI VISZONT KÖTELEZŐ: AZ ATTESZTÁCIÓ MONDJON IGAZAT. Ha nem volt nyom,
// RÖVIDEBB body megy fel, ami NEM állítja, hogy volt review (lásd approveBody).
// A friction tehát nem a kapuban él, hanem a KIMONDÁSBAN — és a kimondás
// ellenőrizhető, míg a proxy-kapu kijátszható.

/**
 * A friction-sorok a megerősítő modálhoz: `{ text, role, color, dim, blocking }`.
 *
 * A `role` a nézetnek szól (`'notice'` = a jelzés, `'question'` = a tét
 * kimondása); a `blocking` MINDIG false — ez a hard-gate tilalom gépi alakja,
 * tehát egy későbbi refaktor sem tudja "véletlenül" kapuvá tenni anélkül, hogy
 * egy teszt elbukna.
 *
 * SZÍNEZÉS (a user 3. elve): a SÁRGA CSAK valódi figyelmeztetésre való (költség,
 * blokkolók). A review-nyom hiánya LEGITIM állapot, nem veszély — tehát dimmelt,
 * nem sárga. A "Megerősíted?" sem virít: a keret alján, dimmelten.
 */
export function frictionLines({ kind, hasTrace = false, stackOn = null } = {}) {
  // (wf31/21) A KÉT NOTICE-SOR KIVEZETVE. A user kérése, szó szerint: "Nem kell
  // ez a szájbarágós szöveg, vedd ki, egyszerűsítsük ezt a kurva appot, annyira
  // idegesítő a sok sloppy szájbarágós szövegelés."
  //
  // MI VOLT OTT, ÉS MIÉRT REDUNDÁNS:
  //     Nincs review-nyom ezen a PR-on
  //     (a `d` átnézés nem hagy nyomot — ha átnézted, ez nem hiba)
  //     Review-nyom nélkül approve-olsz? [y/N]
  // A HARMADIK sor ugyanazt a tényt hordozza, mint az első ("review-nyom
  // nélkül"), a MÁSODIK pedig az implementációnkat magyarázza — arról, hogy a `d`
  // nem jegyez nyomot, a usernek nem kell tudnia a döntés pillanatában. Három sor
  // egy tényre.
  //
  // AMI MEGMARAD, ÉS MIÉRT ELÉG: a kérdés SZÖVEGE állapotfüggő. Nyom nélkül
  // `Review-nyom nélkül approve-olsz?`, nyommal `Biztosan approve-olsz?` — a tény
  // tehát KIMONDVA marad, ott, ahol a döntés is születik. Ez a modul fejében álló
  // elv ("a friction nem a kapuban él, hanem a KIMONDÁSBAN") SÉRTETLEN: a
  // kimondás egy sorba került, nem tűnt el.
  //
  // AZ ATTESZTÁCIÓ SEM VÁLTOZIK: a `approveBody` továbbra is RÖVIDEBB bodyt ad
  // nyom nélkül (nem állítja, hogy volt review) — az a szerződés a PR
  // audit-trailjéről szól, nem a UI bőbeszédűségéről.
  // (wf31/73) A `resolve` SAJÁT KÉRDÉST KAP: itt nem a "review-nyom" a tét (nem a PR-t
  // minősítjük), hanem hogy AI-t hívunk és kódot íratunk vele. A kérdés ezt mondja ki.
  if (kind === 'resolve') {
    // A VISSZATÉRÉSI ALAK UGYANAZ, MINT A TÖBBI ÁGON: sor-leírók TÖMBJE. MÉRT SAJÁT
    // HIBA volt egy `{text, choices}` objektumot adni — a hívó `.map()`-ot hív a
    // visszatérési értéken (`...frictionLines(…).map(…)`), ami objektumon
    // TypeError-t dobna. A választásokat nem itt hirdetjük: azt a `MODAL_CHOICE_KINDS`
    // és a labelc adja, ugyanabból a forrásból, mint az approve/merge esetén.
    //
    // A CÉL A PARAMÉTERBŐL, NEM egy scope-on kívüli `confirm`-ból: ez a függvény
    // CSAK a kind-ot és a nyom-tényt kapja (tiszta, tesztelhető) — a hívó adja át.
    // Hiányzó célnál a kérdés általános marad, nem hazudik számot.
    return [{
      text: stackOn === null
        ? 'AI-feloldás a culprittal? (token-költés; a feloldott kód egy eldobható worktree-ben marad)'
        : `AI-feloldás a #${stackOn} culprittal? (token-költés; a feloldott kód egy eldobható worktree-ben marad)`,
      role: 'question',
      dim: true,
      blocking: false,
    }]
  }
  const stake = kind === 'merge' ? 'landolsz' : 'approve-olsz'
  return [{
    text: hasTrace
      // (wf31/69) A `[y/N]` HINT KIESETT — a user lelete: "magyarul van az igen/nem,
      // miközben a keyboard hint y/N". A kérdés alatt ott a VIZUÁLIS választó
      // (`▸ Nem   Igen`), a billentyűket pedig a lábléc sorolja — a sor végi
      // angol hint így egyszerre volt duplikáció és nyelvi törés a magyar
      // mondatban. A `y`/`n` gyorsbillentyű VÁLTOZATLANUL él (a lábléc hirdeti).
      ? `Biztosan ${stake}?`
      : `Review-nyom nélkül ${stake}?`,
    role: 'question',
    color: undefined,
    dim: true,
    blocking: false,
  }]
}

/**
 * AZ ATTESZTÁCIÓS BODY az approve-hoz — KÉT ÁG, és a nyom nélküli NEM ÁLLÍT
 * átnézést.
 *
 * MIÉRT KELL EZ A TUI-BAN (és miért nem elég a bash defaultja): a
 * `bin/tuipr.sh` `cmd_approve`-ja `--body` nélkül a
 *   "Reviewed in next queue session <dátum> — next @ <sha>"
 * szöveget teszi fel. Ez ÁLLÍTJA, hogy volt review. Review-nyom nélkül ez
 * HAZUGSÁG a PR audit-trailjében — és a user 1. elvének a magja pontosan ez: a
 * friction azért nem hard gate, mert az ATTESZTÁCIÓNAK kell igazat mondania, nem
 * a kapunak kikényszerítenie a nyomot. A TUI ezért EXPLICIT `--body`-t ad.
 *
 * EGY SOR, szándékosan: a body `gh pr review --body <arg>`-ként megy át, egy
 * argumentumban. A több soros szöveg (idézés, escape-elés, `$`-expanzió) ott
 * törékeny, és a `spawnSync` argv-je amúgy sem shell — de a bash-út is
 * ugyanezt a stringet kapja, tehát a legszűkebb szerződéshez tartjuk magunkat.
 *
 * A HIÁNYZÓ ADAT NEM SZIVÁROG KI: SHA/dátum nélkül a megfelelő tag KIMARAD, nem
 * `undefined`-ként kerül be — a hamis pontosság rosszabb, mint a hiány.
 */
export function approveBody({ hasTrace = false, traceSources = [], date = null, nextSha = null } = {}) {
  const stamp = []
  if (date) stamp.push(String(date))
  if (nextSha) stamp.push(`next @ ${nextSha}`)
  const suffix = stamp.length > 0 ? ` (${stamp.join(' — ')})` : ''
  if (!hasTrace) {
    // NYOM NÉLKÜL: a body CSAK a gesztust rögzíti, nem a review megtörténtét. A
    // "Reviewed"/"átnézve" szó SZÁNDÉKOSAN nincs benne — ez a különbség maga az
    // igaz attesztáció.
    return `Approve a next queue sessionből${suffix}.`
  }
  // NYOMMAL: a body állítja az átnézést, ÉS megnevezi a PROVENANCE-t. Az AI-út és
  // a hunk-út MÁS állítás — az összemosás ugyanaz a hibaosztály lenne, amit a
  // reviewBody `tool` mezője már megszüntetett a findings-review-nál.
  const sources = Array.isArray(traceSources) ? traceSources : []
  const how = sources.includes('ai')
    ? sources.includes('hunk')
      ? 'claude -p AI-review + hunk inline review'
      : 'claude -p AI-review'
    : 'hunk inline review'
  return `Átnézve a next queue sessionben — ${how}${suffix}.`
}

/**
 * A PANEL LÁBLÉCE (footer): a VEZÉRLÉS A KERET ALJÁN, DIMMELVE.
 *
 * A user 3. elve: "`y/N`, budget-sor, review-út-választó DIMMELVE a dialógus
 * alján; a sárga CSAK valódi figyelmeztetésre. A tartalmi terület kapja a
 * hangsúlyt." Ezért a visszatérés `{ text, dim }` — a `dim` a SZERZŐDÉS része,
 * nem a nézet szabadsága.
 *
 * A SORREND szándékos: elöl a DÖNTÉS kulcsai, hátul a zárás. Ha a `clampCells`
 * szűk terminálon vág, a döntés kulcsai maradnak meg — egy lábléc, amiről nem
 * látszik, hogyan mondunk igent, használhatatlan (ugyanaz az elv, mint az
 * overlayFooter-ben; itt a panel-módokra alkalmazva).
 */
// (1c) A DEFAULT rLabel a RÖVID alak. MIÉRT NEM MARADHAT a hosszú: ha a hívó
// nem ad át címkét (régi hívási út, teszt), a lábléc a HOSSZÚ alakra esne vissza,
// és a panel MÁST hirdetne ugyanarra a kulcsra, mint a globális lábléc — pont az
// a három-forrásból-szétcsúszás, amit ez a modul fejében kimondott elv tilt.
// A `rKeyLabel`-t NEM hívhatjuk ide (az az ai-review-view rétegben lakik, ami
// FELETTE van a panelnek: azonnali ciklus lenne, amit a checker gépileg tilt),
// ezért a default egy literál — a wording-teszt köti össze a kettőt.
/**
 * @param {object} [opts]
 * @param {string} [opts.rLabel] az `r` ÁLLAPOTFÜGGŐ címkéje (lásd lentebb)
 * @param {boolean} [opts.canUpload] (wf31/17) VAN-E MIT FELTÖLTENI. `false` esetén
 *   az `f` szegmens KIESIK a láblécből.
 *
 *   A USER LELETE, szó szerint: "»review feltöltése« parancs nem lehetséges, amíg
 *   nincs review."
 *
 *   A HIBAOSZTÁLY UGYANAZ, amit ez a modul KÉT helyen már kimond: a `↑/↓` csak
 *   ott hirdetve, ahol van mit választani ("egy hirdetett, de nem működő nyíl
 *   DEAD KEY"), és a `panelKeys` fejében ugyanez ("a user nem tudta, a gomb
 *   rossz-e vagy a UI fagyott le"). Az `f` review nélkül pontosan ilyen dead key
 *   volt: a modál megnyílt, a `doUpload` pedig egy hangos hibával elhasalt —
 *   holott a művelet ELVBŐL nem volt lehetséges.
 *
 *   A DEFAULT `true`, NEM `false`: a régi hívási utak (és a wording-tesztek) a
 *   harmadik paramétert nem adják át, és egy `false` default NÉMÁN elvinné az `f`-et
 *   MINDENHONNAN — a hiányzó opció pedig sokkal nehezebben észrevehető, mint egy
 *   fölöslegesen hirdetett. A hívó (App) MÉRI a feltölthetőséget, és explicit
 *   `false`-t ad, ha nincs.
 */
export function panelFooter(st, columns = 120, { rLabel = 'r: review', canUpload = true, stackLabel = '' } = {}) {
  const limit = Math.max(1, Math.floor(Number(columns) || 1))
  if (!st || typeof st !== 'object') return { text: '', dim: true }
  if (st.mode === 'modal') {
    const denied = (st.modal?.blockers?.length ?? 0) > 0
    if (denied) {
      return { text: clampCells('bármely gomb: vissza — a művelet blokkolva van', limit), dim: true }
    }
    // A `↑/↓` CSAK ott, ahol VAN mit választani (lásd MODAL_CHOICE_KINDS): egy
    // hirdetett, de nem működő nyíl DEAD KEY — mért hiba volt az `f` modálján.
    const parts = ['y/N: döntés']
    // (wf31/69) `←/→`, NEM `↑/↓` — A MEGJELENÍTÉS IRÁNYÁHOZ IGAZÍTVA.
    //
    // A user lelete: "nincs jobbra-balra választhatóság, miközben van nyíl
    // karakter a »Nem« előtt". Jogos: a két választás EGY SORBAN, vízszintesen
    // áll (`▸ Nem   Igen`), a léptetés viszont fel/le volt — a szem a vízszintes
    // elrendezést látja, a keze a függőleges nyilat keresi. A kezelő MINDKÉT
    // irányt elfogadja (a fel/le izommemória nem törik), de a HIRDETÉS a
    // vízszintes, mert az illeszkedik a képhez.
    //
    // AZ ENTER IS KIMONDVA: az hajtja végre a kiválasztott ágat, és eddig sehol
    // nem szerepelt — egy nyilas választó, aminek a véglegesítése nincs hirdetve,
    // félkész affordance.
    if (modalHasChoices(st.modal?.kind)) parts.push('←/→: választás', '⏎: megerősítés')
    // (wf31/21) `Esc: vissza`, nem `Esc: vissza a panelre` — a user kérése. A
    // „hová" a képernyőről amúgy is látszik (a panel ott van a modál alatt), és a
    // többi Esc-címke sem nevezi meg a célt (`Esc: bezárás`, `Esc: vissza`).
    parts.push('Esc: vissza')
    return { text: clampCells(parts.join(' · '), limit), dim: true }
  }
  // INLINE: az ÖT AKCIÓ hirdetése — ez a refaktor látható eredménye (a lépések
  // a panelen belül vannak; a 3. pont a FELTÖLTÉS ajánlatát is ide kéri). A
  // navigáció és a zárás utána jön: ha vág, az AKCIÓK maradnak, mert a j/k és
  // az Esc amúgy is muscle memory.
  //
  // Az `r` címkéje ÁLLAPOTFÜGGŐ (rKeyLabel): a hívó adja át, mert a lábléc-építő
  // innen nem látja az aiReview state-et — a default a nyugalmi 'r: AI-review'.
  // (wf31/6) A WORDING: `f: review feltöltése`, nem `f: feltöltés`. A user
  // lelete, szó szerint: "»feltöltés« nem elég informatív. Legyen »review
  // feltöltése«." A puszta "feltöltés" nem mondja meg, MI kerül fel — és ez a
  // gomb egy KÍVÜLRŐL LÁTHATÓ, VISSZAVONHATATLAN akció (a PR-on megjelenik egy
  // review a user nevében, a szerző értesítést kap), tehát pont itt a legdrágább
  // a félreértés. A megerősítő modál fejléce (`upload`) ugyanezt mondja.
  //
  // (wf31/5) AZ ÜRES SZEGMENSEK KIESNEK. Futó review alatt az `rLabel` ÜRES (a
  // `rKeyLabel` `running` ága — lásd az indoklást ott), és egy üres szegmens a
  // naiv `join(' · ')`-ben LÓGÓ SZEPARÁTOR-PÁRT hagyna (`d: diff ·  · f: …`):
  // az a keret tipográfiáját is elrontja, és "eltűnt egy opció" érzetet ad.
  // A szűrés ITT, a BEILLESZTŐBEN él — a `rKeyLabel` csak azt dönti el, VAN-E
  // címke, azt nem, hogy hogyan fűzzük össze.
  // (wf31/17) AZ `f` CSAK AKKOR, HA VAN MIT FELTÖLTENI — az üres string a fenti
  // szűrőn kiesik, ugyanazon a MEGLÉVŐ úton, ahogy a futó review `rLabel`-je is.
  // (wf31/30) AZ `⏎` IS HIRDETVE: a user kérése ("Enter legyen az infó legendben
  // is"). A UNICODE JEL (`⏎` U+23CE, 1 cella — MÉRVE), nem a `Enter` szó: a
  // lábléc a legszűkebb felület, és a jel 5 cellát szabadít fel a szöveges
  // alakhoz képest. A user kérte így ("Legendben »Enter« helyett Enter karakter
  // legyen, van neki egy unicode jele").
  // (wf31/53) A STACKELÉS A MERGE UTÁN, A NAVIGÁCIÓ ELŐTT: az AKCIÓK blokkjának
  // vége. Csak akkor van címkéje, ha a MÉRÉS ajánlatot adott (`offerStack`) — egy
  // állandóan hirdetett `s` a PR-ok többségén dead key lenne, és pont azt a
  // hibaosztályt hozná vissza, amit az `f` feltételessége megszüntetett.
  // Az üres string a lenti szűrőn kiesik, ugyanazon a MEGLÉVŐ úton.
  const parts = ['d: diff', rLabel, canUpload ? 'f: review feltöltése' : '', 'a: approve', 'm: merge',
    stackLabel, 'j/k: sor', '⏎/Esc: bezárás']
    .filter((p) => String(p ?? '').trim() !== '')
  return { text: clampCells(parts.join(' · '), limit), dim: true }
}

// === PANEL-VÉGE =============================================================
