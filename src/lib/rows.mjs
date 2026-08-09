// tuipr — ROWS: the queue model and row layout.
//
// `queue --json` → displayable rows (transitive stacking, flags, status
// mark), plus measuring row width / the title budget.
//
// LAYER ORDER: imports downward (layout: cell measurement; cache: the list
// indicator and review-trace glyphs). Imports NOTHING from core or above it.
//
// The MARKS/RMARKS constants live HERE, because their ONLY consumer is the
// buildRows/flagsFor branch. (In core, the declaration and the `export` sat
// apart at the two ends of the file — the name needs to live in one place
// with its usage.)
import { cacheIndicatorFlag, reviewTraceFlag } from './cache.mjs'
import { displayWidth } from './layout.mjs'

// --- The status labels and colors (the list view's queue_mark_def counterpart) --
//
// One source on the TUI side: the label and the color per state. The width
// does NOT need to be declared here — Ink's Box/Text measures the layout
// itself, unlike bash's printf, which counts in bytes.
// ICON SEMANTICS: the up arrow (⬆️) EXCLUSIVELY means stacking, and appears
// only on flagsFor()'s stacked branch. It used to also be the queue mark
// ("⬆️ in queue"), and since every row of next is queue-tagged, the arrow sat
// on every row — so it distinguished nothing. Queue membership therefore gets
// a neutral filled circle (● U+25CF, 1 cell); the filled/empty contrast is
// deliberate: filled = it is in the queue, empty (○, RMARKS) = awaiting
// approval.
const MARKS = {
  queue: { label: '● in queue', color: 'green' },
  conflict: { label: '⚠️ conflict', color: 'yellow' },
  blocked: { label: '⛔ blocked', color: 'red' },
  missing: { label: '❓ missing', color: 'yellow' },
  draft: { label: 'draft (skipped)', color: 'gray' },
  // (wf31/25) OPTIMISTIC END STATES — the result of OUR OWN action, not from
  // a GitHub query.
  //
  // WHY THIS IS NEEDED (a measured finding, the user's #895 case): `gh pr
  // merge` returned exit 0, `reload()` RAN, and the PR STILL stayed on the
  // list — because GitHub's GraphQL INDEX updates asynchronously, so in the
  // SECONDS after the merge, `gh pr list --state open` STILL gives the old
  // state. So the user saw a row as "in queue" that they themselves had
  // merged seconds earlier.
  //
  // THE FIX IS OPTIMISTIC, AND THIS IS DELIBERATE: we KNOW the result of our
  // own action (exit 0), so we don't ask back the API that's currently
  // lagging. The user's decision: "ok, make it optimistic, but don't remove
  // it from the list, instead set its state to merged and dim it. The user
  // can clear it out with reload anyway."
  //
  // WHY WE DON'T REMOVE IT FROM THE LIST: the row disappearing would also
  // move the cursor, and the user would lose context ("what happened?"). The
  // dimmed `merged` row STATES the outcome, and stays in place until the
  // user (or the poll) refreshes.
  merged: { label: '✔ merged', color: 'gray' },
}

const RMARKS = {
  approved: { label: '✔ approved', color: 'green' },
  changes: { label: '✗ changes requested', color: 'red' },
  can_approve: { label: '○ you can approve', color: 'cyan' },
  waiting: { label: '○ awaiting approval', color: 'gray' },
}


/** The rmark key (approve column) for a row of queue --json, or null. */
function rmarkKey(r) {
  if (r.stackedOn !== null && r.stackedOn !== undefined) return null
  if (r.isDraft || r.state === 'draft') return null
  if (r.reviewDecision === 'APPROVED') return 'approved'
  if (r.reviewDecision === 'CHANGES_REQUESTED') return 'changes'
  return r.canApprove ? 'can_approve' : 'waiting'
}

/**
 * The META-FLAGS (review trace + cache status) are appended to the END of
 * the flag band.
 *
 * THE ORDER IS NOT ARBITRARY: the content flags (dep / conflict / landable)
 * carry the DECISION, the meta-flags are just metadata about the
 * measurement/review. Metadata must not push right the thing the user reads
 * the row for — and on a narrow terminal, tail degradation also drops the
 * END first, so the least important flag falls off first.
 */
/**
 * (wf31/72) THE ROW FLAG FOR A RUNNING ACTION — on the row left behind.
 *
 * The user's request: "the pending approve should also show up in the table,
 * so when I navigate away, I can see that the old row is pending."
 *
 * WHY THIS IS NEEDED AT ALL: until now, pending lived EXCLUSIVELY in the
 * legend (wf31/45), which sits at the BOTTOM OF THE SCREEN, independent of
 * the cursor. As long as navigation was disabled during a running action,
 * this was enough — the user was standing right where the action ran. But
 * since wf31/72 YOU CAN NAVIGATE AWAY, and from then on the legend no longer
 * says WHICH row it's running on: the indicator needs to stick to the ROW.
 *
 * THE LABEL NAMES THE ACTION (`⏳ approve…`), not just that it's "working": on
 * a row left behind, "what's it working on" is the real question — the user
 * left precisely because they're dealing with something else.
 *
 * THE COLOR IS CYAN, like the review spinner's: both signal work IN
 * PROGRESS, and per the project's color code cyan is for activity (yellow is
 * for warnings, green is for the approve column).
 */
const PENDING_ROW_LABELS = {
  a: '⏳ approve…',
  m: '⏳ merge…',
  f: '⏳ uploading review…',
  d: '⏳ hunk…',
  s: '⏳ stacking…',
}

export function pendingActionFlag(key) {
  const label = typeof key === 'string' ? PENDING_ROW_LABELS[key] : undefined
  return label === undefined ? null : { label, color: 'cyan' }
}

function appendMetaFlags(flags, { cacheState: state, hasTrace, spinnerFrame, pendingKey }) {
  // THE RUNNING ACTION AT THE FRONT OF THE META-FLAGS: in time this is the
  // freshest fact about the row, and tail degradation drops the END first —
  // so pending stays visible the LONGEST. (Same argument as why the spinner
  // is also at the front.)
  const pending = pendingActionFlag(pendingKey)
  if (pending) flags.push(pending)
  // THE SPINNER UP FRONT among the meta-flags: activity happening RIGHT NOW
  // comes before the past trace/measurement status, in time. A 1-cell
  // Braille glyph (MEASURED), driven by the ticker's frame index — there is
  // NO separate timer (point 4's stipulation).
  if (spinnerFrame !== undefined && spinnerFrame !== null) flags.push(reviewSpinnerFlag(spinnerFrame))
  const trace = reviewTraceFlag(hasTrace)
  if (trace) flags.push(trace)
  const cached = cacheIndicatorFlag(state)
  if (cached) flags.push(cached)
  return flags
}

/**
 * The row-end flags (dep / conflict / drift / landable / stacked).
 *
 * (wf31/52) THE `axis: 'mark'` TAG — THE CONFLICT-AXIS FLAGS NEXT TO THE MARK.
 *
 * The user's finding: the row reads `⚠️ conflict · ○ awaiting approval
 * (source?)`, "where '(source?)' refers to the conflict" — but it ended up
 * BEHIND the approve column, because the renderer's order is mark → rmark →
 * flags, and `(source?)` was in flags. So the eye reads it as belonging to
 * approve: as if the approval were waiting on the source.
 *
 * The renderer draws `axis: 'mark'` flags AFTER the mark, BEFORE the rmark —
 * so the conflict axis (`⚡dep`, `(source?)`, `⛔ conflict #N`) sits in one
 * block with the mark it's talking about. The tag is DATA, not style: the
 * bash list view solves the same grouping with its own ordering.
 *
 * `measured` is THE FACT OF MEASUREMENT (is there a diagnosis on this PR) —
 * see the reasoning on branch 3: the question mark must not outlive its own
 * answer.
 */
function flagsFor(r, { measured = false } = {}) {
  const flags = []
  if (r.stackedOn !== null && r.stackedOn !== undefined) {
    flags.push({ label: `⬆️ stacked after #${r.stackedOn}`, color: 'gray' })
    // THE CHAIN DIAGNOSIS shows up on the stacked row (a main-based row is by
    // definition 0 deep and can't be part of a cycle). THE ORDER IS NOT
    // ARBITRARY: CYCLE comes first, because there depth isn't even meaningful
    // — "too deep" next to it would be misleading. The labels MUST MATCH the
    // bash queue_flag_def's "stackcycle"/"toodeep" branches, otherwise the
    // list and the TUI would say DIFFERENT things about the same row.
    if (r.stackCycle === true) {
      flags.push({ label: '⚠ circular', color: 'red' })
    } else if (r.stackTooDeep === true) {
      // WE PRINT the depth: plain "too deep" doesn't say by how much — and
      // the user's decision (wait it out / split the chain) depends on it.
      flags.push({ label: `⚠ too deep (${r.stackDepth ?? '?'} levels)`, color: 'yellow' })
    }
    return flags
  }
  // Classification comes from the (b) model: 2 = soft dep, 3 = conflict with
  // an unknown source, 4 = conflict that also touches a dep file (do NOT
  // resolve it).
  // NO SPACE after ⚡ — MATCHING the bash queue_flag_def's "dep" branch, and
  // not a typo. ⚡ (U+26A1) STEPS two cells (MEASURED: advance=2, same as
  // ⛔/🚀), so the layout is correct — the `·` separator column doesn't shift
  // when measured. ⚡ is, however, a text-presentation glyph (no VS16,
  // Emoji_Presentation is false), so most fonts draw it narrow within the
  // reserved 2 cells: the second cell looks empty, and standing next to a
  // literal space this reads as TWO gaps. That's exactly what the user
  // reported. The reserved cell IS the separator itself. ⛔/🚀/⬆️ are
  // emoji-presentation, the user didn't report those — there the space STAYS
  // (a targeted fix, see test/next-tui.test.ts).
  if (r.classification === 2 && r.dep) flags.push({ label: `⚡dep #${r.dep}`, color: 'cyan', axis: 'mark' })
  // Case 3's label used to be "(main-drift)", and it CLAIMED a MEASURED fact
  // that the queue doesn't know (here there are only labels + the file
  // intersection). The live #911 case failed on exactly this: it was
  // MERGEABLE with main, the conflict's source was four PRs within the
  // queue. The question mark means: the source isn't known yet — the 'c' key
  // (`tuipr conflict`) measures it. The label MUST MATCH the bash
  // queue_flag_def's "unmeasured" branch.
  // (wf31/52) THE QUESTION MARK MUST NOT OUTLIVE ITS OWN ANSWER. The user's
  // finding: "I measured the source with c, and a checkmark appeared, but the
  // source question didn't go away" — the row said at once that it WAS
  // MEASURED (`✓`) and that the source was UNKNOWN.
  //
  // THE REASON: `classification` comes from the queue model (bash computes it
  // from the LABELS and the file intersection), while the measurement result
  // lives in the session cache — so class `3` stays `3` even after
  // measuring, because its input didn't change. `dep` doesn't help either:
  // that's the FILE-INTERSECTION's dep, not the MEASURED culprit.
  //
  // SO THE FLAG ALSO LOOKS AT THE FACT OF MEASUREMENT: if there's a diagnosis
  // on this PR, the question IS ANSWERED — the answer (the culprit list, the
  // stack target) lives in the panel, where the measurement writes it. A
  // row-end question mark there is just a lie at that point.
  if (r.classification === 3 && !measured) flags.push({ label: '(source?)', color: 'yellow', axis: 'mark' })
  if (r.classification === 4 && r.dep) flags.push({ label: `⛔ conflict #${r.dep}`, color: 'red', axis: 'mark' })
  // (wf31/24) THE `🚀 landable` FLAG WAS REMOVED — the user's request: "Take
  // this indicator out, it's silly. approved already conveys what's needed."
  //
  // WHY IT WAS A DUPLICATION: since wf31/23 the `landable` field means
  // EXACTLY that THERE IS AN APPROVE (approve became merge's only blocker).
  // But the fact of approval is ALREADY stated by `rmark` (`✔ approved`), in
  // the same row, a few cells to the left. Two indicators for the same fact.
  //
  // The `landable` FIELD STAYS in the model: mechanical consumers (the
  // Claude skill, the `mergeBlockers` matching contract) use it, and the bash
  // list view's classification is also built on it. Only the ROW FLAG
  // disappeared — the fact didn't.
  return flags
}

/**
 * The `queue --json` array → displayable rows.
 *
 * The ordering matches the list view: a stacked row lands BEHIND its base
 * even if its number is much bigger (#150 after #101, before #102) — the key
 * is [(stackedOn // number), number].
 *
 * THE SECOND ARGUMENT IS OPTIONAL: `{ cacheStates, reviewTraces }`, plain
 * objects keyed by PR number. WHY A PRE-COMPUTED MAPPING, and not the cache
 * object: `buildRows` runs on EVERY render, and the user's 4th point states
 * that the indicator must not slow down the list. On a pre-gathered mapping,
 * the per-row work is an object lookup — no gh, no hunk, no git call fits
 * here. (Assembling the cache→mapping is the app's job, once per render.)
 * Without an argument, the flag band is UNCHANGED: the old callers (the bash
 * side and the existing tests) can't fall over.
 */
export function buildRows(json, {
  cacheStates = null,
  reviewTraces = null,
  reviewSpinners = null,
  // (wf31/72) THE RUNNING ACTION: `{ pr, key }` or `null`. Only one action
  // runs at a time (`actionLock`), so a single number-key pair is enough — a
  // map would suggest that multiple concurrent actions are possible.
  pendingAction = null,
  // (wf31/25) OPTIMISTIC STATES: PR number → `'merged'` | `'approved'`. The
  // result of OUR OWN action, which the GitHub API doesn't reflect YET
  // (asynchronous index) — see the reasoning for the MARKS `merged` branch.
  optimistic = null,
} = {}) {
  // THE CHAIN FIELDS come from the MODEL (stackDepth / stackRoot), they
  // aren't recomputed here: the transitive resolution lives in the bash jq
  // pass, and two implementations of the same concept would guaranteed drift
  // apart (this is the lying-status bug class the user already reported).
  //
  // FAIL-SAFE against a contract shift: if an older `queue --json` doesn't
  // supply the fields, we fall back to the `stackedOn`-based SINGLE-LEVEL
  // picture — the list still appears, just without the staircase. An
  // exception here would kill the ENTIRE TUI.
  const depthOf = (r) => {
    if (typeof r.stackDepth === 'number' && Number.isFinite(r.stackDepth)) {
      return Math.max(0, Math.floor(r.stackDepth))
    }
    return r.stackedOn !== null && r.stackedOn !== undefined ? 1 : 0
  }
  const rootOf = (r) => {
    if (typeof r.stackRoot === 'number' && Number.isFinite(r.stackRoot)) return r.stackRoot
    return r.stackedOn ?? r.number
  }
  // The ordering groups by ROOT, then by DEPTH within that, then by number.
  // WHY NOT the old `[(stackedOn // number), number]`: that grouped by the
  // DIRECT pedestal, which split the group apart on an A→B→C chain (C's key
  // was B's number, not A's), and an independent PR with a number in between
  // could wedge itself into the middle of the chain. `stackRoot` is
  // transitive, so every element of the chain gets the SAME primary key.
  const rows = [...json].sort((a, b) =>
    rootOf(a) - rootOf(b) || depthOf(a) - depthOf(b) || a.number - b.number)
  return rows.map((r) => {
    const isStacked = r.stackedOn !== null && r.stackedOn !== undefined
    // (wf31/25) THE OPTIMISTIC STATE OVERRIDES THE MEASURED ONE. The order is
    // load-bearing: once the MODEL has caught up (a reload gave fresh data),
    // the caller deletes the optimistic entry — so as long as it's here, it
    // carries a fact FRESHER than the model's.
    const opt = optimistic?.[r.number] ?? null
    // The `approved` optimistic state overrides ONLY the rmark (the PR is
    // still open, the mark stays `in queue`); `merged` overrides the MARK
    // too — that's the PR's fate.
    const rk = opt === 'approved' ? 'approved' : rmarkKey(r)
    return {
      ...r,
      // The BOOLEAN `indent` STAYS: the listLayout/renderer side reads it,
      // and dropping the field would cause a SILENT layout drift (the falsy
      // 0 would count as indentation). `indentDepth` is added ALONGSIDE it —
      // the amount of staircase indentation.
      indent: isStacked,
      indentDepth: depthOf(r),
      // A stacked row can't be acted on independently: its fate is decided
      // by its pedestal.
      selectable: !isStacked,
      // A stacked row's mark is "in queue" — next contains it THROUGH its
      // pedestal (the list view's queue_marks_from_model gives it this way
      // too). The row-end flag states the stacked-ness, so it doesn't get
      // duplicated.
      mark: opt === 'merged'
        ? MARKS.merged
        : MARKS[isStacked ? 'queue' : r.state] ?? MARKS.missing,
      rmark: rk ? RMARKS[rk] : null,
      // THE DIM SIGNAL for the renderer: a merged row DIMS (the user's
      // request). `Row` can already dim via the `dimmed` prop anyway (when an
      // overlay opens), but that applies to the WHOLE list — this is PER
      // ROW, and it talks about the row's FATE, not focus. Hence a separate
      // field, not reusing the existing `dimmed`.
      settled: opt === 'merged',
      // The META-FLAGS are appended AFTER the content flags — in ONE place,
      // above `flagsFor`'s TWO return branches (stacked / trunk). Had we put
      // it inside `flagsFor`, the stacked branch's early return would have
      // SILENTLY dropped the flag on a stacked row, and the list would say
      // DIFFERENT things about the two row classes.
      flags: appendMetaFlags(flagsFor(r, {
        // THE FACT OF MEASUREMENT FROM THE CACHE STATE: `fresh` OR `stale` —
        // both mean the measurement RAN. `stale` is deliberately included:
        // it only means main has moved since, but the culprits WERE
        // MEASURED, and the `~` flag states the staleness anyway. If only
        // `fresh` counted, the question mark would return on every move of
        // main — "but I did measure it" — when the answer is right there in
        // the panel.
        measured: cacheStates?.[r.number] === 'fresh' || cacheStates?.[r.number] === 'stale',
      }), {
        cacheState: cacheStates?.[r.number],
        hasTrace: reviewTraces?.[r.number] === true,
        spinnerFrame: reviewSpinners?.[r.number],
        pendingKey: pendingAction?.pr === r.number ? pendingAction.key : undefined,
      }),
      // The MECHANICAL CONSUMER (and `--json`) needs this stated too, not
      // just the glyph: the contract is the state's NAME, not its display.
      cacheState: cacheStates?.[r.number] ?? 'none',
      hasReviewTrace: reviewTraces?.[r.number] === true,
    }
  })
}

// --- (1b) THE STAIRCASE STACKED MARK: `╰─` at the END of the indent -------
//
// THE USER'S REQUEST, VERBATIM: "when there are stacked PRs, the indented
// second PR should have a right-angle frame character next to it: #911 /
// ╰─#933" — and confirmed that at multiple levels there should be a
// STAIRCASE. The recursive stacking (the transitive `stackDepth`/`stackRoot`)
// already works, this mark is its PICTURE.
//
// THE GEOMETRY that makes introducing this possible at all: `╰─` is EXACTLY
// 2 display CELLS, and the indent was already 2*depth cells. So the mark
// SITS INTO the LAST TWO CELLS of the indent, it doesn't add to it — the
// prefix's total width is UNCHANGED, so the mark column can't shift either.
//
// THE WIDTH IS MEASURED, NOT GUESSED (live tmux, CSI 6n cursor-advance):
//   `╰` U+2570 advance=1 · `─` U+2500 advance=1 · `╰─` together advance=2
// This isn't a formality: the user reported the column drift FOUR times, and
// every one of them rooted in a GUESSED glyph width. The box-drawing block
// (U+2500–U+257F) is EAW=Ambiguous, so it's not in WIDE_RANGES — our own
// displayWidth also measures it as 1, and the test pins this with an
// INDEPENDENT measurement.
//
// WHY ONE SHARED FUNCTION (and not a string computed in two places): the
// indent is read by TWO sides — `listLayout`'s title budget and the
// renderer's `Row`. The two MUST agree BYTE-FOR-BYTE; this is the project's
// MEASURED bug class (the `floor` was BINARY 3, while the renderer used
// 2*depth, and at column 56/57 the row silently overran by 1-2 cells). One
// source, one measure.

/** The staircase's GLYPH. 2 cells (MEASURED — see the section header). */
const STACK_MARK = '╰─'

/**
 * The stacked row's INDENT PREFIX from the depth: `2*(depth-1)` spaces + `╰─`.
 *
 * depth=0 (root or independent PR) gets an EMPTY string: there's nothing to
 * indent relative to, and a lone `╰─` would lie that the row is stacked on
 * something.
 *
 * FAIL-SAFE against a degenerate depth (negative, NaN, non-number):
 * `stackDepth` comes from the MODEL (the bash jq pass), so a contract shift
 * can hand back anything. A `' '.repeat(NaN)` would throw a RangeError, and a
 * throw here would take down the ENTIRE list — the mark is cosmetic, the
 * list isn't.
 */
export function stackIndent(depth) {
  const d = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0
  if (d === 0) return ''
  return ' '.repeat(2 * (d - 1)) + STACK_MARK
}

export { STACK_MARK }

// --- Layout: the title column's budget --------------------------------------

// The per-row fixed part: cursor(2) + "#" + number(5) + space + author(10) +
// space + the space after the title ≈ 21 cells, plus 2 cells right margin.
//
// THIS MUST MOVE WITH THE RENDERER'S AUTHOR WIDTH. Two numbers describing one
// column is exactly the drift this file warns about elsewhere; if the author
// column changes there, it changes here, in the same commit.
const ROW_FIXED_W = 21
const ROW_MARGIN_W = 2

/** The width of a row's status tail at the given degradation level. */
function tailWidth(r, level) {
  const mark = displayWidth(r.mark.label)
  if (level >= 2) return mark // mark only
  const rmark = r.rmark ? 3 + displayWidth(r.rmark.label) : 0
  if (level >= 1) return mark + rmark // mark + approve column, no flags
  const flags = r.flags.reduce((a, f) => a + 1 + displayWidth(f.label), 0)
  return mark + rmark + flags
}

/**
 * THE LIST LAYOUT: the title column's width AND the status-tail degradation
 * level.
 *
 * Why a plain width isn't enough (this was the bug the user reported THREE
 * times): if the fixed part + the widest status tail ALONE exceeds COLUMNS,
 * driving the title column to 0 is NOT enough — the row still overflows, Ink
 * wraps, and the mark column slides into a different cell per row. MEASURED
 * in a LIVE 60-column tmux render: #911's row became 65 cells, the `#926`
 * flag slid onto the next row, the mark column landed at cell 15/17/19
 * (ALIGNED: false). So after zeroing the title column, the TAIL must be
 * dropped in stages:
 *   0 = mark + approve column + flags (full)
 *   1 = mark + approve column (flags dropped)
 *   2 = mark only (the narrowest, still-informative form)
 *
 * The indent (stacked row) does NOT go into the tail computation: the indent
 * sits BEFORE the title, and the renderer shortens the title column by it
 * (`titleWidth - 2`). If we counted it here too, we'd subtract it TWICE —
 * that's exactly what shifted the mark column on the indented row.
 */
export function listLayout(rows, columns) {
  if (rows.length === 0) return { titleWidth: 0, tailLevel: 0, width: 0 }
  // The title column clamps to the longest ACTUAL title (no point padding
  // empty). The indented row spends 2 cells on the indent, so we count its
  // title as 2 longer — this way its own title isn't needlessly truncated.
  // THE INDENT AMOUNT comes FROM THE DEPTH. `indentDepth` is the transitive
  // depth from the model; the `?? (indent ? 1 : 0)` fallback keeps the old
  // (single-level) row shape alive.
  //
  // (1b) THE AMOUNT is `stackIndent`'s CELL-measured width — the SAME source
  // the renderer prints too. NOT a SECOND `2*depth` formula: a duplicated
  // measure for the same concept has ALREADY drifted apart once in this
  // project (the binary `floor` vs. the renderer's 2*depth, a silent
  // overflow at column 56/57). If the staircase's glyph ever changes, NOTHING
  // needs adjusting here.
  const indentOf = (r) =>
    displayWidth(stackIndent(typeof r.indentDepth === 'number' ? r.indentDepth : r.indent ? 1 : 0))
  const longest = Math.max(...rows.map((r) => displayWidth(r.title) + indentOf(r)))
  // The DEEPEST row's indent sets the floor (see the `floor` below).
  const maxIndent = Math.max(...rows.map((r) => indentOf(r)))
  for (const tailLevel of [0, 1, 2]) {
    const statusW = Math.max(...rows.map((r) => tailWidth(r, tailLevel)))
    const avail = columns - ROW_FIXED_W - ROW_MARGIN_W - statusW
    // The renderer uses `Math.max(1, titleWidth - 2*depth)`, so the deepest
    // row consumes at least 1 + 2*depth cells even if we gave 0 here. The
    // layout must account for this floor, otherwise the guarantee is a lie.
    //
    // MEASURED BUG: the floor used to be BINARY 3 (`indent ? 3 : 1`), so on a
    // 3-deep chain it reserved 2 cells instead of 6 — the layout
    // UNDER-measured the row, and at column 56/57 the rendered row OVERRAN
    // by 1-2 cells. The range is narrow, which is exactly why it's silent:
    // the eye doesn't notice, the terminal wraps. (test/next-tui.test.ts
    // sweeps the full columns range.)
    const floor = 1 + maxIndent
    if (avail >= floor) {
      const titleWidth = Math.min(longest, avail)
      // (wf31/27) THE TABLE'S ACTUAL WIDTH — from the CONTENT, not the
      // terminal.
      //
      // THE USER'S FINDING: "The TUI's max width is capped by the longest PR
      // title, which is lame when something goes all the way to the
      // terminal's right edge while there's still room there. […] The
      // table should determine the app's width, and the status text should
      // be at its edge, and the highlight should only go that far too."
      //
      // WHY IT CAN BE COMPUTED HERE, AND WHY THIS IS THE RIGHT PLACE:
      // `titleWidth` ALREADY clamps to the content (`Math.min(longest,
      // avail)`) — meaning if the longest title is shorter than the
      // available room, the table does NOT stretch to the terminal's edge.
      // This information already existed, we just didn't expose it: the
      // header, the status text, and the cursor background used `columns`,
      // so they went to the TERMINAL's edge, while the table didn't.
      //
      // THE FORMULA is the reverse of deriving `avail`, with the SAME
      // terms — not a second, independent computation (that would guaranteed
      // drift: this project's measured bug class, see the `floor` reasoning
      // above).
      //
      // `statusW` is the WIDEST row's tail: that's what sets the table's
      // right edge, not each row's own length — otherwise the edge would jump
      // around per row.
      return {
        titleWidth,
        tailLevel,
        // (wf31/28) THE CEILING IS ONE LESS THAN THE TERMINAL WIDTH. A
        // MEASURED ARTIFACT (from the user's resize finding): if the table
        // reaches EXACTLY the terminal's width, the cursor highlight's
        // background fill writes into the LAST CELL too — and most
        // terminals (Ghostty, Terminal.app) then AUTOWRAP, jumping to the
        // start of the next row. The resulting phantom row is exactly the
        // reported "pile-up".
        //
        // The `-1` ONLY affects the ceiling: if the CONTENT is narrower (the
        // typical case, which is why the other `Math.min` branch wins), the
        // table is unchanged.
        width: Math.min(Math.max(1, columns - 1), ROW_FIXED_W + ROW_MARGIN_W + statusW + titleWidth),
      }
    }
    // Even the narrowest level has no room: give the least the renderer
    // will accept at all. This is the truly degenerate case (a very narrow
    // terminal); at this point we can no longer avoid wrapping, but we're
    // not the one making it worse.
    if (tailLevel === 2) return { titleWidth: 0, tailLevel: 2, width: Math.max(1, columns - 1) }
  }
  return { titleWidth: 0, tailLevel: 2, width: Math.max(1, columns - 1) }
}

/**
 * The title column's width. A backward-compatible wrapper around listLayout
 * — bin/tuipr.sh and the tests reference this name.
 */
export function titleBudget(rows, columns) {
  return listLayout(rows, columns).titleWidth
}

// --- THE ROW SPINNER (4): while a review is running on a PR -----------------

/**
 * SINGLE-CELL Braille spinner frames. NOT emoji: emoji steps 2 cells, and
 * would break the flag band's width computation (the bug class reported four
 * times, the column drift). The Braille block (U+2800–U+28FF) isn't in
 * WIDE_RANGES, so our own displayWidth also MEASURES it as 1 — the test
 * asserts this too, it doesn't guess.
 */
export const REVIEW_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * The spinner's list flag. CYAN (activity, not a warning — yellow is for
 * cost/blockers). The frame index wraps; a degenerate index doesn't throw
 * either, because the spinner is cosmetic — a throw here would take down the
 * ENTIRE list.
 */
export function reviewSpinnerFlag(frame) {
  const len = REVIEW_SPINNER_FRAMES.length
  const n = Number.isInteger(frame) ? frame : 0
  return { label: REVIEW_SPINNER_FRAMES[((n % len) + len) % len], color: 'cyan' }
}
export { MARKS, RMARKS }
