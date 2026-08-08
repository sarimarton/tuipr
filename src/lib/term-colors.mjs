// A TERMINÁL VALÓDI SZÍNEINEK KIKÉRDEZÉSE — OSC 10 (előtérszín) + OSC 4 (paletta).
//
// (wf31/62) MIÉRT LÉTEZIK: a fade-tween kezdőpontjai eddig TALÁLGATOTT hexek
// voltak (a téma fehére, a nevesített színek közelítése), és a user két leletet
// is hozott a tévedésre: a fejléc jobb felső szövege fehérre villant, az
// "in queue" zöldje pedig nem egyezett a téma "árnyaltabb, zöldes-sárgás"
// zöldjével. A user kérdése: "ezeket nem lehetne runtime számolni?" — de igen:
// a terminálok az `OSC 10 ; ? BEL` és `OSC 4 ; <index> ; ? BEL` query-kre a
// TÉNYLEGES színükkel válaszolnak (`rgb:rrrr/gggg/bbbb` alakban).
//
// MIÉRT PONT INDÍTÁSKOR, ÉS MIÉRT CSAK AKKOR: a válasz a STDIN-en érkezik.
// Futó Ink mellett ez az input-úttal ütközne (a wf31/18-20 mérte ki, milyen
// törékeny az), ezért a kérdezés EGYSZER fut, a `render()` ELŐTT — amikor a
// stdin-en még senki nem olvas. A színek egy session alatt nem változnak
// (téma-váltásnál a TUI újraindítása elvárható), tehát az egyszeri mérés elég.
//
// FAIL-SAFE MINDEN ÁGON: nem-TTY, nem válaszoló terminál (timeout), csonka
// válasz → `null`, és a hívó a beépített közelítésekre esik vissza. A tween
// kezdőpontja KOZMETIKA — inkább legyen egy hajszállal pontatlan, mint hogy az
// indítás egy néma terminálon lógjon.

import fs from 'node:fs'
import process from 'node:process'
import tty from 'node:tty'

/** Az Ink-ben használt nevesített színek ANSI paletta-indexe (OSC 4-hez). */
const PALETTE_INDEX = {
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  // Az Ink `gray`-e a BRIGHT BLACK (8) — a chalk így képezi le.
  gray: 8,
  whiteBright: 15,
}

/**
 * Az OSC válasz-komponens (1/2/4 hex számjegy) → 8 bites csatorna.
 *
 * A terminálok tipikusan 16 bitet adnak (`ffff`), de a spec 8 és 4 bitet is
 * enged — a felső bájt/nibble skálázása mindhármat helyesen kezeli.
 */
function channelTo8bit(hex) {
  if (hex.length >= 2) return parseInt(hex.slice(0, 2), 16)
  const n = parseInt(hex, 16)
  return n * 16 + n
}

/**
 * A nyers stdin-pufferből kiszedi az OSC 10 / OSC 4 szín-válaszokat.
 *
 * TISZTA függvény (tesztelhető I/O nélkül). A terminátor BEL (`\\x07`) és ST
 * (`ESC \\`) is lehet — terminálonként eltér, a regex egyiket sem követeli meg:
 * a szín-törzs önmagában azonosítható.
 */
export function parseOscColorResponses(text) {
  const out = {}
  // A 11-es a DEFAULT HÁTTÉR (wf31/66) — a lebegő panel opacitásához: az Ink
  // cella-buffere csak oda ír, ahol karakter van, tehát a panel üres celláit a
  // TÉMA hátterével kell kitölteni, hogy a lista ne üssön át.
  // (Az ESC itt is escape, nem literal bájt — lásd az oscColorQueries indoklását.)
  const re = /\u001B\](10|11|4);(?:(\d+);)?rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/g
  for (const m of String(text).matchAll(re)) {
    const [, code, idx, r, g, b] = m
    const hex = `#${[r, g, b].map((c) => channelTo8bit(c).toString(16).padStart(2, '0')).join('')}`
    if (code === '10') {
      out.fg = hex
    } else if (code === '11') {
      out.bg = hex
    } else if (idx !== undefined) {
      const name = Object.keys(PALETTE_INDEX).find((k) => PALETTE_INDEX[k] === Number(idx))
      if (name) out[name] = hex
    }
  }
  return out
}

/** A kiküldendő query-sorozat: fg + a használt paletta-indexek. */
export function oscColorQueries() {
  // ESCAPE-EK, NEM LITERAL KONTROL-BÁJTOK: egy diff/editor a láthatatlan ESC-et
  // csendben elveszítheti, és a query attól még "működne" — csak épp semmit nem
  // kérdezne. Az escape látható és greppelhető.
  const parts = ['\u001B]10;?\u0007', '\u001B]11;?\u0007']
  for (const idx of Object.values(PALETTE_INDEX)) parts.push(`\u001B]4;${idx};?\u0007`)
  return parts.join('')
}

/** Hány választ várunk összesen (fg + bg + paletta) — a korai kilépéshez. */
const EXPECTED_KEYS = 2 + Object.keys(PALETTE_INDEX).length

/**
 * A terminál színeinek egyszeri kikérdezése. `null`, ha nem mérhető.
 *
 * (wf31/63) SAJÁT `/dev/tty` FD-RŐL OLVASUNK, NEM A `process.stdin`-RŐL — MÉRT
 * SAJÁT HIBA JAVÍTÁSA. Az első változat a stdin-t `resume()`-olta, és az app
 * INDULÁSKOR LEFAGYOTT (a user lelete). Az ok a projekt által már kimért
 * libuv-korlát (wf26/wf32, libuv#982): a `resume()` egy BLOKKOLÓ natív
 * `read()`-et indít az fd 0-n, amit a `pause()` NEM tud visszavonni — a függő
 * olvasás ott marad, és elviszi/blokkolja az inputot, amire az Ink-nek (a
 * `DelegatingStdin` targetjének) szüksége lenne.
 *
 * A MEGOLDÁS UGYANAZ A MINTA, AMIT A wf32 A HUNK-VÁLTÁSNÁL MÉRT KI: egy SAJÁT
 * fd-t nyitunk a `/dev/tty`-ra, és a végén a stream `destroy()`-a — ami az fd-t
 * ZÁRJA — a függő blokkoló olvasást is megszakítja. A `process.stdin`-hez így
 * hozzá sem érünk.
 *
 * A TIMEOUT-ÁG MARADÉK-KOCKÁZATA VÁLTOZATLAN (egy nagyon lassú terminál a
 * lezárás után válaszol, és a bájtok az Ink inputjába esnek) — részleges válasz
 * után ezért egy rövid csend-ablakot még kivárunk.
 */
export function queryTerminalColors({
  output = process.stdout,
  timeoutMs = Number(process.env.TUIPR_NEXT_TUI_COLOR_TIMEOUT_MS) || 80,
  // Tesztekhez injektálható stream-gyár; élesben a /dev/tty-t nyitja.
  openInput = () => {
    const fd = fs.openSync('/dev/tty', 'r')
    return new tty.ReadStream(fd)
  },
} = {}) {
  return new Promise((resolve) => {
    if (!output?.isTTY) {
      resolve(null)
      return
    }
    let input
    try {
      input = openInput()
    } catch {
      // Nincs vezérlő terminál (pl. detached processz) — nem mérhető.
      resolve(null)
      return
    }
    let buf = ''
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // (indulási-fagyás) HÁROM KÜLÖN try, NEM EGY KÖZÖS: egy élő fagyott
      // példány fd-táblája mutatta meg (lsof: a /dev/tty fd-k NYITVA maradtak,
      // 225 bájtnyi beolvasott válasszal), hogy a lezárás valamelyik korai
      // lépése dobhat — közös try-ban az a `destroy()`-t is elnyeli, és az
      // olvasó örökre ott marad a KÖZÖS terminál-eszközön. A destroy-nak
      // minden korábbi hibától függetlenül le kell futnia.
      try { input.removeListener('data', onData) } catch { /* lásd fent */ }
      // A RAW VISSZA, MAJD DESTROY: a destroy zárja az fd-t, ami a függő
      // blokkoló olvasást is megszakítja (a wf32-ben mért tulajdonság — a
      // `destroyOldTarget()` pontosan erre épül).
      try { input.setRawMode?.(false) } catch { /* lásd fent */ }
      try { input.destroy() } catch { /* a lezárás hibája nem ronthatja el az indítást */ }
      const parsed = parseOscColorResponses(buf)
      resolve(Object.keys(parsed).length > 0 ? parsed : null)
    }
    let timer = setTimeout(finish, timeoutMs)
    const onData = (chunk) => {
      buf += String(chunk)
      const got = Object.keys(parseOscColorResponses(buf)).length
      if (got >= EXPECTED_KEYS) {
        finish()
      } else if (got > 0) {
        // RÉSZLEGES válasz: a terminál beszél, csak lassan — a csend-ablak
        // újraindul, hogy a maradék ne az Ink inputjába folyjon.
        clearTimeout(timer)
        timer = setTimeout(finish, 40)
      }
    }
    try {
      // RAW MÓD: a válasz ne érjen el a sor-pufferig/echo-ig. A saját fd-nk
      // termios-a a KÖZÖS tty-eszközé, de az Ink indításkor úgyis raw-ra állítja
      // a sajátját — a finish-beli visszaállítás csak a köztes ablakot fedi.
      input.setRawMode?.(true)
      input.on('data', onData)
      output.write(oscColorQueries())
    } catch {
      finish()
    }
  })
}
