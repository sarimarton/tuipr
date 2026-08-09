// tuipr — PANEL: the TOPMOST core layer.
//
// What lives here: the overlay frame + arrow-key selection, the PR panel
// state machine (inline info / modal confirmation), the viewport limit, the
// friction text (FLAGGED, but NOT BLOCKING), and the two branches of the
// attestation body.
//
// WHY THE TOPMOST: this layer consumes the others (layout: the frame's
// CELL-measured wrapping; diagnosis: the progress reducer). That's why the
// layer order ENDS here — and precisely why it's FORBIDDEN for any lower
// module to call back into this one: that would IMMEDIATELY be a cycle (the
// scripts/check-next-modules.mjs enforces this mechanically).
import { clampCells, displayWidth, stepIndex, wrapCells } from './layout.mjs'
import { progressReducer } from './diagnosis.mjs'

// === OVERLAY FRAME + ARROW-KEY SELECTION ====================================


// The frame takes 1 cell per side, the horizontal padding another 1 per side.
// Ink's `borderStyle` + `paddingX: 1` consumes exactly this much — if we
// counted less here, the frame's right side would wrap.
const OVERLAY_BORDER_W = 2
const OVERLAY_PADDING_W = 2
// The right margin: the overlay should NOT stick to the terminal's right
// edge. This doesn't prevent wrapping (the two constants above do that), it
// improves readability.
const OVERLAY_MARGIN_W = 2
// The narrowest inner space below which drawing a frame no longer makes
// sense, but the caller still needs a consistent number back (not 0, not
// negative).
const OVERLAY_MIN_INNER_W = 1

/** The overlay headings: state kind → title prefix. In one place so it can't drift. */
const OVERLAY_TITLES = {
  approve: 'Approve',
  merge: 'Merge',
  upload: 'Uploading findings to GitHub',
  'ai-review': 'AI-review',
  // (wf31/73) CONFIRMING resolve: the resolution calls AI (tokens) AND writes
  // code in a disposable worktree — both justify the gate, same as approve/merge.
  resolve: 'resolve conflict',
  info: 'Info',
  error: 'Error',
}

/**
 * The overlay's FRAME (chrome): title, footer, frame color, and the
 * CELL-measured widths. The CONTENT is not here — the app renders that,
 * clamped to `innerWidth`.
 *
 * WHY A PURE FUNCTION: the "which title/footer/color for which state"
 * decision is the UX contract, and it's exactly what the user had reworked
 * (separate screen → overlay). In render this isn't cheaply testable; here it
 * is, and the width-fitting (60/100/190 columns, display CELLS) also comes
 * under unit test.
 *
 * FAIL-CLOSED on an unknown `kind`: null. A guessed title ("Action") would
 * give the impression that the UI knows what it's asking — when it doesn't.
 */
export function overlayFrame({ state, columns = 120 } = {}) {
  if (!state || typeof state !== 'object') return null
  const heading = OVERLAY_TITLES[state.kind]
  if (heading === undefined) return null

  const width = Math.max(
    OVERLAY_BORDER_W + OVERLAY_PADDING_W + OVERLAY_MIN_INNER_W,
    Math.min(columns, Math.max(20, columns - OVERLAY_MARGIN_W)),
  )
  // `width` can never exceed the terminal — the Math.max floor above could in
  // theory raise it on a very narrow terminal, so we clip here.
  const outer = Math.min(width, Math.max(1, columns))
  const innerWidth = Math.max(OVERLAY_MIN_INNER_W, outer - OVERLAY_BORDER_W - OVERLAY_PADDING_W)

  const denied = Array.isArray(state.blockers) && state.blockers.length > 0
  const isError = state.kind === 'error'
  const row = state.row ?? {}
  // THE TITLE CARRIES THE PR NUMBER: this is the context the whole refactor
  // exists for. The number and the `#` are NEVER truncated — the TITLE runs
  // out first, because "which PR?" is the more important information.
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
    // THE FRAME COLOR is the earliest-perceived signal: denial and error are
    // RED, the token-spending AI-review is YELLOW, the rest CYAN.
    borderColor: denied || isError ? 'red' : state.kind === 'ai-review' ? 'yellow' : 'cyan',
    denied,
    width: outer,
    innerWidth,
  }
}

/**
 * The footer text. A separate function so the key advertisement lives in ONE
 * place — the earlier bug class was exactly that the keybind drifted across
 * three sources (code, legend, docs).
 *
 * THE ORDER is deliberate: DECISION keys (arrow, y/N) up front, closing at
 * the back. If `clampCells` cuts on a narrow terminal, the decision keys
 * survive — an overlay that doesn't show how to say yes is useless.
 */
function overlayFooter({ state, denied, isError }) {
  // Esc is NEVER "exit" here: it closes the overlay. Conflating the two is
  // the user's 3rd point — with an overlay open, q/Esc must not exit the TUI.
  if (isError) return 'Esc/q: close overlay'
  if (denied) return 'any key (including Esc/q): back — the action is blocked'
  if (state.kind === 'info') {
    return 'j/k: another row (measurement restarts) · Esc/q: cancel measurement + close overlay'
  }
  const parts = []
  // The ARROW affordance appears ONLY when there's something to switch TO: on
  // a single path the advertised arrow would be a dead key, and the user
  // would think it's broken.
  if (state.kind === 'ai-review' && Array.isArray(state.paths) && state.paths.length > 1) {
    // The user's FURTHER request: "it bothers me that I have to use left/right
    // arrows" — the arrow is NO LONGER the review-path switcher. Tab is the
    // cyclic switcher (it already worked, now we advertise it), the numbers
    // (1..N) are direct selection. The arrow stays the budget-step's, when
    // the ceiling is on — this way neither feature shares a key with the other.
    parts.push(`Tab/1-${state.paths.length}: review path`)
  }
  // Advertising the MODEL SWITCHER (5b): `m` is a free key in confirmation
  // mode (merge's `m` never reaches here), and the mnemonic is exact. We
  // advertise it only where it's live — on the ai-review confirmation.
  if (state.kind === 'ai-review' && state.model) parts.push('m: model')
  parts.push('y: confirm [y/N]')
  parts.push('Esc/q: cancel')
  return parts.join(' · ')
}


// === PANEL: A SINGLE PR PANEL (info + measurement + next steps) ============
//
// THE SUBJECT OF THE REFACTOR (user request, verbatim): "The alerts,
// messages, dialogs are on a separate screen… it would be better if they
// appeared in a framed overlay above the list" + "merging the info and
// rebase dialog: I'd merge the two. Both have extra info that could let you
// move on to the review."
//
// THE PREVIOUS STATE: FOUR separate dialogs (info, approve-confirm,
// merge-confirm, ai-review-confirm), each with its own key set, and the
// "look → step back → act" loop ran on every decision. You couldn't approve
// from the info panel; you had to exit it for `a` to be live.
//
// THE NEW MODEL IS ONE STATE, TWO MODES — and the mode follows from the
// DIALOG TYPOLOGY (the user's 2nd principle), not from configuration:
//
//   mode: 'inline'  — INFO. Sits BELOW the selected row, the list stays
//                     visible throughout, and you can navigate (j/k) below
//                     the panel too, even WHILE MEASURING. Rationale: info is
//                     CONTEXT, not a decision — as a modal it would take over
//                     the list, which is exactly the basis for comparison.
//   mode: 'modal'   — CONFIRMATION (approve / merge / AI-review /
//                     findings-upload). Since finding 5a, the RENDER is the
//                     same inline panel (the list STAYS VISIBLE — the user:
//                     "the info panel is the only dialog route for PR
//                     actions"); the mode is distinguished in the KEYS: up/down
//                     steps the SELECTION, NOT the list. Rationale: on a
//                     pending, irreversible decision, list navigation is a
//                     weapon — the cursor could move out from under the
//                     decision (the poll chapter doesn't auto-refresh for the
//                     same reason).
//
// THERE IS NO SWITCH between the two. The user's stated reason: "a switch
// nobody sets just duplicates a code path."
//
// THE MODAL OPENS FROM THE PANEL, not in place of it: `panelToModal` KEEPS
// `row` and `progress`, so Esc from the MODAL returns to the INFO panel, not
// the list. This way the "look → act → look again" loop closes within the
// panel — exactly what the user asked for.

/**
 * Opening the panel in INLINE mode (`i`, or any row selection).
 *
 * `progress` is the state of the measurement state machine
 * (progressInit/Reducer), or null. The PANEL STATE CARRIES it — not a
 * separate state, because measurement is one of the panel's bands, and
 * splitting the two apart would bring back exactly the four-dialog breakup.
 */
export function panelOpen({ row, progress = null } = {}) {
  return { mode: 'inline', row: row ?? null, progress, modal: null }
}

/**
 * Closing the panel. Returns NULL — and this is load-bearing: the caller
 * nulls out ONE state, so an ORPHANED MODAL can't remain.
 *
 * WHY THIS NEEDS TO BE A FUNCTION (and not a `setPanel(null)` at the call
 * site): in the earlier code `confirm` and `info` were SEPARATE states, and
 * the closing paths drifted apart — there was a branch that closed one but
 * not the other. A confirm left open above the list meant the next `y` would
 * approve an ALREADY-FORGOTTEN PR. One state + one close = the bug class
 * eliminated.
 */
export function panelClose() {
  return null
}

/**
 * Transition into MODAL mode: the confirmation opens from the panel.
 *
 * `row` and `progress` are KEPT: (a) the modal's heading talks about the same
 * PR, so it doesn't need to be passed again (two sources = drift), and (b)
 * Esc from the modal returns to the INFO panel — the measured diagnosis isn't
 * lost over a change-of-mind gesture.
 *
 * `armedAt` is the anchor for the dwell gate (confirmAccepts). It's born
 * HERE, at the TRANSITION, not during render: dwell measures how long the
 * decision has been in front of the user's eyes, and a timestamp taken during
 * render would restart on every re-render — the typeahead protection would be
 * a silent no-op.
 */
export function panelToModal(st, { kind, blockers = [], armedAt = Date.now(), ...rest } = {}) {
  if (!st || typeof st !== 'object') return null
  return {
    ...st,
    mode: 'modal',
    modal: { kind, blockers: Array.isArray(blockers) ? blockers : [], armedAt, ...rest },
  }
}

/** Back from the modal to the INLINE panel (Esc from the decision). */
export function panelToInline(st) {
  if (!st || typeof st !== 'object') return null
  return { ...st, mode: 'inline', modal: null }
}

/**
 * Folding a measurement event into the PANEL's state, with `pr`-bound
 * stale protection. PURE: for a stale event it returns the RECEIVED state
 * (reference-identical), so React's setState stays a no-op.
 *
 * WHY A SEPARATE FUNCTION next to `applyProgressToInfo` (and why not call
 * that directly on the panel): `applyProgressToInfo` rebuilds the INFO shape
 * (`{row, progress}`) via spread. Called on the panel shape it would LOOK
 * like it works, but if anyone later narrows the spread (or a new key lands
 * on the panel), `mode` and `modal` would BE LOST. The consequence IN
 * PRODUCTION: a measurement event landing over an open modal would SILENTLY
 * close the modal (`mode === undefined`), and the user's decision would run
 * into nothing — the measurement runs in the background, so this would
 * happen at exactly the worst moment. The SEPARATE function + the test
 * written against it rules this out.
 *
 * THE THREE DROP REASONS, each a different bug class:
 *   - `null` panel (closed in the meantime): a closed panel doesn't revive;
 *   - `row.number !== pr`: the user moved to a DIFFERENT row, the old
 *     measurement's callback would write into the NEW panel's state — the
 *     user would read another PR's measured conflict fact;
 *   - `progress` null (unmeasurable, stacked row): nothing to step.
 */
export function applyProgressToPanel(cur, pr, ev) {
  if (!cur || typeof cur !== 'object') return cur
  if (cur.row?.number !== pr || !cur.progress) return cur
  return { ...cur, progress: progressReducer(cur.progress, ev) }
}

/**
 * WHICH BAND SHOWS — the panel's content contract, in a pure function.
 *
 * The bands' NAMES drive the render branches. They live here, not in render,
 * because "what shows in which state" is the UX CONTRACT: it's what the user
 * had reworked, and what could only be measured back from the view with a
 * live (expensive) Ink render.
 *
 * INLINE: info + measurement + ACTIONS. The third is the point of the
 *   refactor — the next steps (`d`/`r`/`a`/`m`) are INSIDE the panel, so the
 *   "step back to act" loop is gone.
 * MODAL: confirm. The ACTION LIST is DELIBERATELY NOT here: a buffered or
 *   mistyped `m` over the decision would fire ANOTHER irreversible action.
 */
export function panelSections(st) {
  if (!st || typeof st !== 'object') return []
  if (st.mode === 'modal') return ['confirm']
  return ['info', 'measure', 'actions']
}

/**
 * WHICH KEY IS LIVE — the key set from ONE source.
 *
 * The `'choice'` pseudo-key denotes up/down SELECTION-stepping (in modal). Not
 * a letter, because it isn't one: both the arrow and j/k map onto it. The SET
 * states that in modal, up/down is NOT list navigation — this is the
 * mechanical form of the user's 2nd principle, and in the old code this is
 * exactly where it drifted (on the confirm branch, j/k fell into the
 * `undefined` branch, SILENTLY closing the overlay).
 */
export function panelKeys(st) {
  if (!st || typeof st !== 'object') return []
  if (st.mode === 'modal') {
    // On a BLOCKED action's (denied) modal, confirmation isn't live either:
    // there's nothing to confirm. Only closing — without this, `y` would read
    // as "success" feedback on a denied action.
    const denied = (st.modal?.blockers?.length ?? 0) > 0
    if (denied) return ['escape']
    // `'choice'` (up/down selection-stepping) is live ONLY where a list
    // EXISTS — from the same source the footer advertises it from
    // (MODAL_CHOICE_KINDS). Without this, the key set and the footer could
    // drift apart, and the arrow would be a dead key.
    // (wf31/69) `'return'` (Enter) IS LIVE ON THE CHOICE BRANCH — AND WAS
    // MISSING FROM THIS SET UNTIL NOW. Enter executes the SELECTED branch
    // (closes on `'No'`, normalizes to `y` on `'Yes'`), so the contract used
    // to say less than what actually worked — exactly the drift this set is
    // meant to prevent.
    return modalHasChoices(st.modal?.kind)
      ? ['y', 'n', 'choice', 'return', 'escape']
      : ['y', 'n', 'escape']
  }
  // INLINE: list navigation AND the five actions (including upload — point 3),
  // plus canceling the AI-review (`x` — the progress bar advertises it in the
  // panel), toggling the caveat footnote (`return`), and closing.
  //
  // (wf31/30) `'return'` (Enter) CLOSES THE PANEL — A TOGGLE. On the list,
  // Enter OPENS, so the same button closes too: one button, one concept
  // ("details on/off"). The earlier shape toggled the caveat footnote, but
  // that footnote is GONE (the measurement details always show) — so the key
  // freed up. `Esc` UNCHANGED still closes: that's muscle memory, and the
  // footer advertises it too.
  //
  // WHY HERE AND NOT JUST IN App: this set is the MECHANICAL source of
  // "which button is live". The project's MEASURED bug class is that the key
  // set and the actual handler drift apart (on the `f` modal the footer
  // advertised an arrow, the body gave no list — the arrow was a DEAD KEY, and
  // the user didn't know if the button was broken or the UI had frozen).
  // (wf31/10) `'c'` IS THE EXPLICIT TRIGGER FOR CONFLICT MEASUREMENT. Opening
  // the panel no longer measures (the cumulative truth comes from the next
  // graph and CI labels, without measuring), so the expensive path got its
  // own gesture — and without a key advertising it, the measurement would be
  // UNREACHABLE.
  //
  // (wf31/17) `'f'` STAYS HERE, DESPITE THE FOOTER'S CONDITIONALITY. WHY: this
  // set says which keys the panel must NOT swallow — `doUpload` itself decides
  // upload AVAILABILITY (it also does the hunk-session measurement, which we
  // can't do on the render path). The footer filters the ADVERTISEMENT (no
  // dead key), the handler filters the EXECUTION — the two aren't the same
  // question. If `f` dropped out here, an advertised `f` (uploadable material
  // exists) would SILENTLY die.
  // (wf31/53) `'s'` IS STACKING. The measurement has ALREADY decided whether
  // there's a stack target (`conflictAdvice.offerStack` + `stackOn`) — until
  // now only the COMMAND was printed out, the user had to retype it by hand.
  // The user's request: "stacking should be offered in the info panel's status
  // in this state (with pending UI)".
  //
  // THE KEY IS HERE EVEN WHEN THERE'S NO OFFER — same principle that justifies
  // `'f'` staying: this set says which keys the panel must NOT swallow, the
  // footer filters the ADVERTISEMENT (`stackLabel`), and `doStack` decides
  // EXECUTABILITY — that's where the branch measurement lives, which we can't
  // do on the render path.
  // (wf31/73) `'v'` IS CONFLICT RESOLUTION. The key is here even when there's
  // nothing to resolve (no measurement or no culprit) — same principle as
  // `'f'` and `'s'`: this set says which keys the panel must NOT swallow, the
  // body filters the ADVERTISEMENT, `doResolve` decides EXECUTABILITY.
  return ['j', 'k', 'c', 'd', 'r', 'f', 'a', 'm', 's', 'v', 'x', 'return', 'escape']
}

/**
 * THE MODAL'S CHOICES, and the DEFAULT is NO.
 *
 * WHY NO COMES FIRST (fail-closed): the modal confirms an irreversible,
 * externally visible action (approve / merge / GitHub review post). The
 * opening choice is therefore the safe branch: a blindly hit Enter/up-down
 * can NOT start anything. `y` is still a direct yes (behind the dwell gate) —
 * the choice list is the ARROW-KEY path, not its replacement.
 */
export const MODAL_CHOICES = [
  { id: 'no', label: 'No' },
  { id: 'yes', label: 'Yes' },
]

/**
 * WHICH MODAL KINDS GET AN ARROW-KEY CHOICE LIST — from ONE source.
 *
 * The choice list lives on the approve/merge branch, because that's the
 * FRICTION decision (stating the review trace + stating the stakes). The
 * findings-upload and the AI-review do NOT assert that a review happened
 * (one IS the review, the other is a spend decision) — there the list would
 * be meaningless noise.
 *
 * WHY THIS NEEDS TO BE AN EXPORTED CONSTANT (BUG MEASURED IN LIVE RENDER):
 * the footer and the body decided SEPARATELY whether there's a list. On the
 * `f` (upload) modal the footer advertised `↑/↓: choose`, but the body gave
 * just a plain "Confirm? [y/N]" line — the arrow was a DEAD KEY there. The
 * user presses it, nothing happens, and they don't know if the button is
 * broken or the UI froze. Same principle as why `overlayFooter` advertises
 * the review-path arrow only when there are two paths. ONE source → the two
 * can't drift apart.
 */
// (wf31/73) `resolve` IS ALSO CHOOSABLE BY ARROW — the same gate experience
// as approve/merge: the modal's opening choice is the SAFE branch (No), and
// the ←/→ + ⏎ path is live too. A y/N-only gate here would be inconsistent
// with the other two spending actions.
export const MODAL_CHOICE_KINDS = new Set(['approve', 'merge', 'resolve'])

/** Does this modal kind get an arrow-key choice list? */
export function modalHasChoices(kind) {
  return MODAL_CHOICE_KINDS.has(kind)
}

/**
 * Stepping the choice up/down with the arrow — per `stepIndex`'s contract
 * (wraps, normalizes a degenerate index FIRST).
 *
 * A separately named function, not a direct call to `stepIndex` in render:
 * the modal's choice space is FIXED (two elements), so the caller can't
 * accidentally call it with a different length (e.g. the `paths` array — a
 * DIFFERENT choice space).
 */
export function modalChoiceStep(current, delta) {
  return stepIndex(current, MODAL_CHOICES.length, delta)
}

/**
 * THE FEWEST LIST ROWS the panel leaves behind.
 *
 * THE DECISION: on a narrow terminal the PANEL shrinks, NOT the list that
 * disappears.
 *
 * The reason is the refactor's original cause: the old code opened the
 * dialog with a FULL-SCREEN swap, and the user lost the list — couldn't see
 * WHICH PR the question was about. If the viewport gave the room to the
 * panel, we'd arrive back at the same place, just gradually. The list is the
 * CONTEXT; the panel's content, on the other hand, is scrollable/truncatable,
 * so there the loss is RECOVERABLE.
 *
 * The 3 isn't an aesthetic number: the cursor's row + one neighbor on each
 * side. With a single row the "where am I in the queue" question is
 * unanswerable (nothing to compare against), and comparison is exactly why
 * the list stays.
 */
export const PANEL_MIN_LIST_ROWS = 3

/**
 * THE VIEWPORT: how many list rows and how many panel rows show, and where
 * the list window starts.
 *
 * WHY THIS IS NEEDED AT ALL: the list is NOT virtualized — until now every
 * row got rendered. While the dialog was full-screen, this didn't show (the
 * list wasn't there); the INLINE panel, though, sits BELOW the list, so
 * list-height + panel-height + chrome combined can exceed the terminal. Ink
 * then pushes the content upward: FIRST the HEADER slides out (the one
 * carrying the load time and the staleness indicator), then the top of the
 * list. So the user loses exactly what the header chapter was built for.
 *
 * THE CONTRACT has three points, all under test:
 *   1) visibleRows + panelRows + chrome <= height — NEVER overflows;
 *   2) THE CURSOR'S ROW IS ALWAYS in the window — without this the panel
 *      would talk about a row that isn't visible (the worst kind of lying
 *      UI);
 *   3) the list gets at least `PANEL_MIN_LIST_ROWS` rows, if there are that
 *      many — the panel is what truncates, not the context.
 *
 * THE TRUNCATION IS STATED: `panelTruncated` is in the model so the view can
 * print it ("… N more rows"). A silently cut-off panel is the same bug class
 * as a silently swallowed error: the user has no idea there's more.
 */
export function panelViewport({ rowCount = 0, cursor = 0, height = 24, panelHeight = 0, chrome = 4 } = {}) {
  const rows = Math.max(0, Math.floor(Number(rowCount) || 0))
  // Height is FAIL-SOFT: on a non-TTY or during resize `rows` can be
  // 0/undefined, and a height of 0 would swallow every row. 24 is the classic
  // default.
  const h = Number.isFinite(Number(height)) && Number(height) > 0 ? Math.floor(Number(height)) : 24
  const ch = Math.max(0, Math.floor(Number(chrome) || 0))
  const wanted = Math.max(0, Math.floor(Number(panelHeight) || 0))
  // The chrome (header + status + legend) is a FIXED cost: what's left after
  // it is shared between the list and the panel.
  const room = Math.max(0, h - ch)
  if (wanted === 0) {
    const visible = Math.min(rows, room)
    return { first: clampFirst(rows, cursor, visible), visibleRows: visible, panelRows: 0, panelTruncated: false }
  }
  // THE LIST GETS SERVED FIRST — but only the minimum (or however many rows
  // there are, if fewer). This way the panel shares the REMAINDER, and if the
  // remainder is less than it asked for, the PANEL truncates.
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
 * CUTTING THE PANEL BODY off at `maxRows` DISPLAYED rows.
 *
 * WHY THIS IS NEEDED (MEASURED BUG, FROM LIVE RENDER): in the first version,
 * `panelViewport` CORRECTLY returned `panelTruncated: true`, the view even
 * PRINTED IT ("panel truncated"), BUT NOBODY ACTUALLY CUT THE CONTENT. The
 * panel rendered its full body: on a 12-row terminal the frame ballooned to
 * 29 rows, and the HEADER slid out — meaning the UI CLAIMED a truncation
 * that never happened. This is the same bug class as a lying status line:
 * the worst kind, because the user trusts the indicator.
 *
 * THE UNIT OF TRUNCATION IS THE DISPLAYED ROW, NOT THE BODY ELEMENT. A long
 * advice paragraph takes 3-4 rows in Ink's wrapping; counting by element
 * would UNDER-estimate, and under-estimating is exactly what causes the
 * overflow. The measure is the same `wrapCells`/`displayWidth` the frame uses
 * too — two different measures (character vs. cell) here would guaranteed
 * drift apart.
 *
 * The input is a list of `{ text, … }`-shaped items; keys OTHER THAN `text`
 * (color, dim, key) pass through untouched in `kept` — turning them into an
 * Ink tree is the view's job.
 */
export function clipBodyLines(body, { width = 80, maxRows = 0 } = {}) {
  const items = Array.isArray(body) ? body : []
  const w = Number.isFinite(Number(width)) && Number(width) > 0 ? Math.floor(Number(width)) : 1
  const limit = Number.isFinite(Number(maxRows)) && Number(maxRows) > 0 ? Math.floor(Number(maxRows)) : 0
  const kept = []
  let rows = 0
  for (const item of items) {
    // THE NUMBER OF WRAPPED ROWS. Empty/whitespace text takes 1 row (Ink
    // renders even an empty Text), but `wrapCells` gives an empty list for
    // it — hence the floor of 1. Without this, the panel's empty separator
    // rows would be "free", and the estimate would undercount.
    const lines = Math.max(1, wrapCells(String(item?.text ?? ''), w).length)
    if (rows + lines > limit) return { kept, rows, truncated: true }
    kept.push(item)
    rows += lines
  }
  return { kept, rows, truncated: false }
}

/**
 * The STARTING INDEX of the list window such that the CURSOR is inside it.
 *
 * We aim the cursor at the CENTER, then CLAMP to the two ends of the range.
 * "Center + clamp" is better than "only move once it's run off": opening the
 * panel SUDDENLY shrinks the window, and the lazy variant would then pin the
 * cursor to the edge (zero context in the direction of motion).
 */
function clampFirst(rowCount, cursor, visible) {
  if (visible <= 0) return 0
  const cur = Number.isFinite(Number(cursor)) ? Math.max(0, Math.floor(Number(cursor))) : 0
  const maxFirst = Math.max(0, rowCount - visible)
  const centered = cur - Math.floor(visible / 2)
  return Math.min(maxFirst, Math.max(0, centered))
}

// --- FRICTION: the absence of a review trace is FLAGGED, but NOT BLOCKING --
//
// THE USER'S PRINCIPLE (with the reasoning, verbatim): approve/merge is NOT
// blocked for lack of a review trace — only FLAGGED, and the confirmation
// text SAYS SO. The argument: "review having happened" is only a PROXY
// (hunk-comment count / a `claude -p` run having executed), and a hard gate
// would teach people to satisfy the PROXY — we'd spend tokens for a fake
// attestation trace. There are legitimate review-free approves
// (dependabot-bump, docs typo), and a `d` (hunk-diff) look-through leaves NO
// trace.
//
// WHAT IS MANDATORY, THOUGH: THE ATTESTATION MUST TELL THE TRUTH. If there
// was no trace, a SHORTER body goes up, one that does NOT claim a review
// happened (see approveBody). So the friction doesn't live in the gate, it
// lives in the STATEMENT — and the statement is verifiable, while a proxy
// gate is gameable.

/**
 * The friction lines for the confirmation modal:
 * `{ text, role, color, dim, blocking }`.
 *
 * `role` is for the view (`'notice'` = the flag, `'question'` = stating the
 * stakes); `blocking` is ALWAYS false — this is the mechanical form of the
 * hard-gate ban, so a later refactor can't "accidentally" turn it into a gate
 * without a test failing.
 *
 * COLORING (the user's 3rd principle): YELLOW is ONLY for a genuine warning
 * (cost, blockers). A missing review trace is a LEGITIMATE state, not a
 * danger — so it's dimmed, not yellow. "Confirm?" doesn't stand out either:
 * at the bottom of the frame, dimmed.
 */
export function frictionLines({ kind, hasTrace = false, stackOn = null } = {}) {
  // (wf31/21) THE TWO NOTICE LINES WERE REMOVED. The user's request, verbatim:
  // "Don't need this spoon-feeding text, take it out, let's simplify this
  // damn app, all this sloppy spoon-feeding wording is so annoying."
  //
  // WHAT WAS THERE, AND WHY IT WAS REDUNDANT:
  //     No review trace on this PR
  //     (a `d` look-through leaves no trace — if you looked it over, this isn't an error)
  //     Approving without a review trace? [y/N]
  // The THIRD line carries the same fact as the first ("without a review
  // trace"), and the SECOND explains our implementation — that `d` doesn't
  // record a trace, which the user doesn't need to know at the moment of the
  // decision. Three lines for one fact.
  //
  // WHAT STAYS, AND WHY IT'S ENOUGH: the question's TEXT is state-dependent.
  // Without a trace `Approve without a review trace?`, with a trace `Approve
  // for sure?` — so the fact stays STATED, right where the decision is made
  // too. The principle stated at the top of this module ("friction doesn't
  // live in the gate, it lives in the STATEMENT") stays INTACT: the statement
  // moved into one line, it didn't disappear.
  //
  // THE ATTESTATION DOESN'T CHANGE EITHER: `approveBody` still gives a
  // SHORTER body without a trace (doesn't claim a review happened) — that
  // contract is about the PR's audit trail, not the UI's wordiness.
  // (wf31/73) `resolve` GETS ITS OWN QUESTION: here the stake isn't the
  // "review trace" (we're not qualifying the PR), it's that we're calling AI
  // and having it write code. The question states this.
  if (kind === 'resolve') {
    // THE RETURN SHAPE IS THE SAME AS ON THE OTHER BRANCHES: an ARRAY of line
    // descriptors. MEASURED OWN BUG: returning a `{text, choices}` object —
    // the caller calls `.map()` on the return value
    // (`...frictionLines(…).map(…)`), which would throw a TypeError on an
    // object. We don't advertise the choices here: `MODAL_CHOICE_KINDS` and
    // the labels provide that, from the same source as approve/merge.
    //
    // THE TARGET COMES FROM THE PARAMETER, NOT from a `confirm` outside this
    // scope: this function receives ONLY the kind and the trace fact (pure,
    // testable) — the caller passes it in. With a missing target the question
    // stays general, it doesn't lie about a number.
    return [{
      text: stackOn === null
        ? 'AI resolution with the culprit? (spends tokens; the resolved code stays in a disposable worktree)'
        : `AI resolution with the #${stackOn} culprit? (spends tokens; the resolved code stays in a disposable worktree)`,
      role: 'question',
      dim: true,
      blocking: false,
    }]
  }
  const stake = kind === 'merge' ? 'Land' : 'Approve'
  return [{
    text: hasTrace
      // (wf31/69) THE `[y/N]` HINT WAS DROPPED — the user's finding: "it's
      // Hungarian for yes/no, while the keyboard hint is y/N." Below the
      // question sits the VISUAL chooser (`▸ No   Yes`), and the footer lists
      // the keys — so the trailing English hint was at once a duplication and
      // a language break in the Hungarian sentence. The `y`/`n` shortcut is
      // STILL live UNCHANGED (the footer advertises it).
      ? `${stake} for sure?`
      : `${stake} without a review trace?`,
    role: 'question',
    color: undefined,
    dim: true,
    blocking: false,
  }]
}

/**
 * THE ATTESTATION BODY for approve — TWO BRANCHES, and the trace-less one
 * does NOT claim a review.
 *
 * WHY THIS IS NEEDED IN THE TUI (and why the bash default isn't enough):
 * `bin/tuipr.sh`'s `cmd_approve` without `--body` posts the text
 *   "Reviewed in a tuipr session <date>"
 * This CLAIMS a review happened. Without a review trace this is a LIE in the
 * PR's audit trail — and that's precisely the core of the user's 1st
 * principle: friction isn't a hard gate because the ATTESTATION must tell the
 * truth, not because the gate must enforce the trace. So the TUI gives an
 * EXPLICIT `--body`.
 *
 * ONE LINE, deliberately: the body goes through as `gh pr review --body
 * <arg>`, in a single argument. Multi-line text (quoting, escaping, `$`
 * expansion) is fragile there, and `spawnSync`'s argv isn't a shell anyway —
 * but the bash path receives this same string too, so we hold ourselves to
 * the narrowest contract.
 *
 * MISSING DATA DOESN'T LEAK OUT: without SHA/date the corresponding tag is
 * DROPPED, not inserted as `undefined` — false precision is worse than
 * absence.
 */
export function approveBody({ hasTrace = false, traceSources = [], date = null, nextSha = null } = {}) {
  const stamp = []
  if (date) stamp.push(String(date))
  if (nextSha) stamp.push(`next @ ${nextSha}`)
  const suffix = stamp.length > 0 ? ` (${stamp.join(' — ')})` : ''
  if (!hasTrace) {
    // WITHOUT A TRACE: the body records ONLY the gesture, not that a review
    // happened. The word "Reviewed" is DELIBERATELY absent — that difference
    // is itself the honest attestation.
    return `Approve from a tuipr session${suffix}.`
  }
  // WITH A TRACE: the body claims a review, AND names the PROVENANCE. The
  // AI path and the hunk path are DIFFERENT claims — conflating them would be
  // the same bug class that `reviewBody`'s `tool` field already eliminated
  // for the findings review.
  const sources = Array.isArray(traceSources) ? traceSources : []
  const how = sources.includes('ai')
    ? sources.includes('hunk')
      ? 'claude -p AI-review + hunk inline review'
      : 'claude -p AI-review'
    : 'hunk inline review'
  return `Reviewed in a tuipr session — ${how}${suffix}.`
}

/**
 * THE PANEL'S FOOTER: THE CONTROLS AT THE BOTTOM OF THE FRAME, DIMMED.
 *
 * The user's 3rd principle: "`y/N`, budget line, review-path chooser DIMMED
 * at the bottom of the dialog; yellow ONLY for a genuine warning. The content
 * area gets the emphasis." Hence the return is `{ text, dim }` — `dim` is
 * part of the CONTRACT, not the view's discretion.
 *
 * THE ORDER is deliberate: DECISION keys up front, closing at the back. If
 * `clampCells` cuts on a narrow terminal, the decision keys survive — a
 * footer that doesn't show how to say yes is useless (same principle as in
 * `overlayFooter`; applied here to the panel modes).
 */
// (1c) THE DEFAULT rLabel IS THE SHORT FORM. WHY THE LONG ONE CAN'T STAY: if
// the caller doesn't pass a label (an old call path, a test), the footer
// would fall back to the LONG form, and the panel would advertise something
// DIFFERENT for the same key than the global footer — exactly the
// three-source drift this module's stated principle forbids. We can't call
// `rKeyLabel` here (it lives in the ai-review-view layer, which is ABOVE the
// panel: it would be an immediate cycle, which the checker forbids
// mechanically), so the default is a literal — the wording test ties the two
// together.
/**
 * @param {object} [opts]
 * @param {string} [opts.rLabel] `r`'s STATE-DEPENDENT label (see below)
 * @param {boolean} [opts.canUpload] (wf31/17) IS THERE ANYTHING TO UPLOAD.
 *   When `false`, the `f` segment DROPS OUT of the footer.
 *
 *   THE USER'S FINDING, verbatim: "the 'upload review' command shouldn't be
 *   possible while there's no review."
 *
 *   THE SAME BUG CLASS this module already states in TWO places: `↑/↓`
 *   advertised only where there's something to choose ("an advertised but
 *   non-functional arrow is a DEAD KEY"), and the same in `panelKeys`'s
 *   header ("the user couldn't tell if the button was broken or the UI had
 *   frozen"). `f` without a review was exactly this kind of dead key: the
 *   modal opened, and `doUpload` crashed with a loud error — when the action
 *   was never possible in principle.
 *
 *   THE DEFAULT IS `true`, NOT `false`: the old call paths (and the wording
 *   tests) don't pass the third parameter, and a `false` default would
 *   SILENTLY take `f` away EVERYWHERE — and a missing option is much harder
 *   to notice than a needlessly advertised one. The caller (App) MEASURES
 *   uploadability and passes explicit `false` when there isn't any.
 */
export function panelFooter(st, columns = 120, { rLabel = 'r: review', canUpload = true, stackLabel = '' } = {}) {
  const limit = Math.max(1, Math.floor(Number(columns) || 1))
  if (!st || typeof st !== 'object') return { text: '', dim: true }
  if (st.mode === 'modal') {
    const denied = (st.modal?.blockers?.length ?? 0) > 0
    if (denied) {
      return { text: clampCells('any key: back — the action is blocked', limit), dim: true }
    }
    // `↑/↓` ONLY where there IS something to choose (see MODAL_CHOICE_KINDS):
    // an advertised but non-functional arrow is a DEAD KEY — a measured bug on
    // the `f` modal.
    const parts = ['y/N: choice']
    // (wf31/69) `←/→`, NOT `↑/↓` — MATCHED TO THE DISPLAY DIRECTION.
    //
    // The user's finding: "no left/right selectability, while there's an
    // arrow character in front of 'No'". Fair: the two choices sit in ONE
    // ROW, horizontally (`▸ No   Yes`), but the stepping was up/down — the
    // eye sees the horizontal layout, the hand reaches for the vertical
    // arrow. The handler accepts BOTH directions (up/down muscle memory isn't
    // broken), but the ADVERTISEMENT is horizontal, because that matches the
    // picture.
    //
    // ENTER IS ALSO STATED: it executes the selected branch, and until now it
    // appeared nowhere — an arrow-key chooser whose finalization isn't
    // advertised is a half-finished affordance.
    if (modalHasChoices(st.modal?.kind)) parts.push('←/→: choose', '⏎: confirm')
    // (wf31/21) `Esc: back`, not `Esc: back to panel` — the user's request.
    // "Where to" is visible on screen anyway (the panel sits below the
    // modal), and the other Esc labels don't name the destination either
    // (`Esc: close`, `Esc: back`).
    parts.push('Esc: back')
    return { text: clampCells(parts.join(' · '), limit), dim: true }
  }
  // INLINE: advertising the FIVE ACTIONS — this is the refactor's visible
  // result (the steps are inside the panel; point 3 also asks for the UPLOAD
  // offer here). Navigation and closing come after: if it cuts, the ACTIONS
  // survive, because j/k and Esc are muscle memory anyway.
  //
  // `r`'s label is STATE-DEPENDENT (rKeyLabel): the caller passes it in,
  // because the footer builder can't see the aiReview state from here — the
  // default is the idle-state 'r: AI-review'.
  // (wf31/6) THE WORDING: `f: upload review`, not `f: upload`. The user's
  // finding, verbatim: "'upload' isn't informative enough. Should be 'upload
  // review'." Plain "upload" doesn't say WHAT goes up — and this button is an
  // EXTERNALLY VISIBLE, IRREVERSIBLE action (a review appears on the PR under
  // the user's name, the author gets notified), so this is exactly where a
  // misunderstanding is most expensive. The confirmation modal's heading
  // (`upload`) says the same thing.
  //
  // (wf31/5) EMPTY SEGMENTS DROP OUT. While a review is running, `rLabel` is
  // EMPTY (the `running` branch of `rKeyLabel` — see the reasoning there),
  // and an empty segment in a naive `join(' · ')` would leave a DANGLING
  // SEPARATOR PAIR (`d: diff ·  · f: …`): that breaks the frame's typography
  // too, and gives an "an option vanished" feeling. The filtering lives HERE,
  // at the ASSEMBLY POINT — `rKeyLabel` only decides WHETHER there's a label,
  // not how we join them.
  // (wf31/17) `f` ONLY WHEN THERE'S SOMETHING TO UPLOAD — the empty string
  // drops out on the filter below, the same EXISTING path as the running
  // review's `rLabel`.
  // (wf31/30) `⏎` IS ALSO ADVERTISED: the user's request ("Enter should be in
  // the info legend too"). The UNICODE GLYPH (`⏎` U+23CE, 1 cell — MEASURED),
  // not the word "Enter": the footer is the narrowest surface, and the glyph
  // frees up 5 cells compared to the textual form. The user asked for it this
  // way ("In the legend, instead of 'Enter' there should be the Enter
  // character, it has a unicode glyph").
  // (wf31/53) STACKING AFTER MERGE, BEFORE NAVIGATION: the end of the ACTIONS
  // block. It only gets a label when the MEASUREMENT gave an offer
  // (`offerStack`) — a permanently advertised `s` would be a dead key on most
  // PRs, and would bring back exactly the bug class that `f`'s conditionality
  // eliminated. The empty string drops out on the filter below, the same
  // EXISTING path.
  const parts = ['d: diff', rLabel, canUpload ? 'f: upload review' : '', 'a: approve', 'm: merge',
    stackLabel, 'j/k: row', '⏎/Esc: close']
    .filter((p) => String(p ?? '').trim() !== '')
  return { text: clampCells(parts.join(' · '), limit), dim: true }
}

// === END OF PANEL ============================================================
