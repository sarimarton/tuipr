// QUERYING THE TERMINAL'S ACTUAL COLORS — OSC 10 (foreground) + OSC 4 (palette).
//
// (wf31/62) WHY THIS EXISTS: the fade-tween's starting points used to be
// GUESSED hex values (the theme's white, an approximation of the named
// colors), and the user brought two findings of the guess being wrong: the
// header's top-right text flashed white, and the "in queue" green didn't
// match the theme's "more nuanced, greenish-yellow" green. The user's
// question: "couldn't these be computed at runtime?" — and yes: terminals
// respond to the `OSC 10 ; ? BEL` and `OSC 4 ; <index> ; ? BEL` queries with
// their ACTUAL color (in `rgb:rrrr/gggg/bbbb` form).
//
// WHY EXACTLY AT STARTUP, AND ONLY THEN: the response arrives on STDIN. While
// Ink is running, this would collide with the input path (wf31/18-20 measured
// how fragile that is), so the query runs ONCE, BEFORE `render()` — when
// nobody is reading stdin yet. The colors don't change within a session
// (a theme switch is expected to restart the TUI), so the one-time
// measurement is enough.
//
// FAIL-SAFE ON EVERY BRANCH: non-TTY, a non-responding terminal (timeout),
// truncated response → `null`, and the caller falls back to the built-in
// approximations. The tween's starting point is COSMETIC — better to be a
// hair off than to have startup hang on a silent terminal.

import fs from 'node:fs'
import process from 'node:process'
import tty from 'node:tty'

/** The ANSI palette index (for OSC 4) of the named colors used in Ink. */
const PALETTE_INDEX = {
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  // Ink's `gray` is BRIGHT BLACK (8) — that's how chalk maps it.
  gray: 8,
  whiteBright: 15,
}

/**
 * An OSC response component (1/2/4 hex digits) → 8-bit channel.
 *
 * Terminals typically give 16 bits (`ffff`), but the spec also allows 8 and 4
 * bits — scaling the top byte/nibble handles all three correctly.
 */
function channelTo8bit(hex) {
  if (hex.length >= 2) return parseInt(hex.slice(0, 2), 16)
  const n = parseInt(hex, 16)
  return n * 16 + n
}

/**
 * Extracts the OSC 10 / OSC 4 color responses from the raw stdin buffer.
 *
 * A PURE function (testable without I/O). The terminator can be BEL (`\x07`)
 * or ST (`ESC \`) too — it varies by terminal, and the regex requires
 * neither: the color body alone is identifiable.
 */
export function parseOscColorResponses(text) {
  const out = {}
  // 11 is the DEFAULT BACKGROUND (wf31/66) — for the floating panel's
  // opacity: Ink's cell buffer only writes where there's a character, so the
  // panel's empty cells need to be filled with the THEME's background so the
  // list underneath doesn't show through.
  // (The ESC here is an escape too, not a literal byte — see the reasoning
  // for oscColorQueries.)
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

/** The sequence of queries to send: fg + the palette indexes in use. */
export function oscColorQueries() {
  // ESCAPES, NOT LITERAL CONTROL BYTES: a diff/editor can silently drop an
  // invisible ESC, and the query would still "work" — it just wouldn't
  // actually query anything. An escape is visible and greppable.
  const parts = ['\u001B]10;?\u0007', '\u001B]11;?\u0007']
  for (const idx of Object.values(PALETTE_INDEX)) parts.push(`\u001B]4;${idx};?\u0007`)
  return parts.join('')
}

/** How many responses we expect in total (fg + bg + palette) — for early exit. */
const EXPECTED_KEYS = 2 + Object.keys(PALETTE_INDEX).length

/**
 * A one-time query of the terminal's colors. `null` if it can't be measured.
 *
 * (wf31/63) WE READ FROM OUR OWN `/dev/tty` FD, NOT FROM `process.stdin` —
 * FIXING A MEASURED BUG OF OUR OWN. The first version called `resume()` on
 * stdin, and the app FROZE ON STARTUP (the user's finding). The cause is a
 * libuv limitation the project had already measured before (wf26/wf32,
 * libuv#982): `resume()` starts a BLOCKING native `read()` on fd 0, which
 * `pause()` CANNOT undo — the pending read stays there, and it takes over/
 * blocks the input that Ink (the `DelegatingStdin`'s target) needs.
 *
 * THE FIX IS THE SAME PATTERN wf32 MEASURED OUT FOR THE HUNK SWITCH: we open
 * OUR OWN fd onto `/dev/tty`, and at the end the stream's `destroy()` — which
 * CLOSES the fd — also interrupts the pending blocking read. We never even
 * touch `process.stdin` this way.
 *
 * THE TIMEOUT BRANCH'S RESIDUAL RISK IS UNCHANGED (a very slow terminal
 * responds after we've closed, and the bytes fall into Ink's input) — after a
 * partial response we therefore still wait out a short quiet window.
 */
export function queryTerminalColors({
  output = process.stdout,
  timeoutMs = Number(process.env.TUIPR_NEXT_TUI_COLOR_TIMEOUT_MS) || 80,
  // Injectable stream factory for tests; in production it opens /dev/tty.
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
      // No controlling terminal (e.g. a detached process) — not measurable.
      resolve(null)
      return
    }
    let buf = ''
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // (startup freeze) THREE SEPARATE trys, NOT ONE SHARED: a live frozen
      // instance's fd table showed (lsof: the /dev/tty fds stayed OPEN, with
      // 225 bytes of response already read) that some early step of the
      // teardown can throw — in a shared try that would swallow the
      // `destroy()` too, and the reader would stay stuck forever on the
      // SHARED terminal device. `destroy` must run regardless of any earlier
      // error.
      try { input.removeListener('data', onData) } catch { /* see above */ }
      // RAW MODE OFF FIRST, THEN DESTROY: destroy closes the fd, which also
      // interrupts the pending blocking read (the property measured in
      // wf32 — `destroyOldTarget()` relies on exactly this).
      try { input.setRawMode?.(false) } catch { /* see above */ }
      try { input.destroy() } catch { /* a teardown error must not break startup */ }
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
        // PARTIAL response: the terminal is talking, just slowly — restart
        // the quiet window so the rest doesn't flow into Ink's input.
        clearTimeout(timer)
        timer = setTimeout(finish, 40)
      }
    }
    try {
      // RAW MODE: the response shouldn't reach line buffering/echo. Our own
      // fd's termios belongs to the SHARED tty device, but Ink sets its own
      // to raw on startup anyway — the restore in finish only covers the
      // window in between.
      input.setRawMode?.(true)
      input.on('data', onData)
      output.write(oscColorQueries())
    } catch {
      finish()
    }
  })
}
