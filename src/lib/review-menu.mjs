// tuipr — REVIEW-MENU: az `r` HORIZONTÁLIS, CASCADE-OLT alopció-menüje.
//
// EZ A MODUL A RÉGI AI-REVIEW MEGERŐSÍTŐ MODÁL HELYÉT VESZI ÁT. A user
// szó szerinti kifogása: "a review dialog egy bloated valami, az a dialog
// szűnjön meg. A tartalma is feleslegesen bőbeszédű. A review egy user path, és
// csak egy cascade-olt horizontal menü legyen az info dialog alján."
//
// AMI EBBŐL KÖVETKEZIK, ÉS AMI NEM:
//   - MEGSZŰNIK: a sárga/narancs keretes AI-review overlay, a summary-sorok
//     (PR-méret, scope, kizárt fájlok NEVE, magyarázó bekezdések), a
//     review-út-választó LISTA a note-jaival, a `modelLine`/`budgetLine`
//     bőbeszédű alakjai, a "Megerősíted? [y/N]" sor;
//   - MEGMARAD: az INFO-PANEL a SAJÁT keret-színével (cyan), és minden VISELKEDÉSI
//     invariáns — a dwell-kapu (armedAt) az első `y`-on, a váltók újra-armolás
//     TILALMA, a fail-closed budget-szivárgás-tilalom, és hogy a token-költő
//     `claude -p` CSAK a megerősítésből indul.
//
// A MÁSIK HÁROM MEGERŐSÍTÉS (approve / merge / upload) VÁLTOZATLAN: azok
// `modalHasChoices`-alapú nyilas modáljai a friction-döntést hordozzák, amit a
// user NEM kért átalakítani. A szétválasztás azért TISZTA, mert a modál-út
// `kind`-ra ágazik: az `ai-review` kind egyszerűen NEM NYÍLIK meg többé
// (az `askAiReview` menüt nyit modál helyett), a másik három ág bájtra a régi.
//
// RÉTEGREND: lefelé importál (layout: a CELLÁBAN mérés és a ciklikus léptetés;
// ai-review-config: a review-utak, a modellek és a budget-fokozatok LÁTHATÓ
// listái + a léptetőik). SEMMIT nem importál a panelből vagy felette — a
// scripts/check-next-modules.mjs gépileg őrzi.
import { clampCells, displayWidth, stepIndex } from './layout.mjs'
import {
  AI_REVIEW_MODELS,
  BUDGET_STEPS_USD,
  REVIEW_PATHS,
  aiReviewModelState,
  modelStep,
} from './ai-review-config.mjs'

// === A MENÜ-ÁLLAPOT =========================================================

/**
 * A KÉT LÉPCSŐ NEVE. Konstansként, mert három helyen olvasunk rá (léptetés,
 * sor-építés, a visszalépés ága), és egy elgépelt string-literál NÉMÁN
 * viselkedés-váltás lenne (a `stage === 'confim'` ág sosem futna).
 */
export const REVIEW_MENU_STAGES = ['options', 'confirm']

/**
 * A BUDGET-KÖR a menüben: `off → 3 → 5 → 10 → off`.
 *
 * MIÉRT NEM A `budgetToggle`/`budgetStep` PÁR (amit a régi modál használt): ott
 * KÉT billentyű volt (`b` kapcsol, `←/→` léptet a teljes ötös listán), a user
 * viszont EGY ciklikus `b`-t kért, NÉGY állomással. A fokozatok a core LÁTHATÓ
 * `BUDGET_STEPS_USD`-jéből SZŰRVE jönnek, nem újra beírva: ha a lista változik,
 * a menü követi, és nem tud szétcsúszni a hívási úttal.
 *
 * A KIVÁLASZTOTT HÁROM (3/5/10) a lista FELSŐ vége: az 1 és a 2 USD egy
 * agent-fanoutos review-t FÉLÚTON vágna el (a token elköltve, finding nélkül) —
 * pontosan az a "rosszabb, mint a plafon nélküli futás" eset, amit az
 * ai-review-config budget-fejezete kimond. A menü tehát nem kínálja őket.
 */
const MENU_BUDGET_USD = BUDGET_STEPS_USD.filter((usd) => usd >= 3)

/**
 * A menü megnyitása az ELSŐ lépcsőn — az `r` billentyű.
 *
 * Az `armedAt` a dwell-kapu horgonya (a core `confirmAccepts`-e olvassa). Itt, a
 * MEGNYITÁSNÁL születik, nem a render alatt: a dwell azt méri, mióta van a
 * döntés a szem előtt, és egy renderben felvett időpont minden újrarendereléssel
 * újraindulna — a typeahead-védelem néma no-op lenne. (Ugyanaz az érv, ami a
 * `panelToModal` fejében áll; a mechanizmus a menüre VÁLTOZATLANUL érvényes,
 * mert a költés-döntés ugyanaz.)
 *
 * FAIL-CLOSED az érvénytelen horgony: NEM defaultolunk `Date.now()`-ra. Egy
 * kitalált időpont azt jelentené, hogy a kapu mér valamit, holott a hívó
 * elfelejtett mérni — és a `confirmAccepts` a nem-szám horgonyra amúgy is
 * ZÁRVA marad, tehát a hiba HANGOS lesz (a `y` nem fog átmenni), nem néma.
 */
export function reviewMenuOpen({ armedAt, modelEnv, budgetEnv } = {}) {
  const model = aiReviewModelState({ env: modelEnv })
  return {
    stage: 'options',
    armedAt,
    // A default a CI-vel BIT-AZONOS `agent-review` — a meglévő core-döntés
    // (REVIEW_PATHS `default: true`), itt csak leképezve. A `Math.max(0, …)` a
    // fail-soft: ha a flag valaha eltűnne a listáról, az ELSŐ útra esünk, nem
    // egy -1-es indexre (ami `undefined` utat, azaz némán elveszett választást adna).
    pathIndex: Math.max(0, REVIEW_PATHS.findIndex((p) => p.default)),
    model,
    // A budget KEZDŐÉRTÉKE az env-ből, DE a menü négyes körére NORMALIZÁLVA: egy
    // env-ből jött 1 USD nem lenne benne a körben, tehát a `b` első nyomása
    // kiszámíthatatlan helyre vinne.
    budget: normalizeBudget(budgetEnv),
  }
}

/**
 * Az env-ből jött plafon a MENÜ körére normalizálva.
 *
 * A SZŰRÉS FAIL-CLOSED a KIKAPCSOLT irányba (ugyanaz az elv, mint az
 * `aiReviewBudgetState`-ben): ami nem a menü fokozata, az NEM választás. Egy
 * "megőrzött, de a körön kívüli" szám a `b` léptetését kiszámíthatatlanná tenné,
 * a `usd` szivárgása pedig a `--max-budget-usd` néma kimenését okozhatná.
 */
function normalizeBudget(env) {
  const n = Number(env)
  if (Number.isFinite(n) && MENU_BUDGET_USD.includes(n)) return { enabled: true, usd: n }
  return { enabled: false, usd: undefined }
}

/**
 * Az `r` a menün: TOGGLE. Nyitott menün ZÁR (null), zárton NYIT.
 *
 * MIÉRT ÖNMAGA INVERZE: az `r` a menü hirdetett kulcsa, és a lábléc-sorban
 * MARAD a helyén, amíg a menü nyitva van — ha a második `r` nem zárna, a user
 * ugyanarra a gombra nyomva nem kapna változást (a "gomb nem működik vagy
 * lefagyott a UI?" bizonytalanság, amit ez a projekt máshol is tilt).
 *
 * A NULL a zárás: EGY state null-ozódik, tehát ORPHAN MENÜ nem maradhat (ugyanaz
 * a szerződés, mint a `panelClose`-nál).
 */
export function reviewMenuToggle(st, { armedAt } = {}) {
  if (st && typeof st === 'object') return null
  return reviewMenuOpen({ armedAt })
}

/**
 * A CIKLIKUS VÁLTÓK: `tab` (review-út), `m` (modell), `b` (budget).
 *
 * AZ `armedAt`-HOZ NEM NYÚLUNK — ez MEGLÉVŐ INVARIÁNS, és a legfontosabb, amit
 * ez a modul nem törhet meg. Ha a váltók újra-armolnának, a `tab`/`m`/`b`
 * nyomkodásával a 250 ms-os dwell VÉGTELENÜL újraindulna, és a typeahead-védelem
 * pont azon az úton válna kikerülhetővé, amit épp most adtunk hozzá. (A régi
 * modál három külön kulcs-ága ugyanezt mondta ki, három helyen; itt EGY
 * függvényben van, tehát nem tud szétcsúszni.)
 *
 * EGY BELÉPÉSI PONT MIND A HÁROMRA, szándékosan: külön függvényekben az
 * armedAt-kezelés szétcsúszhatna (az egyik armol, a másik nem — és a dwell-kapu
 * épp az, ami így kikerülhetővé válna). A léptetés a TESZTELT `stepIndex`-en megy
 * át, nem inline modulón.
 */
export function reviewMenuStep(st, what, delta = +1) {
  if (!st || typeof st !== 'object') return st
  // A MÁSODIK LÉPCSŐN A VÁLTÓK NEM ÉLNEK: ott már csak igen/vissza van (a
  // menü-sor sem hirdeti őket). Egy néma léptetés ott azt jelentené, hogy a user
  // MÁS paraméterrel indít, mint amit a második lépcsőn LÁTOTT.
  if (st.stage !== 'options') return st
  if (what === 'path') {
    return { ...st, pathIndex: stepIndex(st.pathIndex, REVIEW_PATHS.length, delta) }
  }
  if (what === 'model') {
    // A core `modelStep`-je a mérték (körbejár a LÁTHATÓ listán, és a
    // lista-idegen env-névről a defaultra visz) — nem írjuk újra.
    return { ...st, model: modelStep(st.model, delta) }
  }
  if (what === 'budget') {
    return { ...st, budget: budgetCycle(st.budget, delta) }
  }
  return st
}

/**
 * A budget NÉGYES köre: `off → 3 → 5 → 10 → off`.
 *
 * A KIKAPCSOLT állapotban az `usd` ELTŰNIK — nem "megőrzött, de inaktív" érték.
 * Ez a meglévő argv-guard invariánsa: egy inaktív szám a hívási úton pont az a
 * szivárgás, amit a `budgetArgs` tesztje tilt (a `--max-budget-usd` kikapcsolva
 * EL SEM MEGY az argv-be).
 */
function budgetCycle(state, delta = +1) {
  // A kör állomásai: a `null` az OFF, utána a fokozatok. Egy tömbön léptetünk,
  // hogy a wrap a `stepIndex` TESZTELT szerződését kapja (körbejár, a degenerált
  // indexet előbb normalizálja) — enélkül a saját modulóm külön hibaosztály lenne.
  const ring = [null, ...MENU_BUDGET_USD]
  const cur = state?.enabled === true ? ring.indexOf(Number(state.usd)) : 0
  const usd = ring[stepIndex(cur >= 0 ? cur : 0, ring.length, delta)]
  if (usd === null) return { enabled: false, usd: undefined }
  return { enabled: true, usd }
}

/**
 * A `y` LÉPTETÉSE — a KÉT LÉPCSŐ állapotgépe.
 *
 * A visszatérés `{ action, state }`, és az `action` HÁROM értéke a hívó
 * szerződése:
 *   - `'advance'` — a MÁSODIK lépcsőre léptünk (van figyelmeztetés). Nem indul semmi.
 *   - `'run'` — INDÍTUNK. A `state` null, tehát a menü ZÁRUL.
 *   - `'noop'` — érvénytelen bemenet; fail-closed, NEM indítunk.
 *
 * FIGYELMEZTETÉS NÉLKÜL AZ ELSŐ `y` AZONNAL INDÍT (a user kötelme): egy ÜRES
 * második lépcső — "erősítsd meg, hogy… semmi" — pontosan az a tartalom nélküli
 * friction, amit ez az egész átalakítás megszüntet.
 *
 * A MÁSODIK LÉPCSŐ NEM KAP ÚJ dwell-horgonyt. A user kötelme: "A DWELL-KAPU
 * MARAD az első `y`-on". Egy friss arm itt a második `y` elé is 250 ms-ot tenne,
 * amit senki nem kért — és a pufferelt kettős-`y` ellen sem védene jobban, hiszen
 * az ELSŐ `y` már átment a kapun (tehát a képernyő már a szem előtt volt).
 */
export function reviewMenuAdvance(st, { warning = null } = {}) {
  if (!st || typeof st !== 'object') return { action: 'noop', state: st ?? null }
  if (st.stage === 'confirm') return { action: 'run', state: null }
  const w = typeof warning === 'string' && warning.trim() !== '' ? warning : null
  if (w === null) return { action: 'run', state: null }
  // Az `armedAt` VÁLTOZATLANUL utazik tovább (lásd fent), a figyelmeztetés
  // SZÖVEGE viszont a state-be kerül: a második lépcső sora ezt írja ki, tehát a
  // MEGJELENÍTETT és a DÖNTÉST kiváltó szöveg egy forrásból való.
  return { action: 'advance', state: { ...st, stage: 'confirm', warning: w } }
}

/**
 * Az `Esc`: az ELSŐ lépcsőn ZÁR (null), a MÁSODIKON VISSZALÉP az elsőre.
 *
 * A user szava: "Esc: vissza". A második lépcsőről a visszalépés a VÁLASZTÁSOKAT
 * MEGTARTJA (`pathIndex`/`model`/`budget`) — a user már beállította őket, és
 * egy meggondolt-magam gesztus nem dobhatja el a munkáját (ugyanaz az elv, amiért
 * a régi modál Esc-je az info-panelre lépett vissza, nem a listára).
 *
 * A `warning` SZÖVEGE viszont ELTŰNIK: az a MÉRÉSBŐL jön (a `reviewPathWarning`
 * a friss fájl-listából), tehát egy state-ben megtartott másolat elavulhatna. A
 * következő `y` újra megkérdezi.
 */
export function reviewMenuBack(st) {
  if (!st || typeof st !== 'object') return null
  if (st.stage !== 'confirm') return null
  const { warning: _dropped, ...rest } = st
  return { ...rest, stage: 'options' }
}

/**
 * A KIVÁLASZTÁS a hívási útra: `{ reviewPath, model, maxBudgetUsd }`.
 *
 * A MENÜBEN LÁTOTT ÉRTÉKEK mennek át, nem egy újraszámolás — ez a régi modál
 * szerződése, VÁLTOZATLANUL: "a user PONTOSAN azt a modellt kapja, amit a
 * modell-sor mutatott". Ha a futtató máshonnan defaultolna, a megjelenített és
 * az élő paraméter szétcsúszhatna, és a user egy MÁS (drágább) tieren futtatna,
 * mint amit látott — a mért lelet, amiből az egész modell-választó született.
 *
 * A `maxBudgetUsd` KIKAPCSOLVA `undefined`, tehát a core `budgetArgs`-a a flaget
 * EL SEM KÜLDI (fail-closed a flag ELHAGYÁSA felé).
 */
export function reviewMenuSelection(st) {
  const pathIndex = Number.isInteger(st?.pathIndex) ? st.pathIndex : 0
  return {
    reviewPath: REVIEW_PATHS[pathIndex]?.id ?? REVIEW_PATHS[0].id,
    model: st?.model?.id ?? AI_REVIEW_MODELS[0].id,
    maxBudgetUsd: st?.budget?.enabled === true ? st.budget.usd : undefined,
  }
}


// === A FIGYELMEZTETÉS TÖMÖR ALAKJA ==========================================

/**
 * A MÁSODIK LÉPCSŐ figyelmeztetés-sora, vagy `null` (nincs mire figyelmeztetni).
 *
 * A user példája SZÓ SZERINT ez az alak:
 *     35 fájl, +3280/-508 sor — nagy PR, sok tokent fogyaszt
 *
 * MIÉRT NEM A MEGLÉVŐ `reviewPathWarning`: az a RÉGI DIALÓG bőbeszédű sora
 * ("FIGYELEM — KÖLTSÉG: 35 fájl (> 30) és 3788 diff-sor (> 2000). A review-utak
 * agent-fanoutosak, tehát a token-költés ezen a méreten már érdemi, és a
 * findingok átolvasása is hosszú lesz." = 200+ CELLA) — egyetlen menü-sorba
 * SEMMILYEN terminálon nem fér be, és pontosan az a "feleslegesen bőbeszédű"
 * tartalom, amit a user leváltott. A KÜSZÖBÖKET viszont VÁLTOZATLANUL onnan
 * vesszük: a `reviewPathWarning` a MÉRTÉK (>30 fájl VAGY >2000 sor), ez a
 * függvény csak a MEGJELENÍTÉST tömöríti. Két küszöb-forrás pont az az
 * elcsúszás, amit a projekt máshol is tilt — ezért a hívó adja át a döntést.
 *
 * A MÉRT SZÁMOK BENNE VANNAK (fájlszám + a két churn-irány): egy általános "ez
 * nagy PR" nem auditálható, és a user nem tudná, MENNYIRE nagy. Ez a
 * `reviewPathWarning` fejében kimondott elv, tömör alakban megtartva.
 */
export function reviewMenuWarning({ fileCount = 0, additions = 0, deletions = 0, large = false } = {}) {
  if (large !== true) return null
  return `${fileCount} fájl, +${additions}/-${deletions} sor — nagy PR, sok tokent fogyaszt`
}


// === A MENÜ SORAI ===========================================================

/**
 * A menü-sor SZEPARÁTORA — a user kérése: horizontális, `·`-tal.
 * A körülvevő szóközökkel együtt 3 CELLA; a degradáció ezzel számol.
 */
const SEP = ' · '

/**
 * Az `r: review` LÁBLÉC-CÍMKE és a POZÍCIÓ-HORGONY.
 *
 * A user specifikációja: "a review legend tartsa meg a pozícióját (tehát a
 * d: diff helyén kihagyás legyen)". A `d: diff · ` a normál `panelFooter`
 * INLINE ágának ELSŐ szegmense, tehát a horgony CELLÁBAN mért szélessége
 * pontosan ennyi.
 *
 * MIÉRT ITT, KONSTANSKÉNT, ÉS MIÉRT NEM A `panelFooter`-BŐL SZÁMOLVA: a
 * `panelFooter` a PANEL modulban lakik, ami FELETTE van ennek a rétegnek
 * (a panel a legfelső core-réteg) — a hívása AZONNAL ciklus lenne, amit a
 * checker gépileg tilt. Ugyanaz a helyzet, ami a `panelFooter` `rLabel`
 * defaultjánál ki van mondva; a KÖTÉST ott is, itt is a TESZT végzi (a
 * next-review-menu.test.ts a `panelFooter` tényleges kimenetéből SZÁMOLJA ki a
 * várt oszlopot, tehát egy elcsúszás bukik).
 */
const R_ANCHOR_PREFIX = 'd: diff · '

/**
 * (wf31/7) A HORGONY JELÖLÉSE — a `▸` + egy szóköz, ami a prefix UTOLSÓ KÉT
 * CELLÁJÁBA ÜL BE (nem ad hozzá).
 *
 * `displayWidth('▸') === 1`: a U+25B8 (BLACK RIGHT-POINTING SMALL TRIANGLE)
 * NINCS a `WIDE_RANGES`-ben, tehát egy cellás — a cella-aritmetika (és vele az
 * `r: review` oszlop-pozíciója) VÁLTOZATLAN. A `▸` TEXT-alak, nem emoji: az
 * emoji-változat 2 cellás lenne, ami pont a pozíció-invariánst törné el (mért
 * hibaosztály — lásd a `⚠` vs `⚠️` döntést a render-modulban).
 *
 * MIÉRT NEM `▶`/`>`/`*`: a `▸` a projekt MEGLÉVŐ "ez a kiválasztott" glifje — a
 * review-út-választó és a modál igen/nem választása is EZT használja
 * (`tui-render.mjs`), tehát a user szeme már megtanulta. Egy második
 * jelölés ugyanarra a fogalomra új szótárat nyitna.
 */
const R_ANCHOR_MARK = '▸ '

/**
 * A menü SOR-LEÍRÓI — az app render-fája ebből épül.
 *
 * A visszatérés `{ key, text, color?, dimColor?, segments? }` sorok tömbje,
 * ugyanaz az alak, amit a panel többi sor-építője (`aiReviewPanelLines`,
 * `frictionLines`) használ — a render `renderLines`-a így változatlanul fogyasztja.
 *
 * A KÉT SOR (a user MÓDOSÍTOTT specifikációja szerint):
 *   [0] a LÁBLÉC: a `d: diff` helyén SZÓKÖZ-kihagyás, majd az `r: review`
 *       ugyanabban a display-CELLÁBAN, ahol a normál láblécben állt;
 *   [1] a MENÜ-SOR, KÖZVETLENÜL alatta, horizontálisan, `·` szeparátorral.
 *
 * (wf28/3) AZ ÜRES SOR KIVEZETVE. A user MÓDOSÍTÁSI kérése, szó szerint:
 * "review legend és a második menü sor között ne legyen üres sor. Ez
 * módosítási kérés tőlem, mert üres sorral kértem, de inkább zavaró." Az élő
 * teszten a kihagyás nem szellőzésnek, hanem zajnak bizonyult — és MELLÉKHATÁSA
 * is volt: egy sorral lejjebb tolta a menü-sort, tehát a `r: review` horgony
 * pozíciója sem egyezett a normál lábléccel (a "pozicionális anchor" érzet,
 * amit a wf28/1 észrevétel is védett).
 */
export function reviewMenuLines(st, { innerWidth = 100 } = {}) {
  if (!st || typeof st !== 'object') return []
  const W = Math.max(1, Math.floor(Number(innerWidth) || 1))
  // A LÁBLÉC: a kihagyás SZÓKÖZ (nem pont, nem vonal) — a user szava "kihagyás".
  // A `clampCells` a fail-soft: nagyon szűk mértéken a horgony-prefix maga is
  // elfogyhat, és akkor a címke a 0. oszlopból indul. Az ALTERNATÍVA (a prefix
  // megtartása a címke ELVESZTÉSE árán) rosszabb: egy menü, aminek nincs
  // fejsora, nem mondja meg, MIRŐL szól.
  //
  // (wf31/7) A HORGONY HÁROMRÉTEGŰ HIGHLIGHTOT KAP: `▸` + cyan + bold.
  //
  // A USER LELETE, szó szerint: "a felsőszintű »r: review« mint egyedüli elem
  // szerintem kapjon valami highlight-szerűséget is, mert bár a pattern jó,
  // mégse tűnik fel a usernek, hogy ott ki lett választva egy elem, és annak az
  // almenüjét látjuk."
  //
  // A MÉRT OK: ez a sor `dimColor: true` volt — PONTOSAN olyan dim, mint az
  // alatta lévő menü-sor MINDEN szegmense. Nulla kontraszt: a "kiválasztott"
  // horgony szemantikailag azonos súlyú a TARTALMÁVAL, tehát a szem nem találja
  // meg a hierarchiát. A projekt máshol HÁROMRÉTEGŰ jelölést használ ugyanerre a
  // fogalomra (a lista kurzora: glif + szín + bold, a többi dim) — ez tehát nem
  // új szótár, hanem a meglévő idióma alkalmazása.
  //
  // A GLIF A PREFIX CELLÁJÁBA ÜL BE, NEM AD HOZZÁ. Ez a `╰─` bevált mintája
  // (`rows.mjs`: "a jelölés a behúzás UTOLSÓ KÉT CELLÁJÁBA ÜL BE, nem ad
  // hozzá"): `displayWidth('▸') === 1`, tehát a `8 szóköz + '▸ '` PONTOSAN annyi
  // cella, mint a `'d: diff · '` prefix — a POZÍCIÓ-INVARIÁNS (az `r: review`
  // ugyanabban az oszlopban áll, mint a normál láblécben) SÉRTETLEN, és a szűk
  // terminált NULLA cellával terheljük.
  //
  // CYAN, NEM ZÖLD: itt nincs "megmértük, és rendben van" állítás, a zöld
  // inflálása pedig kimondott hibaosztály (lásd a render Verdict-blokkját). A
  // cyan az info-panel keretének és a lista kurzorának a színe — a
  // "fókusz / aktív tengely" olvasat bejáratott.
  const labelText = clampCells(`${' '.repeat(displayWidth(R_ANCHOR_PREFIX) - displayWidth(R_ANCHOR_MARK))}${R_ANCHOR_MARK}r: review`, W)
  // FAIL-SAFE (KÖTELEM): a `clampCells` nagyon szűk mértéken a prefixet is
  // elfogyaszthatja. Ha a `▸` KIKERÜL, de az `r: review` címke ELVESZIK, egy
  // MAGÁNYOS NYÍL azt HAZUDNÁ, hogy valami ki van választva — anélkül, hogy
  // megmondaná, MI. A `╰─` ugyanerre az esetre ír fail-safe-et (`rows.mjs`).
  // A SZABÁLY: a jelölés a CÍMKÉVEL EGYÜTT él vagy hal — ha a címke nem fér ki,
  // a glif is megy, és a maradék hely a címke-töredéknek jut (az informatívabb).
  const marked = labelText.includes('r: review')
    ? labelText
    : clampCells('r: review', W)
  // (wf28/3) NINCS GAP-SOR. Nem elég a szövegét kiüríteni: egy üres sor-leíró
  // ugyanazt a MAGASSÁGOT vinné el a render-fából (és a `menuExtraRows`
  // becslése is egy sorral többet foglalna, mint amennyit renderelünk) — a sor
  // tehát MEG SEM SZÜLETIK.
  //
  // (wf31/7) A `dimColor` ELTŰNT erről a sorról (a menü-sor szegmensei MARADNAK
  // dimek) — a kontraszt kétirányú: a horgony kiemelt, a tartalma halk.
  const out = [
    { key: 'rm-label', text: marked, color: 'cyan', bold: true },
  ]
  if (st.stage === 'confirm') {
    // A MÁSODIK LÉPCSŐ: a figyelmeztetés PIROSAN (a user: "(pirossal)"), utána a
    // két kulcs. A VÁLTÓK ELTŰNNEK — ott már nincs mit állítani, csak igen/vissza.
    out.push({
      key: 'rm-menu',
      // A `segments` a SZÍNEZETT szakaszok: a figyelmeztetés piros, a kulcsok
      // dimmeltek. A `text` a teljes sor (a szélesség-teszt és a frame-assertek
      // EZT mérik) — a kettő ugyanabból a szegmens-listából épül, tehát nem tud
      // szétcsúszni.
      ...joinSegments(
        [
          { text: String(st.warning ?? ''), color: 'red', prio: 0 },
          { text: 'y: megerősítés', dimColor: true, prio: 1 },
          { text: 'Esc: vissza', dimColor: true, prio: 2 },
        ],
        W,
      ),
    })
    return out
  }
  // AZ ELSŐ LÉPCSŐ: CSAK AZ AKTUÁLIS ÉRTÉK látszik minden váltón (a user
  // pontosítása). A régi modál a TELJES választékot listázta a note-jaival —
  // pontosan az a "feleslegesen bőbeszédű" tartalom, amit ez leváltott.
  //
  // A DEGRADÁCIÓS RANG (a `prio` mező) — ÉS AZ INDOKLÁSA:
  //   0. `y: megerősítés` és 1. `Esc: vissza` — ELŐBB ezek. Egy menü, amiről nem
  //      látszik, hogyan mondunk igent vagy hogyan lépünk vissza, HASZNÁLHATATLAN
  //      (ugyanaz az elv, ami az `overlayFooter` fejében ki van mondva);
  //   2. `tab: review-út` — a KÖVETKEZMÉNYES választás (a CI-egyezés vs. eltérő
  //      szabályok), tehát a váltók közül ez a legfontosabb;
  //   3. `m: model` — a NAGYOBB költség-kar (a mért leletben egy Fable-futás
  //      vitte el a user teljes keretét);
  //   4. `b: budget` — a legkevésbé fontos: a `--max-budget-usd` hatása
  //      subscription alatt BIZONYTALAN (lásd az ai-review-config budget-fejezetét),
  //      tehát ez fogy ELSŐKÉNT.
  //
  // A KIÍRÁS SORRENDJE viszont a user példáját követi (tab · m · b · y · esc) —
  // a `prio` csak azt dönti el, MI FOGY ELŐBB, nem azt, mi hol áll.
  const path = REVIEW_PATHS[Number.isInteger(st.pathIndex) ? st.pathIndex : 0] ?? REVIEW_PATHS[0]
  out.push({
    key: 'rm-menu',
    ...joinSegments(
      [
        { text: `tab: review-út (${pathValueLabel(path)})`, dimColor: true, prio: 2 },
        { text: `m: model (${st.model?.id ?? AI_REVIEW_MODELS[0].id})`, dimColor: true, prio: 3 },
        { text: `b: budget (${budgetValueLabel(st.budget)})`, dimColor: true, prio: 4 },
        { text: 'y: megerősítés', dimColor: true, prio: 0 },
        { text: 'Esc: vissza', dimColor: true, prio: 1 },
      ],
      W,
    ),
  })
  return out
}

/**
 * A review-út RÖVID értéke — a user példája szerint `agent-review`, illetve `/code-review`.
 *
 * MIÉRT NEM A `label`: az a HOSSZÚ, magyarázó alak ("agent-review (6
 * skill-delegált sweep, bit-azonos a CI-vel)") — az a régi dialóg bőbeszédűsége.
 * A menüben az AZONOSÍTÓ elég: aki a menüt nyomkodja, tudja, mit választ.
 */
function pathValueLabel(path) {
  // Az `agent-review` → `agent-review` a user példájából; a másik út a SAJÁT
  // slash-command alakjában látszik (`/code-review`), mert ott pont az a
  // felismerhető név.
  if (path?.id === 'agent-review') return 'agent-review'
  return path?.command?.split(' ')[0] ?? String(path?.id ?? '?')
}

/** A budget értéke: `off`, vagy a fokozat USD-ben (a user példája: `(off)`). */
function budgetValueLabel(budget) {
  if (budget?.enabled !== true) return 'off'
  return `${budget.usd} USD`
}

/**
 * A SZEGMENSEK HORIZONTÁLIS ÖSSZEFŰZÉSE, CELLÁRA méretezve — `{ text, segments }`.
 *
 * A DÖNTÉS ÉS AZ INDOKLÁSA (a task explicit kérése): a menü-sor a MÉRT
 * legrosszabb esetben
 *     'tab: review-út (/code-review) · m: model (sonnet) · b: budget (10 USD) · y: megerősítés · Esc: vissza'
 * = **101 CELLA**. Az `overlayFrame` belső szélessége 60 oszlopon **54**, 100
 * oszlopon **94** — tehát a naiv konkatenáció MINDKETTŐN túllóg. Két út volt:
 *
 *   (A) TÖRDELÉS több sorra (`wrapCells`), vagy
 *   (B) FOKOZATOS DEGRADÁCIÓ: a legkevésbé fontos szegmens KIESIK (a `listLayout`
 *       tail-degradációjának mintája).
 *
 * (B)-t VÁLASZTOTTAM, három okból:
 *   1. A user KIFEJEZETTEN EGY sort kért ("egy cascade-olt HORIZONTAL menü"). Egy
 *      tördelt, két-három soros menü már nem az — és pont a "bloated" kifogásra
 *      adott válaszként hízna vissza.
 *   2. A PANEL MAGASSÁGA VÉGES, és a `panelViewport` a LISTA rovására adja: egy
 *      szűk terminálon a tördelt menü SOROKAT vinne el a queue-listából, ami a
 *      döntés kontextusa (a `PANEL_MIN_LIST_ROWS` fejezete pontosan ezt védi).
 *   3. A KIESŐ SZEGMENS NEM VESZTESÉG: a `tab`/`m`/`b` KÉNYELMI váltó — a
 *      default (agent-review / opus / off) mind a három nélkül is működik és
 *      ELINDUL. A `y`/`esc` viszont a DÖNTÉS maga, ezért az fogy LEGUTOLSÓNAK
 *      (`prio` 0 és 1).
 *
 * AMIT NEM tettem: rövidebb CÍMKÉKRE degradálás (`tab: út (agent-review)` → `t:agent`).
 * Az a rejtjelezés — a user a MAI, olvasható alakot kérte, és egy félig
 * megfejthető menü rosszabb, mint egy szegmenssel kevesebb.
 *
 * A HÁTSÓ VÉGRŐL fogyás NEM ELÉG önmagában: a `y`/`esc` a sor VÉGÉN áll (a user
 * példája szerint), tehát a puszta tail-vágás pont a legfontosabbat vinné el.
 * Ezért a `prio` mező dönt arról, MI esik ki, és a MEGMARADTAK a KIÍRÁSI
 * sorrendjükben állnak össze.
 */
function joinSegments(segments, width) {
  const W = Math.max(1, Math.floor(Number(width) || 1))
  // A FOKOZATOK: a legkevésbé fontos szegmenst dobjuk el először, és minden
  // fokozat után ÚJRA MÉRÜNK. A ciklus MINDIG terminál: a legrosszabb esetben
  // egyetlen szegmens marad, azt pedig `clampCells` vágja a mértékre.
  const byPrio = [...segments].filter((s) => String(s.text ?? '').trim() !== '')
  const order = [...byPrio].sort((a, b) => (b.prio ?? 0) - (a.prio ?? 0))
  let dropped = 0
  for (;;) {
    const keep = byPrio.filter((s) => !order.slice(0, dropped).includes(s))
    const text = keep.map((s) => s.text).join(SEP)
    if (displayWidth(text) <= W || keep.length <= 1) {
      // AZ UTOLSÓ SZEGMENS IS TÚLLÓGHAT egy nagyon szűk mértéken (pl. 10 cella).
      // Ilyenkor CELLÁRA vágjuk — a `clampCells` codepoint-alapon, tehát nem
      // hasít félbe surrogate párt, és a keret nem esik szét. A CSONKOLÁS itt
      // néma, DE nem hazug: a `y`/`esc` a legrövidebb szegmensek, tehát egy
      // ilyen szűk terminálon a user amúgy sem a menüt olvassa.
      const clamped = clampCells(text, W)
      return {
        text: clamped,
        // A `segments` a SZÍNEZÉSHEZ: ha a `clampCells` vágott, a szegmenseket
        // NEM adjuk ki (a render a `text`-et írja ki egy színnel) — különben a
        // szegmensek összege HOSSZABB lenne, mint a `text`, és az Ink tördelne.
        segments: clamped === text
          ? keep.map((s, i) => ({
              text: (i === 0 ? '' : SEP) + s.text,
              color: s.color,
              dimColor: s.dimColor,
            }))
          : undefined,
      }
    }
    dropped += 1
  }
}
