// THE REVIEW WORKSTATION'S RENDER LAYER: the queue row and the THREE overlay
// BODIES.
//
// WHY THIS CUT (the first module of phase (3)), AND WHY EXACTLY THIS
// BOUNDARY:
//
// This file holds the part of the TUI that renders FROM PROPS and closes
// over ZERO App state — MEASURED: the block's only module-level reference
// was its own `ERROR_BODY_MAX_LINES` constant, everything else came from the
// core's pure functions. No `useState`, no `useRef`, no setter in its
// closure, so the move is MECHANICAL: hook order (React's silent error
// class) is untouched, because there are no hooks here.
//
// THE THREE BODIES don't return an Ink tree, but ROW DESCRIPTORS
// (`{ text, color?, … }`) — the height clip (`clipBodyLines`) counts the
// DISPLAYED rows, and you can't read the wrapped line count back out of an
// already-assembled Ink tree. The descriptor → Ink conversion happens in ONE
// place (`renderLines`), AFTER the clip.
//
// WHAT DELIBERATELY DIDN'T MOVE HERE: the `useInput` handler and the action
// flows (`doAiReview`/`openReview`/`doMerge`/…). Those close over ~50 LIVE
// bindings (setters, refs, derived values); lifted into one module, each of
// those would become a field on a 50-field context object, which is no
// longer a move but a REDESIGN — and would create exactly the surface where
// a missing field silently gives `undefined`. See the report's rationale.

import { Box, Text as InkText } from 'ink'

// (wf31/39) EVERY `Text` DOESN'T WRAP — THIS IS THE REAL FIX FOR THE
// WRAP-FLICKER.
//
// THE MEASURED ROOT CAUSE (from ink 7.1.1's source): Ink's `resized` handler
// does NOT trigger a React render, it draws DIRECTLY:
//     calculateLayout(); dom.emitLayoutListeners(rootNode); onRender()
// `calculateLayout` sets the new terminal width on the ROOT yoga node, but
// the `Text` children's CONTENT is still the result of the PREVIOUS React
// render — so our `clampCells` clipped with the OLD, wider measure. Yoga
// then WRAPS the longer string inside the narrower root, and this wrap is
// what throws off Ink's erase calculation (the flicker).
//
// WHY THE IMMEDIATE CAP IN wf31/38 DIDN'T HELP: that updates on OUR render
// path, but the resize frame isn't built by our code — the React render only
// comes after the debounce.
//
// `wrap: 'truncate'` SOLVES IT AT THE YOGA LEVEL: `Text` NEVER wraps, it
// TRUNCATES instead. This is exactly the behavior the user observed in hunk
// ("Hunk somehow manages to avoid wrap flicker, just a temporary cap") —
// on narrowing, the content is truncated immediately, and the correct layout
// settles on the next render.
//
// WHY A WRAPPER, AND NOT A PROP IN 13 PLACES: a missed `Text` would SILENTLY
// bring the flicker back (a single wrapping line is enough), and the bug
// would only surface on a live resize. This way it's structurally impossible
// to forget.
//
// `wrap` CAN BE OVERRIDDEN: the caller's explicit `wrap` wins (the spread
// comes AFTER the default). Today no caller passes anything else — but if a
// wrapping block is ever needed (e.g. a long error text), it shouldn't
// require rewriting the wrapper.
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
 * Rendering a single queue row.
 *
 * `tailLevel` is listLayout's degradation level: on a narrow terminal the
 * status tail gradually drops off, so the row does NOT wrap. Wrapping isn't
 * a cosmetic issue — Ink pushes an overflowing row onto a new line, which
 * shifts the mark column into a different cell on every row (measured live:
 * 15/17/19 on a 60-column panel), making the list unreadable. The user
 * reported this THREE times.
 */
/**
 * THE DIMMED TEXT COLOR — UNDER AN OPEN OVERLAY / A SETTLED ROW.
 *
 * (wf31/55) The user's request: "dimmed letters under an open info panel
 * should be a bit more dimmed".
 *
 * WHY `dimColor` ISN'T ENOUGH: that's ANSI SGR 2, a SINGLE fixed level —
 * there's no "stronger dim". The dimmed segments also ALREADY lose their own
 * color (`color: faded ? undefined : …`), so they get the terminal's BASE
 * COLOR dimmed: on a light terminal theme this barely differs from an active
 * row.
 *
 * THE FIX IS AN EXPLICIT COLOR NEXT TO `dimColor`: the hex fixes the faded
 * level INDEPENDENTLY of the terminal theme, and `dim` adds one more step on
 * top of it. `#6b7280` deliberately belongs to the family of the highlight
 * background (`#3a4250`) — the same cool gray-blue axis, so the picture
 * doesn't split into two color worlds.
 *
 * THE THREE LEVELS, of which this is the MIDDLE one (in answer to the user's
 * question "is there a step between them?"):
 *
 *   1. base color + `dim`        — the ORIGINAL. The terminal's base text
 *                                dimmed; on a light theme barely differs
 *                                from an active row.
 *   2. `FADED_COLOR`, no dim     ← THIS IS WHAT WE HAVE NOW. The hex fixes
 *                                the level, independent of the terminal
 *                                theme.
 *   3. `FADED_COLOR` + `dim`   — the TWO STACKED. This was the first
 *                                attempt, and per the user it overshot:
 *                                `dim` takes the hex down to ~50% too
 *                                (≈ `#363940`), which is nearly unreadable.
 *
 * THE TUNING COMES DOWN TO ONE NUMBER: darker needed → `#5a6270`; lighter →
 * `#7d8694` or `#8a93a3`. TURNING `dim` BACK ON IS NOT fine-tuning, it's a
 * whole level jump — that's why it's excluded on faded segments.
 *
 * WHY NOT DARKER: a dimmed row stays as READABLE context (the user still
 * sees, next to the panel, which PRs are in the queue) — we're not trying to
 * hide it, just push it back. The user's own word was "a bit".
 */
export const FADED_COLOR = '#6b7280'

/**
 * THE HEX APPROXIMATION OF NAMED COLORS — ONLY FOR THE TWEEN'S STARTING
 * POINT.
 *
 * (wf31/61) The user's finding: "the green, yellow, cyan, red on the right
 * side flash white" — because the dimmed segment LOST its own color, and got
 * the fade color (starting from white) instead. The fix: every segment
 * tweens from ITS OWN color toward dim — which requires the hex value of the
 * named Ink colors.
 *
 * AN APPROXIMATION, AND THAT'S GOOD ENOUGH HERE: the terminal's real palette
 * can't be queried (the same limit as with the base color — an OSC query
 * into stdin). The cost of being wrong is small and local: only the given
 * segment's FIRST fade frame jitters by a hair, the END POINT (FADED_COLOR)
 * is exact, and the RESTING color is untouched (that still comes from the
 * theme — the map is only read in the faded state).
 *
 * The values are tuned to typical dark themes (the user's environment is one
 * too).
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
 * The tween's starting point for a segment color: a hex stays as is, a named
 * color gets resolved, an unknown one falls back to the theme's foreground
 * (or white).
 *
 * (wf31/62) `palette` is the RUNTIME MEASURED terminal palette (OSC 4/10,
 * see the head of `term-colors.mjs`) — if present, it WINS: per the user's
 * finding, the "in queue" green didn't match the built-in approximation
 * ("more nuanced, greenish-yellow"). `NAMED_COLOR_HEX` stays the fallback,
 * for terminals that don't respond.
 */
function fadeStartOf(color, palette) {
  if (typeof color === 'string' && color.startsWith('#')) return color
  return palette?.[color] ?? NAMED_COLOR_HEX[color] ?? palette?.fg ?? '#ffffff'
}

export function Row({
  row, selected, titleWidth, tailLevel, dimmed = false, columns = 0, terminalColumns = 0,
  // (wf31/61) THE FADE PROGRESS (0..1) COMES FROM THE CALLER — not a
  // finished color, but `t`, because the tween runs from a DIFFERENT
  // starting point per segment (the green tweens from green, the white from
  // white — the user's finding about colors flashing white). The default is
  // 1 (end state): whoever doesn't know about the fade gets the finished,
  // settled dim — byte-for-byte the wf31/55 picture.
  fadeT = 1,
  // (wf31/62) The RUNTIME MEASURED terminal palette (or null) — the tween's
  // starting points come from this, so the colors start from the THEME's
  // color, not from an approximation.
  fadePalette = null,
}) {
  const cursor = selected ? '❯ ' : '  '
  // THE INDENT IS STEPPED: 2*indentDepth cells (the TRANSITIVE depth from
  // the model). Previously it was binary, 2 for every stacked row, so in an
  // A→B→C chain C landed in the same place as B — the hierarchy disappeared
  // from the picture.
  //
  // The `?? (indent ? 1 : 0)` fallback keeps the old row shape alive (the
  // listLayout uses the same fallback — the two MUST match, otherwise the
  // mark column drifts).
  const depth = typeof row.indentDepth === 'number' ? row.indentDepth : row.indent ? 1 : 0
  // (1b) The INDENT PREFIX comes from the core's SHARED function
  // (`stackIndent`), it isn't built here: the title budget (`listLayout`)
  // uses the SAME measure, and two calculations on the same concept are
  // guaranteed to drift — this is the project's MEASURED error class (the
  // `floor` was hardcoded to 3 while the renderer computed 2*depth, and the
  // row silently overran at 56/57 columns).
  //
  // The STEPPED marker is the user's literal request (`#911` / `╰─#933`),
  // and the WIDTH IS UNCHANGED: the `╰─` is 2 CELLS (MEASURED), so it
  // occupies the last two cells of the indent, it doesn't add to it. That's
  // why the mark column doesn't drift.
  const indentPrefix = stackIndent(depth)
  const indentCells = displayWidth(indentPrefix)
  // The title is truncated/padded to the budget; an indented row gets a
  // title column shortened by the cells its indent used — so the mark
  // column starts in the SAME cell at EVERY level (the same rule as in the
  // list view).
  const tw = Math.max(1, titleWidth - indentCells)
  const showRmark = tailLevel < 2 && row.rmark
  const showFlags = tailLevel < 1
  // OVERLAY OPEN: the list stays rendered, DIMMED. This is the point of the
  // refactor — the earlier full-screen swap took away context (the user
  // couldn't see which PR the dialog was about). The dimming says at once
  // that the list is STILL THERE, and that the focus is NOT on it: dropping
  // the colors and dimColor together.
  //
  // THE SELECTED ROW IS THE EXCEPTION THOUGH (user request, verbatim): "when
  // I open an item, that row on the main list could stay in its original
  // coloring instead of dimmed, since that's a highlighted row".
  //
  // WHY THE EXCEPTION IS JUSTIFIED: the dimming's MESSAGE is "this isn't the
  // focus". The cursor's row, though, IS EXACTLY the subject of the focus —
  // the panel is ABOUT that PR, and its position (the panel opens directly
  // below it) says the same. Dimming the WHOLE list also degraded the
  // cursor's row to "incidental", so the picture lost the anchor the panel
  // belongs to.
  //
  // THE DIMMING DOESN'T DISAPPEAR, only its scope narrows to the
  // NON-selected rows: the contrast (one sharp row among many dim ones) is a
  // STRONGER context signal than uniform dimness was.
  // (wf31/25) A SETTLED (merged) ROW IS ALSO DIMMED — the RESULT of OUR OWN
  // optimistic action (see the `merged` branch of MARKS in `rows.mjs`). The
  // user's request: "let it show as merged and dim it".
  //
  // THE TWO ARE DIFFERENT CONCEPTS, hence two separate sources:
  //   · `dimmed` — the OVERLAY is open, so the list isn't the focus (the
  //     cursor's row is the EXCEPTION, because the panel is about it);
  //   · `settled` — the row's FATE is decided (we merged it). This is about
  //     the row, not the focus, so it applies to the cursor too: a selected,
  //     merged row is also shown quietly — highlighting it would suggest
  //     there's still something to do with it.
  const faded = (dimmed && !selected) || row.settled === true
  const dim = faded || undefined
  // THE ROW'S OWN TWEEN POSITION. A `settled` (merged) row is PINNED to the
  // END STATE: it was already dim BEFORE the panel opened — if it got the
  // global `fadeT`, IT would also flash up to its starting color when the
  // panel opens, even though nothing happened to it. (This error class was
  // already present in wf31/56, it just wasn't visible without a settled
  // row.)
  const rowT = row.settled === true ? 1 : fadeT
  // THE DIMMED SEGMENT TWEENS FROM ITS OWN COLOR toward dim (wf31/61) — green
  // from green, colorless from white. The `dim` attribute drops out while
  // fading: the colored tween is itself already the dimming, `dim` on top of
  // it would overshoot by one level.
  const fadePaint = (seg) => lerpHex(fadeStartOf(seg.color, fadePalette), FADED_COLOR, rowT)
  // THE TITLE IS TRUNCATED/PADDED IN CELLS. `.slice` cuts UTF-16 code units:
  // emoji in the title OVERRAN in cells (the mark column drifted row by
  // row), and padEnd padded by the wrong measure too. clampCells + a
  // cell-based pad use the same measure the listLayout uses for the budget
  // calculation.
  const clipped = clampCells(row.title, tw)
  const title = clipped + ' '.repeat(Math.max(0, tw - displayWidth(clipped)))
  // (wf31/26) THE SELECTED ROW GETS A BACKGROUND COLOR — the user's finding:
  // "the highlight character »❯ « can't be used to track the selected row
  // properly, the monitor is too wide."
  //
  // WHY THE BACKGROUND, AND NOT A SECOND ARROW ON THE RIGHT EDGE (the user
  // left it to me): an arrow pair only marks the TWO ENDS of the row — on a
  // 190-cell monitor exactly the MIDDLE stays unmarked, where the title and
  // the marks are, so the eye would keep "jumping" between the two anchors.
  // The background CARRIES the marking all the way through: wherever you
  // look at the row, it shows that it's the selected one.
  //
  // THE COLOR IS `#3a4250` — A DARK, BLUE-LEANING GRAY.
  //
  // The user's TWO refinements led here:
  //   1) "let's assume the background is dark […] the letters are light. So
  //      on a light background the letters won't show. Minimal contrast" —
  //      hence not `blue`/`white`, but a dark, low-contrast background;
  //   2) "make it one shade lighter, and go toward gray, because the current
  //      one is some ugly brownish color" — `#2a2a2a` was too dark (barely
  //      visible), and looked warmer than intended on most terminal
  //      renderers.
  //
  // THE THIRD ITERATION (the user: "go toward blue because it's still
  // brownish, and it can be a bit lighter still"): `#3a4250` — the BLUE
  // channel is the strongest (0x50 > 0x42 > 0x3a), so by hue definition it
  // sits in the blue-gray range, it CAN'T drift toward warm (brownish).
  // Lightness rose too: luma is ~0x42, up from the earlier 0x3a.
  //
  // WHY IT TOOK THREE ROUNDS: `#2a2a2a`/`#3a3a3a` was a NEUTRAL gray
  // (R=G=B), but with terminal gamma handling and font anti-aliasing it
  // looked warmer than the computed value. An EXPLICIT blue shift absorbs
  // this rendering distortion too.
  //
  // WHY NOT THE NAMED ANSI COLORS: `blue`/`cyan`/`white` are members of the
  // terminal's 16-color palette, which themes can set to LIGHT too — `blue`
  // is light enough in most dark themes that the light foreground colors
  // blend into it (this was the finding). The hex value, on the other hand,
  // runs on the TRUE COLOR channel, so the theme doesn't rewrite it: `#2a2a2a`
  // on a typical dark terminal background (`#1e1e1e`…`#000`) is ONE SHADE
  // lighter, enough to mark the row, while leaving the light foreground
  // colors (the green/yellow/red mark, the magenta author) untouched.
  //
  // FALLBACK: on a 256-color or 16-color terminal, chalk quantizes to the
  // nearest palette member — that's a dark gray/black, so the behavior there
  // is also "slightly lighter background", not washed-out text.
  //
  // NEEDED ON EVERY SEGMENT: Ink applies `backgroundColor` per Text, so a
  // skipped segment would leave a HOLE in the highlight. That's why a shared
  // `bg` object is spread everywhere — so adding a new segment later makes
  // the mistake OBVIOUS (the hole shows), not silent.
  //
  // A SETTLED (merged) ROW GETS NO BACKGROUND even when selected: there the
  // intent is `faded` (its fate is decided), and a highlighted-yet-quiet row
  // would contradict itself.
  const bg = selected && !faded ? { backgroundColor: '#3a4250' } : {}
  // (wf31/29) THE ROW'S SEGMENTS BUILT INTO A LIST FIRST, THEN CLIPPED TO
  // CELLS — THIS IS THE REAL FIX FOR THE RESIZE GLITCH.
  //
  // THE MEASURED MECHANISM (from the user's pasted screenshot: the header
  // gets written repeatedly into the same row, rows run into each other):
  // Ink's `log-update` erases the PREVIOUS frame's LINE COUNT
  // (`eraseLines(previousLineCount)`), and it knows this count from its OWN
  // layout. But if a written row is WIDER than the terminal, the terminal
  // WRAPS it — the screen ends up with MORE physical lines than Ink counted.
  // The erase then UNDERSHOOTS, and the remainder stays stuck. Ink's
  // `resized` handler only clears the full screen on NARROWING
  // (`currentWidth < lastTerminalWidth`), not on widening — which is why it
  // fell apart in both directions.
  //
  // WHY `layout.width` (wf31/27-28) WASN'T ENOUGH: that's the table width
  // computed FROM THE CONTENT, which tends to be NARROWER than the terminal
  // — but DURING a resize the React state and the real terminal size DIFFER
  // (Ink's `useWindowSize` lags by one tick). In that gap the row is built
  // with the STILL OLD, wider measure, while the terminal is ALREADY
  // narrower.
  //
  // SO THE FAIL-SAFE BELONGS IN THE RENDERER, not the layout: whatever the
  // layout gives, the WRITTEN row must NEVER be wider than the terminal. The
  // clip runs IN CELLS (`clampCells`), so it won't cut an emoji mark
  // (⚠️/⛔/⬆️, 2 cells) in half either.
  const segs = [
    { text: cursor, color: selected ? 'cyan' : undefined },
    { text: indentPrefix, dimOverride: dim || !row.selectable },
    { text: `#${String(row.number).padEnd(5)} `, bold: selected },
    { text: `${String(row.author).slice(0, 5).padEnd(5)} `, color: 'magenta' },
    { text: `${title} ` },
    { text: row.mark.label, color: row.mark.color },
    // (wf31/52) THE CONFLICT-AXIS INDICATORS NEXT TO THE MARK, BEFORE THE
    // RMARK.
    //
    // The user's finding: `⚠️ conflict · ○ approve waiting (source?)` —
    // "where »source?« refers to the conflict". The old order (mark → rmark
    // → ALL flags) carried what talks about the mark past the approve
    // column, and the eye read it that way too: as if the approval were
    // waiting on the source.
    //
    // THE GROUPING COMES FROM DATA (`axis: 'mark'`, see the head of
    // `flagsFor`), not from the renderer's guesswork — so the list and the
    // bash view state the same grouping for the same fact, and a new
    // indicator's PLACE is decided in its own definition, not here.
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
    // THE REST OF THE INDICATORS (stack axis, meta: review trace, cache
    // status, spinner) stay at the row's END: the tail degradation drops
    // these first, and that's deliberate — metadata shouldn't push right the
    // thing the user reads the row for.
    ...(showFlags
      ? row.flags
          .filter((f) => f.axis !== 'mark')
          .map((f) => ({ text: ` ${f.label}`, color: f.color }))
      : []),
  ]
  // THE HIGHLIGHT BACKGROUND GOES TO THE END OF THE ROW (`columns` is the
  // TABLE's width — see the call site). Only on the selected row, and only
  // if there's room left.
  const used = segs.reduce((n, seg) => n + displayWidth(seg.text), 0)
  if (Object.keys(bg).length > 0 && columns > used) {
    segs.push({ text: ' '.repeat(columns - used) })
  }
  // THE HARD CEILING: the terminal's ACTUAL width. `columns` describes the
  // table (which can be narrower), `terminalColumns` is the physical limit —
  // the SMALLER of the two wins, and `clampCells` consumes the budget
  // segment by segment.
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
      // THE FADED COLOR ONLY WHERE THERE'S NO OWN ONE: the dimmed segments
      // already get an `undefined` color from the caller
      // (`faded ? undefined : …`), so this `??` hits exactly the ones we
      // want to dim — it does NOT overwrite the semantic colors of the
      // active rows (green approved, red conflict).
      //
      // AND WHERE THE COLOR DIMS, `dim` DROPS OUT (`fadedByColor`): the two
      // STACKED are a whole level too dark (see the three steps at the head
      // of `FADED_COLOR`). A `dimOverride: true` segment (e.g. the ` · `
      // separator) stays dim regardless — that's an EXPLICIT intent, not a
      // side effect of fading.
      // THE RESTING COLOR IS THE THEME'S (`undefined` = the terminal's base
      // color) — NEVER ours (wf31/59: a `baseColor` overwriting the theme
      // was a measured bug). While fading, though, EVERY segment tweens from
      // its own color (wf31/61) — the named colors too, hence not
      // `seg.color ?? …`, but a full swap under faded.
      color: faded ? fadePaint(seg) : seg.color,
      bold: seg.bold,
      dimColor: seg.dimOverride ?? (faded ? undefined : dim),
    }, text))
  }
  return h(Box, null, ...out)
}

  // THE UNIFIED INFO PANEL ('i'). TWO BANDS, split by COST:
  //
  //   FAST (top): what the queue model ALREADY knows — dep intersection,
  //     mergeMethod, landing blockers, stacked info. Zero wait, always
  //     complete.
  //   MEASURED (bottom): the result of the merge-tree probes. While running,
  //     a LIVE status row ("measuring: 3/7 candidates…"); when done, it
  //     settles in. Esc: abort.
  //
  // The bands DON'T MIX: while measuring (and after an abort) the measured
  // statements are NOT written. An interrupted probe sequence proves neither
  // a conflict nor its absence — the "✓ main: no conflict (measured)" row
  // would be a LIE there.
//
// THE PANEL IS NOW AN OVERLAY, not a full screen: the list stays rendered,
// DIMMED, underneath. The title and footer belong to the overlay FRAME
// (core: overlayFrame) — the body only supplies content, so title/footer
// come from ONE source for every overlay, and can't drift apart panel by
// panel (this was the old bug class for keybinding references).
// THE THREE BODIES (info / confirm / error) don't return an Ink tree, but
// ROW DESCRIPTORS: `{ text, color?, dimColor?, bold?, key? }`.
//
// WHY (a MEASURED bug, from a live render): the panel must be clippable BY
// HEIGHT (the `panelViewport` + `clipBodyLines` contract), and the DISPLAYED
// row count requires MEASURING the text — you can't read the wrapped line
// count back out of an already-assembled Ink tree. The first version lied
// for exactly this reason: the view STATED that "the panel is truncated",
// but the body rendered in full, and on a 12-line terminal the HEADER
// scrolled off.
//
// === THE MEASUREMENT CAVEAT FOOTNOTE — the Verdict block's progressive
// disclosure ==
//
// THE USER'S REPORT: the 3-4 line explanation under `Verdict: clean` is
// LITERALLY THE SAME on EVERY non-blocking PR, so it produces warning
// fatigue (by the fourth PR the user no longer even reads it). They asked
// for a footnote: a marker + "more info", expanding on a keypress.
//
// THE MARKER IS `…`, AND THAT'S NOT ARBITRARY: this is the project's
// EXISTING "there's more" idiom — the dep file list (`… +N more`), the error
// body (`… and N more lines`), the panel truncation and the AI-verdict
// truncation all use it. A fifth, competing marker (`*`) would open a new
// vocabulary for the same concept.
//
// THE AFFORDANCE IS ON THE ROW, NOT IN THE FOOTER: the footer is already 7
// segments, and at 100 columns it sits at `clampCells`'s limit — an eighth
// segment there would cut off something ELSE. The on-row indicator is
// stronger anyway — it's where the content is.
//
// WHAT STAYS EVEN WHEN CLOSED (a commitment): `git rebase` is the ONE place
// in the WHOLE UI where this warning is stated, and it stands on a MEASURED
// fact (the merge-tree simulates a MERGE, CI does a REBASE — measured on a
// fixture: merge-tree exit 0, git rebase CONFLICT). The closed row therefore
// carries the ACTIONABLE core ("the measurement simulates a MERGE, CI does a
// REBASE"), and only hides the elaboration and the command.
//
// IN THE OPEN FORM THE POINT SITS AT THE START OF THE BLOCK: on a narrow
// terminal the height clip (`clipBodyLines`) takes away the END, so the core
// of the caveat can't land at the bottom of the block.

// (wf31/10) THE MEASUREMENT ROWS ALSO GO BEHIND THE TOGGLE — BUT ONLY ON THE
// `clean` BRANCH.
//
// THE USER'S FINDING, verbatim: "Those two checkmark rows still bother me.
// […] They state a negative fact. Why aren't they behind the »Verdict:
// clean« collapse?"
//
// THE MEASURED REDUNDANCY on the clean panel is THREE rows, ONE statement:
//     ✓ main: no conflict (measured) — your landing isn't at risk
//     ✓ within next: no clash (4 candidates measured)
//     Verdict: clean
// The `clean` verdict, BY DEFINITION, means neither axis has a conflict (see
// the bash `$verdict` derivation: `mainConflict` → main-conflict,
// `queueConflicts` → next-only-conflict, CLEAN otherwise). The two checkmark
// rows are therefore the verdict's ELABORATION, not new information —
// exactly what wf31/4 already did with the fourth (summary) row. Same
// concept, same place.
//
// WHY ONLY ON THE `clean` BRANCH: on the NEGATIVE branches, the row IS the
// news. `✗ main: REAL conflict — <files>` also carries the file names (which
// the verdict doesn't), and under `⚠ within next: clashes` sit the culprit
// file rows. There, hiding it would take the most important information
// behind the toggle — so the rule isn't "the measurement rows are hidden",
// it's "the REDUNDANCY is hidden".

// (wf31/30) THE CLOSED/OPEN TOGGLE REMOVED — THERE ARE TWO STATES, NOT
// THREE.
//
// THE USER'S DECISION, verbatim: "in the info panel there are three states
// for the detailed info about main: idle (no info, offers c), verdict
// collapsed, and verdict expanded. And Enter is taken here. This isn't
// right. There should be TWO states. Idle and loaded details. That frees up
// Enter for the info toggle."
//
// WHAT'S GONE: the `caveatOpen` state, the `…` affordance row
// (`CAVEAT_HINT`), the condensed core (`CAVEAT_GIST`) and the degrading
// `caveatClosedLine`. The caveat NOW ALWAYS shows in its expanded form, if
// there's any measurement at all.
//
// WHY WE DON'T LOSE ANYTHING: the toggle was born in wf31/4 so that the
// SAME 3-4 line explanation on EVERY PR wouldn't produce warning fatigue.
// Since then, though, the measurement itself became an EXPLICIT gesture
// (`c`, wf31/10): the caveat ONLY appears if the user REQUESTED the
// measurement — so there's nothing to read on "every PR" anymore. The
// fatigue argument fell away, the toggle's cost (a taken key + a third
// state) remained.
//
// ENTER IS THEREFORE FREED UP for closing the panel (see the app's
// `key.return` branch).

/**
 * The caveat footnote's ROW DESCRIPTORS — the EXPANDED block.
 *
 * `caveat` is `conflictAdvice`'s SEPARATE field (`{ text, command, detail }`
 * or `null`). The `null` branch gives an EMPTY list, not an empty row: with
 * no caveat (a stacked PR, a main conflict, an unmeasured row) there's
 * nothing to expand.
 *
 * @param {Array} hidden (wf31/10) The FINISHED row descriptors that land at
 *   the START of the block — the `clean` branch's two measurement rows. WHY
 *   A PARAMETER, and why not appended into the `detail` string: these are
 *   COLORED, GLYPHED rows (`✓` + green/dim), while `detail` is a single,
 *   dimmed PROSE block that `wrapCells` wraps. Appended into one string they
 *   would lose their color, and their line breaks would slide into the
 *   prose wrapping — the `✓ main: …` and the `✓ within next: …` would melt
 *   into one paragraph.
 */
function caveatLines(caveat, innerWidth, hidden = []) {
  if (!caveat) return []
  // The PROSE wrapped to the frame's inner width — with the core's
  // wrapCells, with the SAME measure the frame itself uses (not Ink's own
  // wrapping, which would blow the frame apart). Continuation lines indented
  // by 2 cells, so the block reads as one piece.
  //
  // THE INDENT IS FACTORED INTO THE WRAP MEASURE, not added afterward — a
  // MEASURED BUG (a live 56-column render): adding the indent AFTER
  // `wrapCells` made the continuation line overrun IN CELLS (61 cells in a
  // 60-cell frame), Ink re-wrapped it, and a single word landed on its own
  // line. The frame didn't fall apart, but `clipBodyLines`'s MEASUREMENT and
  // reality drifted apart — and the height clip counts DISPLAYED rows, so an
  // Ink re-wrap renders more rows than we measured (the measured class
  // behind the header scrolling off).
  //
  // THE SAME PRINCIPLE as between `Row`'s indent prefix and `listLayout`'s
  // title budget: ONE measure, and the indent comes out of the budget, it
  // isn't added onto the row's end.
  const CAVEAT_INDENT = '  '
  const proseRoom = Math.max(1, innerWidth - displayWidth(CAVEAT_INDENT))
  // (wf31/32) AN EMPTY `text` DOESN'T PRODUCE A ROW. On the `nextFrom: 'ci'`
  // branch there's no caveat (CI's actual rebase went through, not our merge
  // simulation), so the caveat only carries `detail`. From an empty prose,
  // the naive `⚠ ${text}` would give a lone `⚠` — a warning with no content,
  // which is the worst case: the eye jumps to it, and there's nothing to
  // read.
  const caveatText = String(caveat.text ?? '').trim()
  const prose = caveatText === '' ? [] : wrapCells(`⚠ ${caveatText}`, proseRoom)
  // (wf31/4) THE MEASUREMENT RESULT (`detail`) IS THE OPEN BLOCK'S FIRST
  // PARAGRAPH.
  //
  // The user's finding: the "The merge-tree probe found NO conflict (N
  // candidates measured)…" sentence under `Verdict: clean` said the same
  // thing as the Verdict AND the two measurement rows above it —
  // "a detail to hide". The sentence therefore moved here, behind the
  // EXISTING Enter toggle: closed, only `Verdict: clean` + the one-line `…`
  // affordance show, open, the measured fact also comes forward.
  //
  // HIDING ISN'T DELETING: the candidate count states the MEASUREMENT'S
  // SCOPE, which is an attestation fact — `detail` preserves it.
  //
  // WHY AT THE START OF THE BLOCK, AND NOT AFTER THE CAVEAT PROSE: `detail`
  // is the MEASURED FACT, `text` is the RESERVATION about it — the fact
  // comes before the reservation attached to it. This also orders the
  // height clip correctly: `clipBodyLines` takes away the block's END, so
  // the most important part can't land at the bottom (the same principle
  // stated at the head of this section).
  //
  // DIMMED, NOT YELLOW: this is NOT a warning, but a measured, favorable
  // result — yellow belongs to the caveat (the actual reservation). Color
  // inflation here is the same error class this module calls out for the
  // Verdict block's green.
  const detailLines = String(caveat.detail ?? '').trim() === ''
    ? []
    : wrapCells(String(caveat.detail), proseRoom).map((line, i) => ({
        key: `cav-d-${i}`,
        dimColor: true,
        text: i === 0 ? line : `${CAVEAT_INDENT}${line}`,
      }))
  return [
    // (wf31/10) THE MEASUREMENT ROWS COME FIRST: these are the MEASURED
    // FACTS, `detail` is their summary, and `prose` is the reservation about
    // them — the order goes from the concrete to the general. The
    // block-end clip (`clipBodyLines`) thus takes away the least important
    // part first, which is this section's stated principle.
    ...hidden,
    ...detailLines,
    ...prose.map((line, i) => ({
      key: `cav-${i}`,
      color: 'yellow',
      text: i === 0 ? line : `${CAVEAT_INDENT}${line}`,
    })),
    // THE COMMAND IN CYAN, on its own line: the panel writes every
    // executable command this way (the stacking suggestion and the branch
    // name are cyan too). The indent is the typography for "a command you'd
    // type".
    //
    // (wf31/32) EMPTY COMMAND → NO ROW: on the `nextFrom: 'ci'` branch
    // there's nothing to do (the PR already landed), so an empty, indented
    // cyan row would only take up HEIGHT in the render tree — the same error
    // class the wf28/3 gap row called out.
    ...(String(caveat.command ?? '').trim() === ''
      ? []
      : [{ key: 'cav-cmd', color: 'cyan', text: clampCells(`    ${caveat.command}`, innerWidth) }]),
    // (wf31/30) THE CLOSING AFFORDANCE ROW REMOVED along with the toggle:
    // there's nothing to collapse, so a `… Enter: collapse` row would
    // announce a DEAD KEY (Enter now closes the PANEL).
  ]
}

// THE DESCRIPTOR → Ink conversion happens in ONE place (renderLines), AFTER
// the clip.
//
// (wf31/30) THE `caveatOpen` PARAMETER REMOVED: the caveat ALWAYS shows
// expanded (two states: no measurement / measurement present). The rationale
// is at the head of `caveatLines`.
export function infoBody(info, innerWidth = 100, reviewLines = []) {
  const model = buildInfoModel(info)
  const { row, fast, slow } = model
  const dep = fast.dep
  // (wf31/10) THE MEASURED BAND'S TWO AXIS ROWS — assembled in ONE place,
  // because it's needed in TWO places: on a `clean` verdict, BEHIND the
  // caveat toggle (`hidden`), otherwise in the visible part. Written in two
  // copies it would produce exactly the drift this module bans elsewhere too
  // (a test ties these sentences to MATCH the bash report — written in two
  // places, one copy would fall behind on fixes).
  //
  // The `slow.state !== 'done'` branches are EMPTY: there's no measured
  // diagnosis, so there's nothing to put in the list (the `measuring`/
  // `aborted`/`error` branches supply THEIR OWN rows).
  //
  // THE QUEUE AXIS ROW PAIR — GLYPH = CATEGORY, COLOR = WEIGHT.
  //
  // THE USER'S REPORT: the main branch was green+checkmarked, the queue
  // branch was checkmark-less and gray — this suggested an INCONSISTENT
  // WEIGHT, even though both are equally measured facts from the same probe
  // sequence.
  //
  // THE FIX HAS TWO PARTS:
  //   (1) the `✓` also appears on the positive queue axis (the glyph states
  //       the CATEGORY: "we measured it, and it's fine");
  //   (2) BUT the row STAYS DIM, it doesn't turn green. WHY NOT GREEN: green
  //       belongs to the MAIN axis — that's what decides whether the landing
  //       is at risk. If the queue axis also got green, green would
  //       INFLATE, and the main axis's measured PRECEDENCE would blur (the
  //       reverse error, from the same family).
  //
  // THE SENTENCE STRUCTURE IS PARALLEL: ONE subject ("within next"), TWO
  // predicates ("no clash" / "clashes"). The old pair named two SEPARATE
  // concepts ("intra-queue clash" vs. "within next"), which kept the two
  // rows from even reading as two states of one axis.
  //
  // The ⚠ (text presentation, 1 cell) INSTEAD OF the emoji ⚠️ (2 cells) —
  // MEASURED in a real terminal (tmux cursor_x: 2 vs. 1), and `displayWidth`
  // counts BOTH correctly (due to the VS16 lookahead), so the switch does
  // NOT affect the cell arithmetic; the row also got 3 cells shorter. The
  // text form was already PRECEDENT in the codebase anyway: the caveat rows
  // (ai-review-view) and the row flags (rows) write it this way too.
  //
  // THE CULPRIT FILE ROWS ARE CYAN, like the dep file list: same concept
  // (affected files), hence the same color — without color the two file
  // lists would look like two separate things.
  const measurementLines = slow.state !== 'done' ? [] : [
    slow.diag.mainConflict
      ? { key: 'mt-main', color: 'red', text: `✗ main: REAL conflict — ${slow.diag.mainConflictFiles.join(', ')}` }
      : { key: 'mt-main', color: 'green', text: '✓ main: no conflict (measured) — your landing is not at risk' },
    ...(slow.diag.queueConflicts.length > 0
      ? [
          { key: 'mt-q', color: 'yellow', text: `⚠ within next: clashes (${slow.diag.probed} candidates measured)` },
          ...slow.diag.queueConflicts.map((c) =>
            ({ key: `cul-${c.number}`, color: 'cyan', text: `    #${c.number}  ${c.files.join(', ')}` })),
        ]
      // (wf31/32) THE ROW STATES HOW WE KNOW — from the `nextFrom` field, not
      // from the `probed` count. `0 candidates measured` would be a LIE on
      // the `ci` branch: there we didn't measure, we know it from next's
      // graph (CI's cumulative rebase went through). `probed: 0` also arises
      // TWO DIFFERENT WAYS ("we skipped it" / "no candidates"), so it
      // couldn't be inferred from either.
      : slow.diag.nextFrom === 'ci'
      ? [{ key: 'mt-q', dimColor: true, text: '✓ next: landed (CI\'s cumulative rebase went through)' }]
      : [{ key: 'mt-q', dimColor: true, text: `✓ within next: no clash (${slow.diag.probed} candidates measured)` }]),
  ]
  // THE `clean` VERDICT IS THE HIDING GATE — from the MEASURED verdict, not
  // inferred back from the rows' content. WHY THE VERDICT: the bash
  // `$verdict` is the SOURCE of the decision (`mainConflict` →
  // main-conflict, `queueConflicts` → next-only-conflict, clean otherwise),
  // so this is the ONE place where the "nothing's wrong" fact lives in a
  // single field. Inferring from the rows (do both start with `✓`?) would be
  // text-parsing instead of using the MEASURED data.
  const verdictClean = slow.state === 'done' && slow.diag.verdict === 'clean'
  // The branch name on its own line, DIRECTLY under the merge method
  // (user request: the method can be checked from the name, so the two
  // belong next to each other). The truncation is tied to the frame's inner
  // width, and the "branch: " prefix's width is subtracted too — otherwise
  // the row would overrun by exactly the prefix.
  const BRANCH_PREFIX = 'branch: '
  const branchRoom = Math.max(1, innerWidth - displayWidth(BRANCH_PREFIX))
  return [

    // --- THE AI-REVIEW SECTION (3) — AT THE VERY TOP, if present ----------
    //
    // The user's 3rd point: the confirmation, the progress, the end state,
    // the findings' short list and the load offer ALL live in the PR panel.
    // The section sits at the TOP of the panel: during a running review this
    // is the freshest (moving every second) information, and that's exactly
    // why the user opens the panel. The rows come from the core's pure
    // function (aiReviewPanelLines), clamped in cells.
    ...(reviewLines.length > 0 ? [...reviewLines, { text: ' ' }] : []),

    // --- FAST BAND ---------------------------------------------------------
    { dimColor: true, text: `state: ${fast.state}${fast.mergeMethod ? ` · merge-method: ${fast.mergeMethod}` : ''}` },
    // The branch name is the SOURCE of the method: the prefix
    // (`squash-`/`rebase-`/anything else) decides the method, so this row is
    // what the user uses to CHECK the merge-method row above. That's why it
    // sits directly under it, and why it's truncated in the middle (both the
    // prefix AND the name's tail stay visible) — see branchLabel.
    { color: 'cyan', text: `${BRANCH_PREFIX}${branchLabel(fast.headRefName, branchRoom)}` },
    ...(fast.stackedOn !== null
      ? [{ color: 'cyan', text: `⬆️ stacked PR — its base is #${fast.stackedOn}, its fate is decided there` }]
      : []),
    ...(fast.landableBlockers.length > 0
      ? [
          { color: 'yellow', text: 'landing blockers:' },
          // THE KEYS ARE PREFIXED, not bare indices. This panel spreads
          // THREE lists across the children of ONE Box (blockers, shared
          // files, culprits); with bare indices all three would start from
          // 0, and React ("two children with the same key, `0`") could
          // duplicate or DROP rows. In a live render this produced four
          // warnings.
          ...fast.landableBlockers.map((b, i) => ({ key: `blk-${i}`, color: 'yellow', text: `    · ${b}` })),
        ]
      : [{ color: 'green', text: '✓ landable (approved + green + mergeable)' }]),
    { text: ' ' },
    dep.hasDep
      ? { color: 'cyan', text: `⚡ dep: #${dep.dep} (sits BEFORE it in the queue, still open)` }
      : { dimColor: true, text: dep.summary },
    ...(dep.hasDep
      ? dep.filesUnknown
        // Fail-closed with missing dep data: the fact of the dependency
        // stands, WHAT it's in doesn't. This must be stated — an empty file
        // list does NOT mean "no shared files".
        ? [
            { color: 'yellow', text: '⚠️ the list of shared files is NOT knowable' },
            { dimColor: true, text: '   (the files data is missing — GitHub limits it on a large PR)' },
            { dimColor: true, text: '   we therefore report the dependency fail-closed: better to flag it than swallow it' },
          ]
        : [
            { text: `shared files (${dep.files.length}):` },
            ...dep.shown.map((f, i) => ({ key: `depf-${i}`, color: 'cyan', text: `    ${f}` })),
            ...(dep.more > 0 ? [{ dimColor: true, text: `    ${dep.moreLabel}` }] : []),
            // The intersection is a HEURISTIC, the conflict is a
            // MEASUREMENT. We state this so the user doesn't read a measured
            // fact out of a file intersection — the measured answer comes
            // from the panel's lower band.
            { dimColor: true, text: 'the intersection does not mean a conflict — the measurement below gives that answer' },
          ]
      : []),
    { text: ' ' },

    // --- MEASURED BAND -------------------------------------------------
    ...(!model.measurable
      ? [{ dimColor: true, text: 'conflict measurement: none — a stacked PR\'s fate is decided by its base, diagnose that' }]
      : slow.state === 'measuring'
      ? [
          { color: 'cyan', text: `⏳ ${slow.label}` },
          { dimColor: true, text: '   (merge-tree probes against the PRs ahead of it in the queue — Esc: abort)' },
        ]
      : slow.state === 'aborted'
      ? [
          { color: 'yellow', text: `⚠️ ${slow.label}` },
          { dimColor: true, text: '   a partial measurement proves neither a conflict nor its absence' },
        ]
      : slow.state === 'error'
      ? [
          { color: 'red', text: `✗ ${slow.label}` },
          { dimColor: true, text: '   the measurement did NOT run — this does not imply there is no conflict' },
        ]
      : slow.state === 'done'
      ? [
          // (wf31/10) ON THE `clean` BRANCH THE TWO MEASUREMENT ROWS MOVE
          // BEHIND THE TOGGLE — per the rationale stated at the head of the
          // section (the verdict's elaboration, not new information). The
          // `measurementLines` assemble below; here, in the `clean` case,
          // the visible part is EMPTY, and the rows reach the open block
          // through `caveatLines`'s `hidden` parameter.
          //
          // THE NEGATIVE branches ARE UNCHANGED: there the row IS the news
          // (with file names, culprit list), so it can't be hidden.
          ...(verdictClean ? [] : measurementLines),
          // THE GAP ROW IS ONLY NEEDED IF THERE'S SOMETHING TO SEPARATE: on
          // the `clean` branch the measurement rows moved behind the toggle,
          // so `Verdict` is the section's FIRST row — an empty row above it
          // would there add a double gap (there's already one above the
          // MEASURED BAND). An empty row descriptor takes up the same HEIGHT
          // in the render tree as a filled one (`clipBodyLines` counts
          // DISPLAYED rows) — this is the same error class as wf28/3's gap
          // row.
          ...(verdictClean ? [] : [{ text: ' ' }]),
          { bold: true, text: `Verdict: ${slow.diag.verdict}` },
          // (wf31/4) AN EMPTY SUMMARY DOESN'T PRODUCE A ROW. The `clean`
          // branch's summary became EMPTY (the measurement result moved into
          // the caveat's `detail` — see the diagnosis's `conflictAdvice`
          // clean branch), and an empty row descriptor would take the same
          // HEIGHT out of the render tree as a filled one: `clipBodyLines`
          // counts DISPLAYED rows. This is the same error class as
          // `menuExtraRows`'s gap row (wf28/3) — the row therefore ISN'T
          // EVEN BORN, it doesn't "render empty".
          // (wf31/52) THE SUMMARY IS WRAPPED, NOT TRUNCATED. The user's
          // finding: "in the verdict, the note about the stacking target is
          // horizontally capped" — mid-sentence, at "if functionally…".
          //
          // THE CAUSE: `renderLines` uses the render module's `Text`, which
          // is `wrap: 'truncate'` (because of the resize flicker, wf31/39) —
          // a long single-line descriptor therefore SILENTLY ends at the
          // right edge. The summary here is 3-4 sentences, i.e.
          // STRUCTURALLY not single-line content.
          //
          // THE FIX is `wrapCells`: wraps in cells to the panel's inner
          // width, and EVERY line becomes its own descriptor. The same
          // pattern the AI summary already uses (`aiReviewPanelLines`) —
          // there too, 2-4 sentences need to be shown, in the same panel.
          //
          // NO ROW CEILING: `clipBodyLines` already handles the panel's
          // HEIGHT anyway, and STATES the truncation ("… panel truncated").
          // A second, local ceiling here would bring back exactly the bug
          // wf31/50 fixed for the AI summary: the verdict is the most
          // important content in the panel.
          ...(String(slow.advice.summary ?? '').trim() === ''
            ? []
            : wrapCells(String(slow.advice.summary).trim(), innerWidth)
                .map((t, i) => ({ key: `adv-sum${i}`, text: t }))),
          // (wf31/68) THE COMMAND STAYS AS INFORMATION, NOT AS A
          // RECOMMENDATION. The `s` key in the footer offers to execute it,
          // but that ONLY works on the PR's OWN branch (`doStack`'s branch
          // check) — whoever is standing elsewhere needs the command. The
          // heading therefore states a condition, not a suggestion: whether
          // you functionally depend on it, the machine can't know.
          ...(slow.advice.offerStack
            ? [
                { text: ' ' },
                { dimColor: true, text: `If you functionally build on #${slow.advice.stackOn}, from the PR's own branch:` },
                { color: 'cyan', text: `  ${slow.advice.command}` },
              ]
            : []),
          // THE MEASUREMENT CAVEAT FOOTNOTE — AT THE VERY BOTTOM, AFTER THE
          // TODOS.
          //
          // WHY AT THE END: this is a RESERVATION, not a to-do. Placed
          // before the summary (measured fact) and the stacking suggestion
          // (an actionable step) it would restore exactly the order that
          // produced the warning fatigue — the user reading a paragraph
          // identical on every PR before the to-do.
          //
          // `caveat` is `conflictAdvice`'s SEPARATE field (not the summary's
          // tail): the disclosure this way ONLY takes away the reservation,
          // the to-do stays visible.
          // (wf31/10) On the `clean` branch, the MEASUREMENT ROWS go into
          // the OPEN block. On the negative branches, `hidden` is EMPTY —
          // there the rows sit in the visible part (the `verdictClean` gate
          // above), so no duplication can occur.
          ...caveatLines(
            slow.advice.caveat,
            innerWidth,
            verdictClean ? measurementLines : [],
          ),
        ]
      // (wf31/10) THE UNMEASURED STATE — THIS IS THE NEW DEFAULT, AND IT
      // CANNOT BE EMPTY.
      //
      // Previously `[]` went here (opening the panel always measured, so
      // this branch was practically unreachable). Now that the measurement
      // is an EXPLICIT gesture (`c`), this is the TYPICAL state — and an
      // empty band here would be the most expensive mistake: the user would
      // read the silence as "no conflict". This is the same argument stated
      // in `openInfo`'s cache-hit branch too ("a cache hit can't be silent
      // either").
      //
      // KNOWLEDGE FROM CI, THOUGH, IS NOT SILENCE: the `next-conflict` /
      // `next-blocked` label and having landed in next's graph is KNOWN from
      // the queue model, without measuring. The row therefore STATES what we
      // know, and only offers `c` for what we DON'T know (who I clash with,
      // whether I clash with main).
      : [
          // THE PROVIDER-DEPENDENT BAND: the rows about the integration
          // branch's rebuild status ONLY appear if the model came from a
          // provider that MEASURES this (given away by the presence of
          // `classification` — the gh/git provider deliberately doesn't
          // load it, see providers/github.mjs).
          //
          // WHY THEY CAN'T ALWAYS STAY: without this, the panel would state
          // something about a non-existent integration branch rebuild,
          // "inferred" from the PR's own state — i.e. MEASURED and INFERRED
          // knowledge would blur together, exactly the lying-status error
          // class this panel avoids everywhere else.
          ...(fast.classification === null || fast.classification === undefined
            ? []
            : fast.state === 'queue'
            // LANDED IN NEXT: CI's cumulative rebase WENT THROUGH. This is a
            // STRONGER fact than the local pairwise probe (which simulates a
            // merge) — so here the measurement wouldn't add anything, it
            // would give a less certain answer to the same question.
            ? [{ key: 'mt-ci', color: 'green', text: '✓ next: landed (CI\'s cumulative rebase went through)' }]
            : fast.state === 'conflict'
            // DROPPED OUT: the label states this, but NOT who I clash
            // with — only the measurement gives that (culprit list +
            // stacking target).
            ? [{ key: 'mt-ci', color: 'yellow', text: '⚠ next: dropped out (next-conflict — CI\'s rebase conflicted)' }]
            : fast.state === 'blocked'
            ? [{ key: 'mt-ci', color: 'yellow', text: '⚠ next: skipped (next-blocked — modifies a workflow file)' }]
            // MISSING: no rebuild has run yet with this PR. We don't know
            // anything — and we state that, not hide it.
            : [{ key: 'mt-ci', dimColor: true, text: '· next: not landed yet (no rebuild has run with this PR)' }]),
          // THE MAIN AXIS IS NOT MEASURED, and this MUST BE STATED: the
          // `next-conflict` label does NOT say whether I clash with main
          // (the #911 measured case: the PR WAS mergeable with main, the
          // conflict came from four intra-queue PRs). This is the ONLY axis
          // that NO CI signal reports.
          // (wf31/40) THE "culprits" JARGON REMOVED. The user's question:
          // "What does »main + culprits« mean? What's a culprit?" —
          // fair: the word was established IN THE CODE (the elements of
          // `queueConflicts`), but stood in the UI without explanation. In
          // its place goes what the measurement ACTUALLY gives: the fact of
          // clashing with main, and who you clash with in the queue.
          { key: 'mt-hint', dimColor: true, text: clampCells('· main: not measured — c: measure (do I clash with main, and with whom in queue)', innerWidth) },
        ]),

    // (wf31/73) THE RESOLUTION OFFER — IN THE `c: measure` ROW'S SPOT, AFTER
    // MEASURING.
    //
    // The user's request: "The command should only appear on the status row
    // after analysis, and it should say 'v: resolve', and appear where the
    // conflict command is."
    //
    // THE SPOT IS THEREFORE THE SAME as `mt-hint`'s: the bottom of the
    // measured band. BEFORE measuring, `c: measure` sits there (we don't
    // know if there's anything to resolve), AFTER measuring — if there's
    // EXACTLY ONE culprit — `v: resolve`. The two never show at once: one
    // announces the absence of a measurement, the other its result.
    //
    // ONE CULPRIT IS THE CONDITION: the resolution runs against a BASE (the
    // rebase targets one), and `conflictAdvice` gives `offerStack: false`
    // with more than one culprit — the same source decides here too, so `v`
    // and the stacking suggestion can't drift apart.
    ...(slow.state === 'done' && slow.advice?.offerStack === true
      ? [{
          key: 'mt-resolve',
          color: 'cyan',
          text: clampCells(`· v: resolve — AI resolution vs #${slow.advice.stackOn} culprit (analysis + code in the worktree)`, innerWidth),
        }]
      : []),

    // --- NEXT STEPS: THE PANEL'S OWN FOOTER SAYS IT, NOT THE BODY --------
    //
    // A SECOND ACTION ROW USED TO STAND HERE:
    //   'next from here: d: diff-review · r: AI-review · a: approve · m: merge'
    //
    // REMOVED (user request, verbatim): "the dropdown panel has two action
    // rows with basically the same options, it's completely pointless".
    //
    // THE MEASURED DUPLICATION: the panel frame's footer (core
    // `panelFooter`, INLINE branch) announces EXACTLY THE SAME four keys ONE
    // ROW BELOW (`d: diff · r: AI-review · a: approve · m: merge · j/k: row
    // · Esc: close`), and even MORE: j/k and Esc too. The body row therefore
    // carried no information that didn't appear elsewhere — deleting it lost
    // nothing.
    //
    // WHY THE FOOTER IS THE RIGHT PLACE (and not the body): the footer is
    // the overlay frame's control bar coming from ONE source, so the key
    // announcements can't drift apart panel by panel (this was the learned
    // bug class for keybinding references). The body is the CONTENT —
    // mixing the two would recreate the exact dual-source problem the
    // refactor eliminated elsewhere.
    //
    // THE REFACTOR'S RESULT STANDS: `a`/`m`/`r`/`d` are ALSO live WITHIN the
    // panel (see the panel branch in the keybinding handler) — we just don't
    // announce them twice.
  ]
}

/**
 * The error overlay's content: the raw message, wrapped IN CELLS.
 *
 * The wrap is the core's wrapCells (not Ink's own wrapping): WE compute the
 * frame's inner width, so the content needs to match the same measure,
 * otherwise the frame falls apart.
 *
 * THE LENGTH CAP: a failed `gh` can dump several hundred lines (e.g. a full
 * GraphQL error object). The overlay would push the list off screen in that
 * case — taking away exactly the CONTEXT the overlay refactor was built for.
 * The first lines matter (the error code/reason is there), and we announce
 * the rest by count, not by silently dropping it: the user knows there's
 * more, and where to look for it (the status row + the terminal
 * scrollback).
 */
const ERROR_BODY_MAX_LINES = 12

export function errorBody(errorState, innerWidth) {
  const lines = wrapCells(errorState.message, Math.max(1, innerWidth))
  const shown = lines.slice(0, ERROR_BODY_MAX_LINES)
  const hidden = lines.length - shown.length
  return [
    ...shown.map((line, i) => ({ key: `err-${i}`, color: 'red', text: line })),
    ...(hidden > 0
      ? [{ key: 'err-more', dimColor: true, text: `… and ${hidden} more lines (the full text is in the terminal scrollback)` }]
      : []),
  ]
}

/**
 * The ROW DESCRIPTOR → Ink tree conversion. In ONE place, AFTER the height
 * clip.
 *
 * `key` comes from the descriptor if present; otherwise it's position-based,
 * BUT with a `line-` prefix. WHY THE PREFIX: this panel spreads THREE lists
 * across the children of ONE Box (blockers, shared files, culprits), and
 * with bare indices all three would start from 0 — React's "two children
 * with the same key" error can duplicate or DROP rows. In a live render this
 * already produced four warnings.
 */
export function renderLines(lines) {
  return lines.map((l, i) => {
    const key = l.key ?? `line-${i}`
    // (2) A SEGMENTED ROW: multiple colors WITHIN one row. The
    // review-cascade menu's second stage needs this — there the warning is
    // RED, while the `y`/`esc` keys are dimmed, IN ONE row (the user:
    // a horizontal menu).
    //
    // WHY NESTING INK Texts, AND WHY NOT A Box WITH row DIRECTION: a Box
    // gets SIZED as a flex element, and within a narrow frame it would do
    // its own wrapping — exactly the frame collapse the layout module's
    // header rules out. A nested Text, though, is a PURE text flow: Ink uses
    // the parent Text's width, so the measure stays our own
    // `displayWidth`-measured row.
    //
    // `text` is ALWAYS there next to the segments (the core's
    // `joinSegments` supplies both, from the same list): the width tests and
    // the frame assertions MEASURE that, so the two can't drift apart.
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

// THE APPROVE / MERGE MODAL PROPS — from ONE source, at MODULE LEVEL.
//
// WHY NOT INLINE AT THE CALL SITES: both actions start from TWO places (from
// the list AND from within the panel), and in the old code the `blockers`
// computation was embedded in the `setConfirm` call. If the panel branch
// duplicated this, a missed `canApproveRow` check would SILENTLY let a
// forbidden approve through on exactly the one path we forgot to update —
// and the UI would look the same.
//
// The modal does NOT carry `row`: the PANEL supplies that (panelToModal
// keeps it). A second `row` in the modal would mean two sources for the same
// fact, which is exactly the drift class the consolidation eliminates.
// (wf31/14) THE BLOCKERS ARE LISTED, like for merge. The old form gave a
// SINGLE generic string ("yours / draft / stacked / already decided"), which
// forced the user to GUESS which reason applied — and they did ask. The
// `approveBlockers` gives the concrete reason; and "already approved" is NO
// LONGER a blocker (the second approve is allowed — the rationale is at the
// head of the core's `approveBlockers`).
export function approveModalProps(row) {
  return { kind: 'approve', blockers: approveBlockers(row) }
}

/**
 * (wf31/73) THE CONFLICT-RESOLUTION CONFIRMATION MODAL.
 *
 * NO BLOCKERS: the resolvability condition (a measurement exists, there's
 * ONE culprit) is already decided at the offer stage — the body only offers
 * `v` in that case. A second check here would create two truths from the
 * same question.
 *
 * `stackOn` goes into the modal because the QUESTION's text names the
 * target: the user should see, at confirmation, WHICH PR we're resolving
 * against.
 */
export function resolveModalProps(row, stackOn) {
  return { kind: 'resolve', blockers: [], stackOn }
}

export function mergeModalProps(row) {
  return { kind: 'merge', blockers: canMergeRow(row) ? [] : mergeBlockers(row) }
}

// The CONFIRMATION overlay's content. The TITLE (heading) is NOT born here:
// the core's OVERLAY_TITLES supplies it, so the frame above the list and the
// in-code state names can't drift apart.
export function confirmBody(confirm, innerWidth = 100, { hasTrace = false, choiceIndex = 0 } = {}) {
  const { kind, row, blockers, summary, paths, pathIndex, costWarning, budget, model } = confirm
  // The landing plan (method / branch fate / commit message). Only needed on
  // the merge branch; `mergePlan` gives null without a method, and then the
  // blockers list is non-empty anyway (the missing mergeMethod is listed
  // there).
  const mergeSummary = kind === 'merge' ? mergePlan(row) : null
  // The BRANCH NAME is also needed on the confirmation screen (user
  // request): they need to see, at the MOMENT of the decision, WHICH branch
  // the method applies to, because the "branch gets deleted" row alone
  // doesn't say WHICH branch. The truncation prefix here is longer
  // ("branch name: "), so it's measured separately.
  const BRANCH_PREFIX = 'branch name: '
  const branchRoom = Math.max(1, innerWidth - displayWidth(BRANCH_PREFIX))
  return [
    ...(blockers.length > 0
      ? [
          { key: 'cb-h', color: 'red', text: 'Denied — blockers:' },
          // PREFIXED key: this list lands in the children of ONE Box
          // together with the other keyed rows (summary rows, 'cw', 'ph',
          // 'p0'…). With a bare index, 0/1/2 could collide with sibling
          // summary rows, and React's ("two children with the same key")
          // error can duplicate or DROP rows — this was already measured
          // once, live, on the info panel.
          ...blockers.map((b, i) => ({ key: `cb-${i}`, color: 'red', text: `  · ${b}` })),
        ]
      : [
          // The AI-review screen lists MEASURED facts: PR size, scope, the
          // NAMES of the excluded generated files, the model and the
          // SPENDING CEILING. The order is decided in the summary (a pure
          // function, under test); here we only display it. The large-PR
          // warning and the "your own tokens" sentence get COLOR, so the eye
          // lands on them.
          ...(kind === 'ai-review'
            ? summary.lines.map((line, i) => ({
                key: `sum-${i}`,
                // THE PATTERN FOLLOWS THE TEXT, AND THAT COUPLING IS THE RISK
                // HERE: these lines are produced in ai-review-config, and this
                // is the only place that matches against their wording. The
                // translation to English broke it once already — the pattern
                // still read `FIGYELEM` while the producer had switched to
                // `WARNING`, so the warning silently lost its colour. Nothing
                // fails when this drifts; it just stops highlighting.
                //
                // The second pattern is gone rather than translated: it matched
                // a "consumes your own tokens" sentence that was deliberately
                // removed from the summary earlier, so it had been dead before
                // the translation touched it.
                color: /^WARNING/.test(line) ? 'red' : undefined,
                bold: /^WARNING/.test(line),
                text: line,
              }))
            : []),
          // The COST warning (>30 files OR >2000 lines) separate, in RED:
          // this is the most expensive decision on the screen.
          ...(kind === 'ai-review' && costWarning
            ? [{ key: 'cw', color: 'red', bold: true, text: costWarning }]
            : []),
          // Choosing the REVIEW PATH. The default is `agent-review` (bit-
          // identical to CI); TAB cycles it, the NUMBER (1/2) picks directly
          // — not the arrow (user: "it bugs me that I have to use left/right
          // arrows"). Both paths' `note` is SHOWN, because the consequence
          // of the choice (matching CI vs. different rules) isn't obvious.
          ...(kind === 'ai-review' && Array.isArray(paths)
            ? [
                // Breathing room at the section boundary (the user: "the
                // whole thing is squished together").
                { key: 'sp-paths', text: ' ' },
                { key: 'ph', bold: true, text: 'Review path (Tab: switch · 1/2: direct):' },
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
          // The MERGE overlay gives the decision's TWO verifiable facts: the
          // method, and the branch name (from which the method follows).
          //
          // (wf31/23) THE "branch fate" AND "commit message" ROWS REMOVED —
          // the user's request: "again, over-explained nonsense, cut it
          // (both rows)".
          //
          // WHAT WAS THERE, AND WHY IT'S NOT MISSED:
          //     branch fate: the branch stays (a ticketed branch — the
          //                   changelog references it)
          //     commit message: comes from the repo's settings (we don't
          //                   override it)
          // The first explained OUR OWN RULE (why the branch stays), the
          // second that we DO NOTHING ("comes from the repo's settings"). A
          // row about not touching something is not information.
          //
          // WHAT STAYS: the `method` and the `branch name`. This pair is the
          // DECISION's verification — the prefix is the method's source, so
          // the name shows whether the method is right (this was the user's
          // original request for the branch-name row).
          ...(kind === 'merge'
            ? [
                { key: 'mm', text: `method: ${mergeSummary?.methodLabel ?? row.mergeMethod}` },
                { key: 'mn', color: 'cyan', text: `${BRANCH_PREFIX}${branchLabel(row.headRefName, branchRoom)}` },
                // (wf31/22) THE WARNINGS — SHOWN, BUT NOT BLOCKING.
                //
                // The user's decision: "the github UI allows merging,
                // approve is the only condition. […] You can leave warnings
                // in at most." The red checks, BEHIND, and the rest
                // therefore appear HERE, after the decision's data, BEFORE
                // the confirmation question.
                //
                // YELLOW, NOT RED: red marks a DENIAL (the `denied` branch's
                // heading), and if the warning were red too, the two would
                // blur together — exactly the "stricter than the platform"
                // reading this change eliminates.
                ...mergeWarnings(row).map((w, i) =>
                  ({ key: `mw-${i}`, color: 'yellow', text: `⚠ ${w}` })),
              ]
            : kind === 'ai-review'
            ? [{ key: 'sp-nx', text: ' ' },
               { key: 'nx-ai', dimColor: true, text: 'the AGENT writes the findings into the hunk session — upload only after your own review, with "f"' }]
            : kind === 'upload'
            // The CONSEQUENCE is stated: this is VISIBLE FROM OUTSIDE. We
            // don't yet know the count (doUpload reads that out), but we do
            // know that the comments that STAYED in the hunk session go up —
            // so what the user already filtered out doesn't.
            ? [{ key: 'nx-up', dimColor: true, text: 'the comments that STAYED in the hunk session go up as ONE review (event=COMMENT, not approve) — visibly on the PR, under your name' }]
            : [{ key: 'nx-def', dimColor: true, text: 'with an attestation comment, via the existing non-interactive path' }]),
          // --- THE FRICTION BAND + THE DECISION -----------------------------
          //
          // The user's 1st principle: approve/merge is NOT blocked by the
          // lack of a review trace — it's only FLAGGED, and the question
          // STATES the stakes. The rows come from the core's PURE function
          // (frictionLines), which also decides the color/dim there: the
          // flag is NOT yellow (yellow is reserved for COST and BLOCKERS),
          // and the question doesn't stand out either — the user's complaint
          // was, verbatim, that "»Confirm« stands out pointlessly in yellow,
          // when it's already there at the bottom of the box".
          //
          // FRICTION only lives on the approve/merge branch: the
          // findings-upload and the AI-review DON'T state that a review
          // HAPPENED (one IS the review, the other is a spending decision),
          // so the trace indicator would be meaningless noise there.
          ...(modalHasChoices(kind)
            ? [
                { key: 'fr-sep', text: ' ' },
                // (wf31/73) `stackOn` PASSED THROUGH: the resolve question
                // names the target. It comes from `confirm` (`resolveModalProps`
                // put it there), so the modal and the question talk about
                // the SAME PR.
                ...frictionLines({ kind, hasTrace, stackOn: confirm.stackOn ?? null }).map((l, i) =>
                  ({ key: `fr-${i}`, color: l.color, dimColor: l.dim, text: l.text })),
                // THE ARROW-KEY CHOICE (the user's 2nd principle: in a modal,
                // up/down steps the CHOICE, not the list). The default is NO
                // — fail-closed, see the core's MODAL_CHOICES head. `y` is
                // still a direct yes: the list is the arrow-key PATH, not its
                // replacement.
                // THE TWO CHOICES ON ONE LINE: `▸ No   Yes`. Joined into one
                // line, not in separate Texts — the height clip counts
                // DISPLAYED rows, so the descriptor needs to be one row,
                // otherwise the estimate and reality drift apart.
                {
                  key: 'ch',
                  text: MODAL_CHOICES.map((c, i) => `${i === choiceIndex ? '▸' : ' '} ${c.label}`).join('   '),
                  color: 'cyan',
                },
              ]
            : [{ key: 'sp-q', text: ' ' },
               { key: 'q', dimColor: true, text: 'Confirm? [y/N]' }]),
          // THE BUDGET ROW: the overlay's BOTTOM-MOST row, DIMMED, on one
          // line.
          //
          // WHY HERE AND WHY LIKE THIS (user decision): `--max-budget-usd`
          // applies to API spend per `claude --help`, but the user is
          // burning a subscription limit instead — so it's not even certain
          // it caps anything. A switch with an uncertain effect doesn't earn
          // emphasis or an explanatory paragraph: "it can be in a very
          // unobtrusive place". The EMPHASIZED part is the SIZE INFO above
          // it (file count + diff lines, red on a large PR) — that's
          // provably useful protection against the limit.
          //
          // The TEXT comes from the core's budgetLine, it isn't built here:
          // the "budget: off" form and the tier list live from ONE source
          // this way, under test.
          // THE MODEL ROW (5b): the CONCRETE model name is shown and
          // switchable (`m`). ABOVE the budget row, because the model is the
          // LARGER cost lever: the budget flag has an uncertain effect under
          // a subscription, while the model tier measurably decides the
          // order of magnitude (the user's quota once went entirely into one
          // Fable run). Dimmed, like the budget row (the user's 3rd
          // principle: controls at the bottom of the frame, emphasis on the
          // content's size info) — the TEXT comes from the core's modelLine
          // (one source, under test).
          ...(kind === 'ai-review' && model
            ? [{ key: 'ml', dimColor: true, text: modelLine(model) }]
            : []),
          ...(kind === 'ai-review' && budget
            ? [{ key: 'bl', dimColor: true, text: budgetLine(budget) }]
            : []),
          // WHAT'S DELIBERATELY NOT HERE: an EXPLANATION of the dwell gate.
          // Per the user's complaint, the prose "(the confirmation is live
          // shortly after the screen appears — a y pressed during
          // measurement doesn't count)" is hard to parse, and doesn't belong
          // here anyway: the gate is INVISIBLE in NORMAL use (the eye-hand
          // loop is slower than the 250 ms), so 99% of the time the
          // developer would be reading about a mechanism that doesn't affect
          // them. Whoever actually hits it gets ONE short row in the status
          // line ("too early y" — see the useInput y branch). The
          // mechanism's RATIONALE lives in code comments: here, in the
          // useInput confirm branch, and at the head of the core's
          // confirmAccepts (typeahead / Ink raw-mode buffer).
        ]),
  ]
}
