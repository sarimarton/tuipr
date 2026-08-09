// tuipr — REVIEW-MENU: the HORIZONTAL, CASCADED sub-option menu for `r`.
//
// THIS MODULE REPLACES THE OLD AI-REVIEW CONFIRMATION MODAL. The user's
// literal complaint: "the review dialog is some bloated thing, that dialog
// should go away. Its content is also needlessly verbose. Review is a user
// path, and it should just be a cascaded horizontal menu at the bottom of
// the info dialog."
//
// WHAT FOLLOWS FROM THIS, AND WHAT DOESN'T:
//   - GONE: the yellow/orange-bordered AI-review overlay, the summary lines
//     (PR size, scope, excluded file NAMES, explanatory paragraphs), the
//     review-path-picker LIST with its notes, the verbose forms of
//     `modelLine`/`budgetLine`, the "Confirm? [y/N]" line;
//   - STAYS: the INFO PANEL with its OWN frame color (cyan), and every
//     BEHAVIORAL invariant — the dwell gate (armedAt) on the first `y`, the
//     BAN on toggles re-arming it, the fail-closed ban on budget leakage, and
//     that the token-spending `claude -p` starts ONLY from the confirmation.
//
// THE OTHER THREE CONFIRMATIONS (approve / merge / upload) ARE UNCHANGED:
// their `modalHasChoices`-based arrow modals carry the friction decision that
// the user did NOT ask to have reworked. The split is CLEAN because the modal
// path branches on `kind`: the `ai-review` kind simply NO LONGER OPENS
// (`askAiReview` opens the menu instead of a modal), and the other three
// branches are byte-for-byte the old code.
//
// LAYER ORDER: imports downward (layout: cell-based measurement and cyclic
// stepping; ai-review-config: the review paths, models, and budget tiers'
// VISIBLE lists + their steppers). Imports NOTHING from the panel or above it
// — scripts/check-next-modules.mjs enforces this mechanically.
import { clampCells, displayWidth, stepIndex } from './layout.mjs'
import {
  AI_REVIEW_MODELS,
  BUDGET_STEPS_USD,
  REVIEW_PATHS,
  aiReviewModelState,
  modelStep,
} from './ai-review-config.mjs'

// === MENU STATE ==============================================================

/**
 * THE NAMES OF THE TWO STAGES. As a constant, because we read it in three
 * places (stepping, row-building, the back-navigation branch), and a
 * mistyped string literal would be a SILENT behavior change (the
 * `stage === 'confim'` branch would never run).
 */
export const REVIEW_MENU_STAGES = ['options', 'confirm']

/**
 * THE BUDGET RING in the menu: `off → 3 → 5 → 10 → off`.
 *
 * WHY NOT THE `budgetToggle`/`budgetStep` PAIR (which the old modal used):
 * that had TWO keys (`b` toggles, `←/→` steps through the full five-item
 * list), whereas the user asked for ONE cyclic `b`, with FOUR stops. The
 * tiers come FILTERED from the core's VISIBLE `BUDGET_STEPS_USD`, not
 * re-entered: if the list changes, the menu follows, and can't drift apart
 * from the call path.
 *
 * THE CHOSEN THREE (3/5/10) are the TOP end of the list: 1 and 2 USD would
 * cut an agent-fanned-out review HALFWAY THROUGH (the tokens spent, no
 * findings) — exactly the "worse than running with no cap" case the
 * ai-review-config budget chapter spells out. So the menu doesn't offer them.
 */
const MENU_BUDGET_USD = BUDGET_STEPS_USD.filter((usd) => usd >= 3)

/**
 * Opening the menu at the FIRST stage — the `r` key.
 *
 * `armedAt` is the dwell gate's anchor (read by the core's `confirmAccepts`).
 * It's born HERE, at OPENING TIME, not during render: the dwell measures how
 * long the decision has been in front of the user's eyes, and a timestamp
 * taken during render would restart on every re-render — the typeahead guard
 * would be a silent no-op. (Same argument that governs `panelToModal`; the
 * mechanism applies UNCHANGED to the menu, because it's the same spend
 * decision.)
 *
 * FAIL-CLOSED for an invalid anchor: we do NOT default to `Date.now()`. A
 * made-up timestamp would claim the gate measured something when the caller
 * forgot to measure — and `confirmAccepts` stays CLOSED for a non-number
 * anchor anyway, so the bug is LOUD (the `y` won't go through), not silent.
 */
export function reviewMenuOpen({ armedAt, modelEnv, budgetEnv } = {}) {
  const model = aiReviewModelState({ env: modelEnv })
  return {
    stage: 'options',
    armedAt,
    // The default is the CI-BIT-IDENTICAL `agent-review` — the existing core
    // decision (REVIEW_PATHS `default: true`), just mirrored here. The
    // `Math.max(0, …)` is the fail-soft: if the flag ever vanished from the
    // list, we'd fall to the FIRST path, not a -1 index (which would give an
    // `undefined` path, i.e. a silently lost choice).
    pathIndex: Math.max(0, REVIEW_PATHS.findIndex((p) => p.default)),
    model,
    // The budget's STARTING VALUE comes from env, BUT NORMALIZED to the
    // menu's four-stop ring: a 1 USD value from env wouldn't be in the ring,
    // so the first `b` press would land somewhere unpredictable.
    budget: normalizeBudget(budgetEnv),
  }
}

/**
 * The cap from env, normalized to the MENU's ring.
 *
 * The filtering is FAIL-CLOSED toward DISABLED (same principle as in
 * `aiReviewBudgetState`): whatever isn't one of the menu's tiers is NOT a
 * choice. A "preserved but off-ring" number would make `b` stepping
 * unpredictable, and a leaked `usd` could cause `--max-budget-usd` to go out
 * silently.
 */
function normalizeBudget(env) {
  const n = Number(env)
  if (Number.isFinite(n) && MENU_BUDGET_USD.includes(n)) return { enabled: true, usd: n }
  return { enabled: false, usd: undefined }
}

/**
 * The `r` key on the menu: TOGGLE. Closes (null) an open menu, opens a closed
 * one.
 *
 * WHY IT'S ITS OWN INVERSE: `r` is the menu's advertised key, and it STAYS in
 * place in the footer row while the menu is open — if a second `r` didn't
 * close it, pressing the same key again would produce no change (the "is the
 * button broken or did the UI freeze?" uncertainty this project bans
 * elsewhere too).
 *
 * `null` IS the close: ONE state becomes null, so an ORPHAN MENU can't remain
 * (same contract as `panelClose`).
 */
export function reviewMenuToggle(st, { armedAt } = {}) {
  if (st && typeof st === 'object') return null
  return reviewMenuOpen({ armedAt })
}

/**
 * THE CYCLIC TOGGLES: `tab` (review path), `m` (model), `b` (budget).
 *
 * WE DON'T TOUCH `armedAt` HERE — this is an EXISTING INVARIANT, and the most
 * important one this module must not break. If the toggles re-armed, the
 * 250 ms dwell would keep restarting FOREVER as `tab`/`m`/`b` are pressed,
 * and the typeahead guard would become bypassable via exactly the path we
 * just added. (The old modal's three separate key branches stated this same
 * thing in three places; here it's in ONE function, so it can't drift apart.)
 *
 * ONE ENTRY POINT FOR ALL THREE, deliberately: in separate functions the
 * armedAt handling could drift apart (one arms, the other doesn't — and the
 * dwell gate is exactly what would become bypassable that way). The stepping
 * goes through the TESTED `stepIndex`, not an inline modulo.
 */
export function reviewMenuStep(st, what, delta = +1) {
  if (!st || typeof st !== 'object') return st
  // THE TOGGLES ARE DEAD ON THE SECOND STAGE: there, only yes/back remain
  // (the menu row doesn't advertise them either). A silent step there would
  // mean the user starts with a DIFFERENT parameter than what they SAW on the
  // second stage.
  if (st.stage !== 'options') return st
  if (what === 'path') {
    return { ...st, pathIndex: stepIndex(st.pathIndex, REVIEW_PATHS.length, delta) }
  }
  if (what === 'model') {
    // The core's `modelStep` is the yardstick (cycles through the VISIBLE
    // list, and steers a list-foreign env name to the default) — we don't
    // rewrite it.
    return { ...st, model: modelStep(st.model, delta) }
  }
  if (what === 'budget') {
    return { ...st, budget: budgetCycle(st.budget, delta) }
  }
  return st
}

/**
 * The budget's FOUR-STOP ring: `off → 3 → 5 → 10 → off`.
 *
 * In the DISABLED state, `usd` DISAPPEARS — not a "preserved but inactive"
 * value. This is the existing argv-guard invariant: an inactive number on
 * the call path is exactly the leak the `budgetArgs` test bans
 * (`--max-budget-usd` disabled doesn't even MAKE IT into argv).
 */
function budgetCycle(state, delta = +1) {
  // The ring's stops: `null` is OFF, then the tiers. We step over an array so
  // the wrap gets `stepIndex`'s TESTED contract (cycles around, normalizes a
  // degenerate index first) — without it, my own modulo would be a separate
  // bug class.
  const ring = [null, ...MENU_BUDGET_USD]
  const cur = state?.enabled === true ? ring.indexOf(Number(state.usd)) : 0
  const usd = ring[stepIndex(cur >= 0 ? cur : 0, ring.length, delta)]
  if (usd === null) return { enabled: false, usd: undefined }
  return { enabled: true, usd }
}

/**
 * STEPPING `y` — the state machine for the TWO STAGES.
 *
 * The return is `{ action, state }`, and `action`'s THREE values are the
 * caller's contract:
 *   - `'advance'` — moved to the SECOND stage (there's a warning). Nothing
 *     starts.
 *   - `'run'` — WE START. `state` is null, so the menu CLOSES.
 *   - `'noop'` — invalid input; fail-closed, we do NOT start.
 *
 * WITHOUT A WARNING THE FIRST `y` STARTS IMMEDIATELY (the user's mandate): an
 * EMPTY second stage — "confirm that… nothing" — is exactly the
 * content-free friction this whole rework eliminates.
 *
 * THE SECOND STAGE GETS NO NEW dwell anchor. The user's mandate: "the
 * DWELL GATE STAYS on the first `y`". A fresh arm here would also put
 * 250 ms in front of the second `y`, which nobody asked for — and it
 * wouldn't protect any better against a buffered double-`y` either, since
 * the FIRST `y` already passed the gate (i.e. the screen was already in
 * front of the user's eyes).
 */
export function reviewMenuAdvance(st, { warning = null } = {}) {
  if (!st || typeof st !== 'object') return { action: 'noop', state: st ?? null }
  if (st.stage === 'confirm') return { action: 'run', state: null }
  const w = typeof warning === 'string' && warning.trim() !== '' ? warning : null
  if (w === null) return { action: 'run', state: null }
  // `armedAt` travels forward UNCHANGED (see above), but the warning's TEXT
  // goes into the state: the second stage's row prints it, so the DISPLAYED
  // text and the text that TRIGGERS the decision come from one source.
  return { action: 'advance', state: { ...st, stage: 'confirm', warning: w } }
}

/**
 * `Esc`: CLOSES (null) on the FIRST stage, STEPS BACK to the first on the
 * SECOND.
 *
 * The user's words: "Esc: back". Stepping back from the second stage KEEPS
 * THE CHOICES (`pathIndex`/`model`/`budget`) — the user already set them,
 * and a change-of-mind gesture must not discard their work (same principle
 * why the old modal's Esc stepped back to the info panel, not to the list).
 *
 * The `warning`'s TEXT, though, DISAPPEARS: it comes from a MEASUREMENT
 * (`reviewPathWarning` off the fresh file list), so a copy kept in state
 * could go stale. The next `y` asks again.
 */
export function reviewMenuBack(st) {
  if (!st || typeof st !== 'object') return null
  if (st.stage !== 'confirm') return null
  const { warning: _dropped, ...rest } = st
  return { ...rest, stage: 'options' }
}

/**
 * THE SELECTION for the call path: `{ reviewPath, model, maxBudgetUsd }`.
 *
 * The VALUES SEEN IN THE MENU pass through, not a recomputation — this is
 * the old modal's contract, UNCHANGED: "the user gets EXACTLY the model the
 * model row showed." If the runner defaulted from somewhere else, the
 * displayed and the live parameter could drift apart, and the user would run
 * on a DIFFERENT (more expensive) tier than what they saw — the measured
 * finding that the entire model picker was born from.
 *
 * `maxBudgetUsd` DISABLED is `undefined`, so the core's `budgetArgs` doesn't
 * even SEND the flag (fail-closed toward OMITTING the flag).
 */
export function reviewMenuSelection(st) {
  const pathIndex = Number.isInteger(st?.pathIndex) ? st.pathIndex : 0
  return {
    reviewPath: REVIEW_PATHS[pathIndex]?.id ?? REVIEW_PATHS[0].id,
    model: st?.model?.id ?? AI_REVIEW_MODELS[0].id,
    maxBudgetUsd: st?.budget?.enabled === true ? st.budget.usd : undefined,
  }
}


// === THE WARNING'S COMPACT FORM =============================================

/**
 * The SECOND stage's warning row, or `null` (nothing to warn about).
 *
 * The user's example, LITERALLY this form:
 *     35 files, +3280/-508 lines — large PR, consumes a lot of tokens
 *
 * WHY NOT THE EXISTING `reviewPathWarning`: that's the OLD DIALOG's verbose
 * line ("WARNING — COST: 35 files (> 30) and 3788 diff lines (> 2000). The
 * review paths are agent-fanned-out, so token spend at this size is already
 * significant, and reading through the findings will take a while." = 200+
 * CELLS) — that doesn't fit in a single menu row on ANY terminal, and it's
 * exactly the "needlessly verbose" content the user replaced. The
 * THRESHOLDS, though, come from there UNCHANGED: `reviewPathWarning` is the
 * MEASURE (>30 files OR >2000 lines), this function only compresses the
 * DISPLAY. Two threshold sources is exactly the kind of drift this project
 * bans elsewhere too — so the caller hands over the decision.
 *
 * THE MEASURED NUMBERS ARE IN IT (file count + both churn directions): a
 * generic "this is a large PR" isn't auditable, and the user wouldn't know
 * HOW large. This is the principle stated in `reviewPathWarning`'s header,
 * kept in compact form.
 */
export function reviewMenuWarning({ fileCount = 0, additions = 0, deletions = 0, large = false } = {}) {
  if (large !== true) return null
  return `${fileCount} files, +${additions}/-${deletions} lines — large PR, consumes a lot of tokens`
}


// === MENU ROWS ===============================================================

/**
 * The menu row's SEPARATOR — the user's request: horizontal, with `·`.
 * Together with the surrounding spaces it's 3 CELLS; the degradation
 * accounts for that.
 */
const SEP = ' · '

/**
 * The `r: review` FOOTER LABEL and its POSITION ANCHOR.
 *
 * The user's spec: "the review legend should keep its position (i.e. there
 * should be a gap where d: diff was)." `d: diff · ` is the FIRST segment of
 * the normal `panelFooter`'s INLINE branch, so the anchor's width measured
 * in CELLS is exactly that.
 *
 * WHY HERE, AS A CONSTANT, AND WHY NOT COMPUTED FROM `panelFooter`:
 * `panelFooter` lives in the PANEL module, which is ABOVE this layer (the
 * panel is the topmost core layer) — calling it would be an IMMEDIATE cycle,
 * which the checker bans mechanically. Same situation as stated at
 * `panelFooter`'s `rLabel` default; the BINDING is done by the TEST in both
 * places (next-review-menu.test.ts COMPUTES the expected column from
 * `panelFooter`'s actual output, so a drift fails).
 */
const R_ANCHOR_PREFIX = 'd: diff · '

/**
 * (wf31/7) THE ANCHOR'S MARKER — `▸` plus a space, which SITS IN the
 * prefix's LAST TWO CELLS (doesn't add to it).
 *
 * `displayWidth('▸') === 1`: U+25B8 (BLACK RIGHT-POINTING SMALL TRIANGLE) is
 * NOT in `WIDE_RANGES`, so it's one cell — the cell arithmetic (and with it
 * `r: review`'s column position) is UNCHANGED. `▸` is the TEXT form, not the
 * emoji: the emoji variant would be 2 cells, which would break exactly the
 * position invariant (a measured bug class — see the `⚠` vs `⚠️` decision in
 * the render module).
 *
 * WHY NOT `▶`/`>`/`*`: `▸` is the project's EXISTING "this is the selected
 * one" glyph — the review-path picker and the modal's yes/no choice also use
 * IT (`tui-render.mjs`), so the user's eye has already learned it. A second
 * marker for the same concept would open a new vocabulary.
 */
const R_ANCHOR_MARK = '▸ '

/**
 * The menu's ROW DESCRIPTORS — the app's render tree is built from these.
 *
 * The return is an array of `{ key, text, color?, dimColor?, segments? }`
 * rows, the same shape used by the panel's other row builders
 * (`aiReviewPanelLines`, `frictionLines`) — so the render's `renderLines`
 * consumes it unchanged.
 *
 * THE TWO ROWS (per the user's MODIFIED spec):
 *   [0] the FOOTER: a SPACE-gap where `d: diff` was, then `r: review` in the
 *       same display CELL where it stood in the normal footer;
 *   [1] the MENU ROW, DIRECTLY below it, horizontal, with a `·` separator.
 *
 * (wf28/3) THE BLANK ROW REMOVED. The user's amendment request, verbatim:
 * "there shouldn't be a blank row between the review legend and the second
 * menu row. This is a change request from me, because I originally asked
 * for a blank row, but it turned out to be more distracting than not."
 * In live testing the gap turned out to be noise, not breathing room — and
 * it had a SIDE EFFECT too: it pushed the menu row down by a row, so the
 * `r: review` anchor's position no longer matched the normal footer (the
 * "positional anchor" feel that the wf28/1 finding also protected).
 */
export function reviewMenuLines(st, { innerWidth = 100 } = {}) {
  if (!st || typeof st !== 'object') return []
  const W = Math.max(1, Math.floor(Number(innerWidth) || 1))
  // THE FOOTER: the gap is a SPACE (not a dot, not a line) — the user's word
  // was "gap". `clampCells` is the fail-soft: at a very narrow measure the
  // anchor prefix itself could be consumed entirely, and then the label
  // would start at column 0. The ALTERNATIVE (keeping the prefix at the cost
  // of LOSING the label) is worse: a menu with no header row doesn't say
  // WHAT it's about.
  //
  // (wf31/7) THE ANCHOR GETS A THREE-LAYER HIGHLIGHT: `▸` + cyan + bold.
  //
  // THE USER'S FINDING, verbatim: "I think the top-level »r: review« as the
  // sole item should get some kind of highlight, because although the
  // pattern is good, the user still doesn't notice that an item was selected
  // there, and that we're looking at its submenu."
  //
  // THE MEASURED CAUSE: this row was `dimColor: true` — EXACTLY as dim as
  // EVERY segment of the menu row below it. Zero contrast: the "selected"
  // anchor carries the same semantic weight as ITS CONTENT, so the eye
  // doesn't find the hierarchy. The project uses a THREE-LAYER marker
  // elsewhere for the same concept (the list cursor: glyph + color + bold,
  // everything else dim) — so this isn't a new vocabulary, just applying the
  // existing idiom.
  //
  // THE GLYPH SITS IN THE PREFIX'S CELL, DOESN'T ADD TO IT. This is the
  // proven pattern from `╰─` (`rows.mjs`: "the marker SITS IN the indent's
  // LAST TWO CELLS, doesn't add to it"): `displayWidth('▸') === 1`, so
  // `8 spaces + '▸ '` is EXACTLY as many cells as the `'d: diff · '` prefix —
  // the POSITION INVARIANT (`r: review` sits in the same column as in the
  // normal footer) stays INTACT, and we load the narrow terminal with ZERO
  // extra cells.
  //
  // CYAN, NOT GREEN: there's no "we measured it, and it's fine" claim here,
  // and inflating green is a declared bug class (see the render module's
  // Verdict block). Cyan is the info panel's frame color and the list
  // cursor's color — the "focus / active axis" reading is established.
  const labelText = clampCells(`${' '.repeat(displayWidth(R_ANCHOR_PREFIX) - displayWidth(R_ANCHOR_MARK))}${R_ANCHOR_MARK}r: review`, W)
  // FAIL-SAFE (MANDATE): at a very narrow measure `clampCells` could consume
  // the prefix too. If the `▸` SURVIVES but the `r: review` label is LOST, a
  // LONE ARROW would LIE that something is selected — without saying WHAT.
  // `╰─` has a fail-safe for the same case (`rows.mjs`). THE RULE: the marker
  // lives or dies TOGETHER WITH THE LABEL — if the label doesn't fit, the
  // glyph goes too, and the leftover space goes to the label fragment (the
  // more informative choice).
  const marked = labelText.includes('r: review')
    ? labelText
    : clampCells('r: review', W)
  // (wf28/3) NO GAP ROW. Emptying its text isn't enough: an empty row
  // descriptor would still take up the same HEIGHT in the render tree (and
  // `menuExtraRows`'s estimate would also reserve one row more than we
  // render) — so the row is NEVER BORN in the first place.
  //
  // (wf31/7) `dimColor` DISAPPEARED from this row (the menu row's segments
  // STAY dim) — the contrast runs both ways: the anchor is highlighted, its
  // content is quiet.
  const out = [
    { key: 'rm-label', text: marked, color: 'cyan', bold: true },
  ]
  if (st.stage === 'confirm') {
    // THE SECOND STAGE: the warning in RED (the user: "(in red)"), then the
    // two keys. THE TOGGLES DISAPPEAR — there's nothing left to set there,
    // only yes/back.
    out.push({
      key: 'rm-menu',
      // `segments` are the COLORED sections: the warning is red, the keys
      // are dimmed. `text` is the whole row (the width test and the frame
      // assertions measure THIS) — both are built from the same segment
      // list, so they can't drift apart.
      ...joinSegments(
        [
          { text: String(st.warning ?? ''), color: 'red', prio: 0 },
          { text: 'y: confirmation', dimColor: true, prio: 1 },
          { text: 'Esc: back', dimColor: true, prio: 2 },
        ],
        W,
      ),
    })
    return out
  }
  // THE FIRST STAGE: ONLY THE CURRENT VALUE shows on each toggle (the user's
  // clarification). The old modal listed the FULL set of choices with their
  // notes — exactly the "needlessly verbose" content this replaced.
  //
  // THE DEGRADATION RANK (the `prio` field) — AND ITS RATIONALE:
  //   0. `y: confirmation` and 1. `Esc: back` — FIRST, these. A menu that
  //      doesn't show how to say yes or how to step back is UNUSABLE (same
  //      principle stated in `overlayFooter`'s header);
  //   2. `tab: review path` — the CONSEQUENTIAL choice (CI-matching vs.
  //      different rules), so of the toggles this is the most important;
  //   3. `m: model` — the BIGGER cost lever (in the measured finding, one
  //      Fable run wiped out the user's entire session budget);
  //   4. `b: budget` — the least important: `--max-budget-usd`'s effect
  //      under subscription is UNCERTAIN (see the ai-review-config budget
  //      chapter), so this one goes FIRST.
  //
  // THE PRINT ORDER, though, follows the user's example (tab · m · b · y ·
  // esc) — `prio` only decides WHAT GOES FIRST, not where anything stands.
  const path = REVIEW_PATHS[Number.isInteger(st.pathIndex) ? st.pathIndex : 0] ?? REVIEW_PATHS[0]
  out.push({
    key: 'rm-menu',
    ...joinSegments(
      [
        { text: `tab: review-path (${pathValueLabel(path)})`, dimColor: true, prio: 2 },
        { text: `m: model (${st.model?.id ?? AI_REVIEW_MODELS[0].id})`, dimColor: true, prio: 3 },
        { text: `b: budget (${budgetValueLabel(st.budget)})`, dimColor: true, prio: 4 },
        { text: 'y: confirmation', dimColor: true, prio: 0 },
        { text: 'Esc: back', dimColor: true, prio: 1 },
      ],
      W,
    ),
  })
  return out
}

/**
 * The review path's SHORT value — per the user's example `agent-review`, or
 * `/code-review`.
 *
 * WHY NOT `label`: that's the LONG, explanatory form ("agent-review (6
 * skill-delegated sweeps, bit-identical to CI)") — that's the old dialog's
 * verbosity. In the menu the IDENTIFIER is enough: whoever's pressing the
 * menu keys knows what they're picking.
 */
function pathValueLabel(path) {
  // `agent-review` → `agent-review` from the user's example; the other path
  // shows in its OWN slash-command form (`/code-review`), because that's
  // exactly the recognizable name there.
  if (path?.id === 'agent-review') return 'agent-review'
  return path?.command?.split(' ')[0] ?? String(path?.id ?? '?')
}

/** The budget's value: `off`, or the tier in USD (the user's example: `(off)`). */
function budgetValueLabel(budget) {
  if (budget?.enabled !== true) return 'off'
  return `${budget.usd} USD`
}

/**
 * HORIZONTAL JOINING OF THE SEGMENTS, sized to CELLS — `{ text, segments }`.
 *
 * THE DECISION AND ITS RATIONALE (the task's explicit ask): the menu row in
 * the MEASURED worst case
 *     'tab: review-path (/code-review) · m: model (sonnet) · b: budget (10 USD) · y: confirmation · Esc: back'
 * = **101 CELLS**. `overlayFrame`'s inner width is **54** at 60 columns,
 * **94** at 100 columns — so naive concatenation overflows BOTH. There were
 * two paths:
 *
 *   (A) WRAP onto multiple rows (`wrapCells`), or
 *   (B) GRADUAL DEGRADATION: the least important segment DROPS (the pattern
 *       of `listLayout`'s tail degradation).
 *
 * I CHOSE (B), for three reasons:
 *   1. The user EXPLICITLY asked for ONE row ("a cascaded HORIZONTAL menu").
 *      A wrapped, two-to-three-row menu isn't that anymore — and it would
 *      grow back exactly as a response to the "bloated" complaint.
 *   2. THE PANEL'S HEIGHT IS FINITE, and `panelViewport` gives at the LIST's
 *      expense: on a narrow terminal a wrapped menu would take ROWS away
 *      from the queue list, which is the decision's context (the
 *      `PANEL_MIN_LIST_ROWS` chapter protects exactly this).
 *   3. THE DROPPED SEGMENT IS NO LOSS: `tab`/`m`/`b` are CONVENIENCE
 *      toggles — the default (agent-review / opus / off) works and STARTS
 *      without any of the three. `y`/`esc`, though, ARE the decision itself,
 *      so those go LAST (`prio` 0 and 1).
 *
 * WHAT I DIDN'T do: degrading to SHORTER LABELS (`tab: path (agent-review)`
 * → `t:agent`). That's ciphering — the user asked for TODAY's readable form,
 * and a half-decipherable menu is worse than one segment fewer.
 *
 * DROPPING FROM THE TAIL ISN'T ENOUGH on its own: `y`/`esc` sit at the
 * row's END (per the user's example), so plain tail-truncation would take
 * away exactly the most important part. That's why the `prio` field decides
 * WHAT drops, and what REMAINS assembles in its PRINT order.
 */
function joinSegments(segments, width) {
  const W = Math.max(1, Math.floor(Number(width) || 1))
  // THE STAGES: drop the least important segment first, and RE-MEASURE after
  // each stage. The loop ALWAYS terminates: in the worst case a single
  // segment remains, and `clampCells` cuts that one to the measure.
  const byPrio = [...segments].filter((s) => String(s.text ?? '').trim() !== '')
  const order = [...byPrio].sort((a, b) => (b.prio ?? 0) - (a.prio ?? 0))
  let dropped = 0
  for (;;) {
    const keep = byPrio.filter((s) => !order.slice(0, dropped).includes(s))
    const text = keep.map((s) => s.text).join(SEP)
    if (displayWidth(text) <= W || keep.length <= 1) {
      // EVEN THE LAST SEGMENT can overflow at a very narrow measure (e.g. 10
      // cells). In that case we cut to CELLS — `clampCells` is codepoint-
      // based, so it won't split a surrogate pair in half, and the frame
      // won't fall apart. THE TRUNCATION here is silent, BUT not dishonest:
      // `y`/`esc` are the shortest segments, so on a terminal this narrow the
      // user isn't reading the menu anyway.
      const clamped = clampCells(text, W)
      return {
        text: clamped,
        // `segments` is for COLORING: if `clampCells` cut it, we do NOT emit
        // the segments (the render prints `text` with one color) — otherwise
        // the segments' sum would be LONGER than `text`, and Ink would wrap.
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
