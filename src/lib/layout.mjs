// tuipr — LAYOUT: cell measurement and truncation.
//
// THE LOWEST LAYER: this module imports ZERO project modules, and never
// will — apart from cache, nearly every module calls it (displayWidth,
// clampCells), so any import pointing back up would IMMEDIATELY create a
// cycle. The cycle is a MEASURED, SILENT bug class in this project (exit 13,
// 0-byte output) — the reasoning is in bin/tui-core.mjs's header.
//
// Why CELL and not character: the terminal renders in cells, while `.length`
// counts UTF-16 code units. The mismatch between the two is the wrapping bug
// class the user reported FOUR TIMES (emoji, variation selectors,
// East-Asian-Wide glyphs).

// East-Asian-Width "Wide" (W) and "Fullwidth" (F) intervals — the terminal
// renders these on 2 cells. RANGE-based, NOT a codepoint whitelist: the
// earlier list (0x26a1/0x26d4/0x2753 + the 0x1f300–0x1faff emoji block)
// covered only TODAY's icon set, so ✅ U+2705 / ❌ U+274C / ⏳ U+23F3 (all
// EAW=W, MEASURED tmux advance = 2) would have silently measured as 1 — the
// title budget drifts, Ink wraps, the bash row overflows. The bug would only
// have struck when someone introduced such an icon; so the measurer now
// follows the rule, not the current set of icons.
//
// The table is narrowed down from the Unicode EastAsianWidth.txt W+F
// classes to what can actually occur in a terminal UI (CJK, Hangul, kana,
// the dingbat/misc-symbol Wide islands, and the emoji blocks).
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
 * A string's width as measured in terminal cells.
 *
 * The same trap as in the bash list view: a variation selector (U+FE0F)
 * itself occupies 0 cells, but raises the text-presentation base glyph
 * behind it to 2 cells (⚠️ = U+26A0 U+FE0F); the East-Asian-Wide glyphs
 * (⛔ U+26D4, ❓ U+2753, ⚡ U+26A1, 🚀 U+1F680) are already 2 to begin with. The
 * 1-cell glyphs: ASCII, accented Latin, and ● / ○ / ✔ / ✗ (EAW=Ambiguous or
 * Neutral). So `.length` (UTF-16 code unit) is unusable.
 *
 * The widths are MEASURED in a real terminal emulator (tmux, cursor-advance),
 * and test/next-tui.test.ts pins them against hand-computed constants — the
 * measurer can't cite itself as evidence.
 */
export function displayWidth(s) {
  const chars = [...String(s)]
  let total = 0
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0)
    if (cp === 0xfe0f) continue // variation selector: 0 cells
    // VS16 raises the text-presentation glyph to emoji presentation → 2 cells.
    const wide = chars[i + 1]?.codePointAt(0) === 0xfe0f || isWideCodePoint(cp)
    total += wide ? 2 : 1
  }
  return total
}

// The per-row fixed part: cursor(2) + "#" + number(5) + space + author(5) +

/**
 * Truncating a string to CELLS (not characters), codepoint-based.
 *
 * The same trap the user reported FOUR TIMES: `.slice` cuts UTF-16 code
 * units, so it can (a) split a surrogate pair in half (a garbled glyph on the
 * terminal), and (b) think emoji are 1 cell wide, so the cell-measured width
 * OVERFLOWS — Ink wraps, and the frame falls apart. Here displayWidth
 * accumulates codepoint by codepoint, and we stop the moment the limit is
 * REACHED.
 */
export function clampCells(s, cells) {
  const limit = Math.max(0, Math.floor(cells))
  if (limit === 0) return ''
  const chars = [...String(s)]
  let out = ''
  for (let i = 0; i < chars.length; i++) {
    // We get the INCREMENT by re-measuring the PREFIX, NOT via
    // `displayWidth(chars[i])`. MEASURED BUG (caught by my own test):
    // displayWidth handles VS16 by raising the PRECEDING glyph to 2 cells
    // (⚠️ = U+26A0 U+FE0F). Measured per codepoint, the pair comes out to
    // 1 + 0 = 1 cell instead of 2, so the truncated title OVERFLOWED in
    // cells (55 cells inside a 54-cell frame) — exactly the wrapping bug
    // class the user reported four times. Measuring the prefix keeps the
    // lookahead intact.
    const next = out + chars[i]
    if (displayWidth(next) > limit) return out
    out = next
  }
  return out
}

/**
 * Wrapping a text to a CELL width, returning an array of lines.
 *
 * WHY IN CORE AND NOT INK'S OWN WRAPPING: the error overlay's content is raw
 * `gh`/`git` stderr — multi-line, with long lines, sometimes a URL or token
 * with no spaces. If we left this to Ink's own wrapping, it would wrap the
 * framed Box's interior without OUR width computation, and the frame would
 * fall apart (exactly the bug class the user reported four times). Here the
 * measure is the same displayWidth the frame computes with too.
 *
 * The wrapping (a) preserves EXISTING line breaks (the stderr's structure is
 * information), (b) breaks on word boundaries, but (c) forcibly cuts a chunk
 * longer than a word — without this a URL would overflow.
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
      // The WORD itself can be longer than the limit too (a URL, a token):
      // in that case, forced cutting to CELLS, until it's used up. clampCells
      // guarantees that it won't split a surrogate pair.
      let rest = word
      while (displayWidth(rest) > limit) {
        const head = clampCells(rest, limit)
        // Fail-safe against an infinite loop: if the limit is so narrow that
        // not even one codepoint fits (e.g. 1 cell + a 2-cell emoji), we
        // still MUST make progress — emit one codepoint, at the cost of
        // overflowing. This is the ONE place where overflow is allowed,
        // because the alternative is hanging.
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

// --- Index stepping (the SHARED primitive of the arrow-key choosers) --------
//
// WHY IN LAYOUT: it has TWO consumers in mutually independent layers — the
// panel's modal chooser AND the ai-review-config budget/model stepper. If it
// lived in the panel, config would import UPWARD, a cycle risk; in the
// lowest, zero-import layer, though, both can call down into it.
// (MEASURED: mid-refactor, config's `budgetStep` called a `stepIndex` left
// behind in a panel — a ReferenceError AT CALL TIME, not load time.)

/**
 * Index stepping with wraparound.
 *
 * THE DECISION: IT WRAPS, it doesn't stop at the edge. There are two
 * options; "stop at the edge" would mean that at the default (index 0) `←`
 * is a DEAD KEY — the user presses it, nothing happens, and they don't know
 * if the button is broken or the UI froze. Wrapping ALWAYS gives visible
 * feedback, and with two elements `←`/`→` land on the same place anyway.
 *
 * A degenerate input (empty list, out-of-range or negative `current`) does
 * NOT throw and does NOT leak out as an invalid index: the caller indexes
 * directly into the `paths` array with it, and a negative or NaN index would
 * give an `undefined` path — the review path would SILENTLY vanish (fail-
 * closed `reviewPathById` would catch this, but until then the UI would show
 * a lying choice).
 */
export function stepIndex(current, length, delta) {
  const len = Number.isInteger(length) && length > 0 ? length : 1
  const d = Number.isInteger(delta) ? delta : 0
  // We FIRST normalize `current` into range, and ONLY THEN step. If we did
  // both at once (`(cur + d) % len`), an out-of-range current would give a
  // DIFFERENT result than its normalized form: -3 @ len=2 gives `-1` with a
  // step of 0, while the normalized 1 gives 0 — the two only coincide by
  // accident, and no longer at len=3. The caller indexes into the paths array
  // with this, so determinism here is a contract, not a nicety.
  const raw = Number.isInteger(current) ? current : 0
  const cur = ((raw % len) + len) % len
  return (((cur + d) % len) + len) % len
}

// --- COLOR INTERPOLATION (for the fade transitions) --------------------------

/**
 * LINEAR INTERPOLATION BETWEEN TWO HEX COLORS, `t ∈ [0,1]`.
 *
 * (wf31/56) Gives the per-frame color of the dimming transition (`FADED_COLOR`
 * ↔ full brightness). A PURE function, independent of cells and terminal —
 * that's why it lives here, in the layout module, alongside the other
 * measurement computations: the render side only ASKS for the color, it
 * doesn't compute it.
 *
 * `t` IS CLAMPED, and does NOT throw: a 1.02 or -0.001 (rounding remainder)
 * coming from an animation scheduler must not take down the render over a
 * cosmetic value.
 *
 * THE INPUT IS `#rrggbb` OR `#rgb`; on an invalid form, the `to` end state
 * comes back — FAIL-SAFE toward the end state: a broken color literal at
 * worst LEAVES the animation, it doesn't make a row unreadable.
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

/** `#rgb` / `#rrggbb` → `[r,g,b]`, or `null`. */
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
 * THE FADE SCHEDULER — which step we're at, and whether it's done.
 *
 * `step` runs from 0 to `steps`; `t` is COMPUTED from this, so the caller
 * doesn't have to divide (a step count of 0 would otherwise divide by zero).
 *
 * WHY A SEPARATE FUNCTION: the input-interrupt (the user's request: "on
 * input, put the animations into their end state") is ONE call —
 * `fadeDone(steps)` — so the concept of "end state" is defined in ONE place,
 * not separately at three call sites.
 */
export function fadeProgress(step, steps) {
  const n = Math.max(1, Math.floor(Number(steps) || 1))
  const i = Math.min(n, Math.max(0, Math.floor(Number(step) || 0)))
  return { step: i, steps: n, t: i / n, done: i >= n }
}
