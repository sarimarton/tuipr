// tuipr — LAYOUT: cella-mérés és -csonkolás.
//
// A LEGALSÓ RÉTEG: ez a modul NULLA projekt-modult importál, és nem is fog —
// a cache-en kívül szinte minden modul hívja (displayWidth, clampCells), tehát
// bármilyen visszafelé mutató import AZONNAL ciklust csinálna. A ciklus ebben a
// projektben MÉRT, NÉMA hibaosztály (exit 13, 0 bájt kimenet) — az indoklás a
// bin/tui-core.mjs fejlécében áll.
//
// Miért CELLA és nem karakter: a terminál cellákban renderel, a `.length` pedig
// UTF-16 code unitot számol. A kettő eltérése az a tördelés-osztály, amit a user
// NÉGYSZER bejelentett (emoji, variation selector, East-Asian-Wide jelek).

// East-Asian-Width "Wide" (W) és "Fullwidth" (F) intervallumok — a terminál
// ezeket 2 cellán rendereli. RANGE-alapú, NEM codepoint-whitelist: a korábbi
// lista (0x26a1/0x26d4/0x2753 + a 0x1f300–0x1faff emoji-blokk) csak a MAI
// ikon-készletet fedte, így a ✅ U+2705 / ❌ U+274C / ⏳ U+23F3 (mind EAW=W,
// tmux-ban MÉRT advance = 2) némán 1-nek méretett volna — a title-büdzsé
// elcsúszik, az Ink tördel, a bash-sor túllóg. A hiba akkor csapott volna be,
// amikor valaki ilyen ikont vezet be; ezért a mérő most a szabályt követi, nem
// a jelenlegi ikonokat.
//
// A tábla az Unicode EastAsianWidth.txt W+F osztályaiból van szűkítve arra,
// ami terminál-UI-ban egyáltalán előfordulhat (CJK, Hangul, kana, a
// dingbat/misc-symbol Wide szigetek és az emoji-blokkok).
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a],
  [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653],
  [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5],
  [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
  [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e],
  [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
]

function isWideCodePoint(cp) {
  for (const [lo, hi] of WIDE_RANGES) if (cp >= lo && cp <= hi) return true
  return false
}

/**
 * Egy string terminál-cellában mért szélessége.
 *
 * Ugyanaz a csapda, mint a bash lista-nézetben: a variation selector (U+FE0F)
 * maga 0 cellát foglal, de a mögötte álló text-presentation base jelet 2
 * cellásra emeli (⚠️ = U+26A0 U+FE0F); az East-Asian-Wide jelek (⛔ U+26D4,
 * ❓ U+2753, ⚡ U+26A1, 🚀 U+1F680) pedig eleve 2-esek. Az 1 cellás jelek: az
 * ASCII, az ékezetes latin, és a ● / ○ / ✔ / ✗ (EAW=Ambiguous ill. Neutral).
 * A `.length` (UTF-16 code unit) tehát használhatatlan.
 *
 * A szélességek valódi terminál-emulátorban (tmux, cursor-advance) MÉRVE, és a
 * test/next-tui.test.ts kézzel számolt konstansokra pineli őket — a mérő nem
 * hivatkozhat önmagára.
 */
export function displayWidth(s) {
  const chars = [...String(s)]
  let total = 0
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0)
    if (cp === 0xfe0f) continue // variation selector: 0 cella
    // A VS16 a text-presentation jelet emoji-presentationra emeli → 2 cella.
    const wide = chars[i + 1]?.codePointAt(0) === 0xfe0f || isWideCodePoint(cp)
    total += wide ? 2 : 1
  }
  return total
}

// A soronkénti fix rész: kurzor(2) + "#" + szám(5) + szóköz + szerző(5) +

/**
 * Egy string csonkolása CELLÁRA (nem karakterre), codepoint-alapon.
 *
 * Ugyanaz a csapda, amit a user NÉGYSZER bejelentett: a `.slice` UTF-16 code
 * unitot vág, tehát (a) félbehasíthat egy surrogate párt (a terminálon
 * törmelék-glif), és (b) az emojikat 1 cellásnak hiszi, így a cellában mért
 * szélesség TÚLLÓG — az Ink tördel, és a keret szétesik. Itt a displayWidth
 * halmozódik codepointonként, és a limit ELÉRÉSEKOR állunk le.
 */
export function clampCells(s, cells) {
  const limit = Math.max(0, Math.floor(cells))
  if (limit === 0) return ''
  const chars = [...String(s)]
  let out = ''
  for (let i = 0; i < chars.length; i++) {
    // A NÖVEKMÉNYT a PREFIX újramérésével kapjuk, NEM `displayWidth(chars[i])`-vel.
    // MÉRT BUG (a saját tesztem kapta el): a displayWidth a VS16-ot úgy kezeli,
    // hogy az ELŐZŐ jelet emeli 2 cellásra (⚠️ = U+26A0 U+FE0F). Codepointonként
    // mérve a pár 1 + 0 = 1 cellának jön ki 2 helyett, tehát a csonkolt cím
    // CELLÁBAN túllógott (55 cella egy 54-es keretben) — pontosan az a
    // tördelés-osztály, amit a user négyszer bejelentett. A prefix-mérés a
    // lookaheadot megtartja.
    const next = out + chars[i]
    if (displayWidth(next) > limit) return out
    out = next
  }
  return out
}

/**
 * Egy szöveg tördelése CELLA-szélességre, sorok tömbjét adva.
 *
 * MIÉRT A CORE-BAN ÉS MIÉRT NEM AZ INK TÖRDELÉSE: a hiba-overlay tartalma nyers
 * `gh`/`git` stderr — több soros, hosszú sorokkal, néha szóköz nélküli URL-lel
 * vagy tokennel. Ha ezt az Ink saját tördelésére bíznánk, a keretes Box belsejét
 * a MI szélesség-számításunk nélkül tördelné, és a keret szétesne (pontosan az
 * osztály, amit a user négyszer bejelentett). Itt a mérték ugyanaz a
 * displayWidth, amivel a keret is számol.
 *
 * A tördelés (a) megtartja a MEGLÉVŐ sortöréseket (a stderr szerkezete
 * információ), (b) szóhatáron tör, de (c) a szónál hosszabb törmeléket
 * kényszerből elvágja — enélkül egy URL túllógna.
 */
export function wrapCells(text, cells) {
  const limit = Math.max(1, Math.floor(Number(cells) || 0))
  if (text === null || text === undefined) return []
  const src = String(text)
  if (src === '') return []
  const out = []
  for (const para of src.split('\n')) {
    if (para.trim() === '') { out.push(''); continue }
    let line = ''
    for (const word of para.split(/\s+/).filter((w) => w.length > 0)) {
      const cand = line === '' ? word : `${line} ${word}`
      if (displayWidth(cand) <= limit) { line = cand; continue }
      if (line !== '') { out.push(line); line = '' }
      // A SZÓ maga is hosszabb lehet a limitnél (URL, token): ilyenkor
      // kényszer-vágás CELLÁRA, addig, amíg elfogy. A clampCells garantálja,
      // hogy nem hasít félbe surrogate párt.
      let rest = word
      while (displayWidth(rest) > limit) {
        const head = clampCells(rest, limit)
        // Fail-safe a végtelen ciklus ellen: ha a limit olyan szűk, hogy még egy
        // codepoint sem fér bele (pl. 1 cella + egy 2 cellás emoji), akkor is
        // haladnunk KELL — egy codepointot kiadunk, túllógás árán. Ez az egyetlen
        // hely, ahol a túllógás megengedett, mert az alternatíva a lefagyás.
        const step = head === '' ? [...rest][0] : head
        out.push(step)
        rest = rest.slice(step.length)
      }
      line = rest
    }
    if (line !== '') out.push(line)
  }
  return out
}

// --- Index-léptetés (a nyilas választók KÖZÖS primitívje) -------------------
//
// MIÉRT A LAYOUTBAN: KETTŐ fogyasztója van egymástól független rétegben — a
// panel modál-választója ÉS az ai-review-config budget/modell léptetője. Ha a
// panelben laknék, a config FELFELÉ importálna, ami ciklus-veszély; a legalsó,
// nulla-importos rétegben viszont mindkettő lefelé hívja.
// (MÉRVE: a vágás közben a config `budgetStep`-je egy panelben maradt
// `stepIndex`-et hívott — ReferenceError HÍVÁSKOR, nem betöltéskor.)

/**
 * Index-léptetés körbejárással (wrap).
 *
 * A DÖNTÉS: KÖRBEJÁR, nem áll meg a szélen. Két út van; a "megáll a szélen" azt
 * jelentené, hogy a defaulton (index 0) a `←` DEAD KEY — a user megnyomja, semmi
 * nem történik, és nem tudja, hogy a gomb nem működik, vagy a UI fagyott le. A
 * wrap MINDIG ad látható visszajelzést, és két elemnél a `←`/`→` amúgy is
 * ugyanoda visz.
 *
 * A degenerált bemenet (üres lista, tartományon kívüli vagy negatív `current`)
 * NEM dob és NEM szivárog ki érvénytelen indexként: a hívó közvetlenül indexel
 * vele a `paths` tömbbe, és egy negatív vagy NaN index `undefined` utat adna —
 * a review-út némán elveszne (a reviewPathById ezt fail-closed elkapná, de a UI
 * addig hazug választást mutatna).
 */
export function stepIndex(current, length, delta) {
  const len = Number.isInteger(length) && length > 0 ? length : 1
  const d = Number.isInteger(delta) ? delta : 0
  // A `current`-et ELŐBB a tartományba normalizáljuk, és CSAK utána léptetünk.
  // Ha egyszerre tennénk (`(cur + d) % len`), egy tartományon kívüli current
  // MÁS eredményt adna, mint a normalizáltja: a -3 @ len=2 `-1` lépéssel 0-t ad,
  // a normalizált 1 viszont 0-t — a kettő csak véletlenül egyezik, len=3-nál
  // már nem. A hívó a paths tömbbe indexel ezzel, tehát a determinizmus itt
  // szerződés, nem szépségkérdés.
  const raw = Number.isInteger(current) ? current : 0
  const cur = ((raw % len) + len) % len
  return (((cur + d) % len) + len) % len
}

// --- SZÍN-INTERPOLÁCIÓ (a fade-átmenetekhez) ---------------------------------

/**
 * KÉT HEX SZÍN KÖZTI LINEÁRIS INTERPOLÁCIÓ, `t ∈ [0,1]`.
 *
 * (wf31/56) A tompítás-átmenet (`FADED_COLOR` ↔ éles) frame-enkénti színét adja.
 * TISZTA függvény, cellától és terminálótól független — ezért itt lakik, a
 * layout-modulban, ahol a többi mérték-számítás is: a render-oldal csak KÉRI a
 * színt, nem számol.
 *
 * A `t` KLAMPOLVA, és NEM dob: egy animációs ütemezőből érkező 1.02 vagy -0.001
 * (kerekítési maradék) nem viheti el a rendert egy kozmetikai érték miatt.
 *
 * A BEMENET `#rrggbb` VAGY `#rgb`; érvénytelen alakra a `to` végállapot jön
 * vissza — FAIL-SAFE a végállapot felé: egy elrontott szín-literál a legrosszabb
 * esetben ELHAGYJA az animációt, nem tesz olvashatatlanná egy sort.
 */
export function lerpHex(from, to, t) {
  const a = parseHex(from)
  const b = parseHex(to)
  if (a === null || b === null) return typeof to === 'string' ? to : '#000000'
  const x = Math.min(1, Math.max(0, Number(t)))
  if (!Number.isFinite(x)) return to
  const mix = (i) => Math.round(a[i] + (b[i] - a[i]) * x)
  return `#${[0, 1, 2].map((i) => mix(i).toString(16).padStart(2, '0')).join('')}`
}

/** `#rgb` / `#rrggbb` → `[r,g,b]`, vagy `null`. */
function parseHex(v) {
  if (typeof v !== 'string') return null
  const h = v.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(h)) {
    return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16))
  }
  if (/^[0-9a-fA-F]{6}$/.test(h)) {
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  }
  return null
}

/**
 * A FADE ÜTEMEZŐJE — melyik lépésnél tartunk, és kész van-e.
 *
 * A `step` 0-tól `steps`-ig megy; a `t` ebből SZÁMOLÓDIK, hogy a hívónak ne
 * kelljen osztania (a 0 lépésszám különben nullával osztana).
 *
 * MIÉRT KÜLÖN FÜGGVÉNY: az input-megszakítás (a user kérése: "input esetén az
 * animációkat végállapotba tenni") EGY hívás — `fadeDone(steps)` —, és így a
 * "végállapot" fogalma EGY helyen van definiálva, nem három hívónál külön.
 */
export function fadeProgress(step, steps) {
  const n = Math.max(1, Math.floor(Number(steps) || 1))
  const i = Math.min(n, Math.max(0, Math.floor(Number(step) || 0)))
  return { step: i, steps: n, t: i / n, done: i >= n }
}
