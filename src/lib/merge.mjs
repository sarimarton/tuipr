// tuipr — MERGE: action-gating and the merge plan.
//
// What can be approved / merged, the ENUMERATION of blockers (not just the
// first one — the user wants to see ALL the reasons), the branch's fate per
// the prefix convention, and the MIDDLE truncation of the branch label.
//
// LAYER ORDER: imports downward (layout: measures in the branchLabel cell).
// Imports NOTHING from core or above.
import { clampCells, displayWidth } from './layout.mjs'


// --- Action-gating ----------------------------------------------------------

/**
 * THE BLOCKERS OF APPROVE, ENUMERATED — modeled on `mergeBlockers`.
 *
 * (wf31/14) WHY WE NO LONGER USE THE MODEL'S `canApprove` FIELD, AND WHY WE
 * ALLOW THE SECOND APPROVE (the user's question: "What's the principled
 * obstacle to this?"):
 *
 * The bash `canApprove` demands FIVE conditions, and one of them is
 * `reviewDecision != "APPROVED"` — i.e. the TUI did not let you approve a PR
 * that was ALREADY approved. Reading through the codebase, there is NO stated
 * justification for this (every blocker in `mergeBlockers` has the why spelled
 * out next to it, this one doesn't), and there's no principled obstacle either:
 *   · the GitHub API ALLOWS it (`gh pr review --approve` works);
 *   · this is a FOUR-EYES repo, so a second approval is an INDEPENDENT FACT —
 *     `reviewDecision` stays `APPROVED`, but `latestReviews` shows TWO
 *     approvers, which is a DIFFERENT state from an audit standpoint (not a
 *     no-op);
 *   · it also worked AGAINST the queue view's PURPOSE: the list shows approved
 *     PRs too (for the full picture), but a second approve required leaving
 *     the TUI.
 *
 * THE RULE'S LIKELY ORIGIN is the BULK path: a `tuipr approve --all` MUST NOT
 * blast through already-approved PRs (that would be an unintended flood of
 * approvals). But that's the semantics of `--all`, not of the single-PR,
 * cursor-selected, interactive gesture protected by a CONFIRMATION MODAL. The
 * bash `classify_approvable` (and with it the `--all` filter) is UNTOUCHED.
 *
 * WHAT REMAINS A BLOCKER, because EACH ONE IS A REAL OBSTACLE:
 *   · stacked — its fate depends on its base (the non-interactive path's
 *     `--base main` filter carried this role; it belongs here defensively
 *     too);
 *   · draft — not even landable, approve would be meaningless;
 *   · your own — GitHub itself REJECTS it (you can't approve your own PR);
 *   · changes-requested — approving before the requested changes would be a
 *     lie.
 *
 * THE ENUMERATION IS THE POINT (not just the boolean): the old UI gave a
 * single generic string — "cannot approve (yours / draft / stacked / already
 * decided)" — from which the user had to GUESS which reason applied. That's
 * exactly why they asked. `mergeBlockers` doesn't make this mistake, and from
 * now on neither does this.
 */
export function approveBlockers(r) {
  const out = []
  if (r.stackedOn !== null && r.stackedOn !== undefined) out.push('stacked PR — its base must land first')
  if (r.isDraft) out.push('draft PR')
  // YOUR OWN PR: `viewerIsAuthor` is a MEASURED field on the model. FAIL-SOFT
  // on its absence: if we don't know (old model), we do NOT block — GitHub
  // rejects it anyway, and a made-up blocker is worse than a loud
  // server-side error.
  if (r.viewerIsAuthor === true) out.push("it's yours — GitHub doesn't allow approving your own PR")
  if (r.reviewDecision === 'CHANGES_REQUESTED') {
    out.push('changes-requested review — approve must be requested again after the requested changes')
  }
  return out
}

/** Whether it can be approved — whether the blocker list is empty. One concept, one source. */
export function canApproveRow(r) {
  return approveBlockers(r).length === 0
}

/**
 * The blockers of the merge, ENUMERATED (not just the first) — the
 * confirmation prompt shows this so the user sees what's missing.
 *
 * Why `landable` isn't enough: the mergeMethod (branch-name convention) isn't
 * part of landability, but it's needed for the merge — for a non-conventional
 * name, the person landing it decides, not the TUI.
 */
// (wf31/22) THE MERGE GATE TAKEN APART: ONE BLOCKER (approve), THE REST WARNINGS.
//
// THE USER'S DECISION, verbatim: "Take this blocker logic out very quickly.
// The github UI allows merging, approve is the only condition. We're not
// going to play blocker games from app logic. You can leave in warnings at
// most."
//
// WHAT WAS WRONG: the TUI was STRICTER than GitHub, and it even said so
// out loud ("UNSTABLE — … GitHub would allow it, we don't"). But a
// convenience tool can't decide in the platform's place: if it can be merged
// from the GitHub UI, it should be mergeable from the TUI too. Case #895
// showed the damage: red, NON-REQUIRED checks (Jira-transition, Determine
// Mode) blocked the merge, even though neither of them blocks landing.
//
// THE ONLY REAL BLOCKER IS APPROVE (the user's criterion). Every other case
// is a WARNING: visible before the decision, but not forbidding.
//
// `stacked`/`draft`/`mergeable`/`mergeMethod` ALSO BECAME JUST WARNINGS, and
// this is deliberate: each of these is a fact that GitHub itself rejects too
// (draft/stacked merge, conflicting PR), so our prohibition is redundant — the
// server-side rejection is LOUD and TRUE, while our gate produces the error
// class described above.

/**
 * The reasons that ACTUALLY DENY the merge. TODAY THERE IS ONE: no approve.
 *
 * A SEPARATE FUNCTION from `mergeWarnings`, because the TWO SERVE DIFFERENT
 * DECISIONS: this one opens the modal's `denied` branch (the `y` doesn't
 * work), while the other just writes lines above the decision. A merged list
 * would bring back exactly the conflation this change removes.
 */
export function mergeBlockers(r) {
  const out = []
  if (r.reviewDecision !== 'APPROVED') out.push('no approve')
  return out
}

/**
 * THE MERGE'S WARNINGS — visible before the decision, but do NOT forbid it.
 *
 * We list the SPECIFIC CHECK NAMES, not just the aggregate word. The CLI
 * dry-run does the same ("red check: rebuild, Determine Mode, Type Check"),
 * and the two paths must not diverge: the user is right there on the overlay
 * before the decision, where "(red)" on its own says nothing about WHAT needs
 * fixing.
 *
 * FALLBACK for missing names: if the list is empty (old model, or the rollup
 * data is missing), we print the aggregate. The signal must NEVER disappear,
 * and MAKING UP a name is forbidden — "we don't know which" must not be
 * conflated with "none".
 */
export function mergeWarnings(r) {
  const out = []
  if (r.stackedOn !== null && r.stackedOn !== undefined) out.push('stacked PR — its base is still open')
  if (r.isDraft) out.push('draft')
  if (r.checks !== 'green') {
    const named = r.checks === 'red' ? r.failedChecks : r.checks === 'pending' ? r.pendingChecks : null
    const label = r.checks === 'red' ? 'red check' : 'still-running check'
    if (Array.isArray(named) && named.length > 0) out.push(`${label}: ${named.join(', ')}`)
    else out.push(`CI is not green (${r.checks})`)
  }
  // `UNSTABLE` IS ALREADY IN THE CHECK ROW (a failed non-required check), so it
  // does NOT get its own line: the old form ("GitHub would allow it, we
  // don't") advertised exactly the stricter-than-the-platform behavior the
  // user removed.
  if (r.mergeStateStatus === 'BEHIND') out.push('BEHIND — main has moved, a rebase may be needed')
  if (r.mergeable !== 'MERGEABLE') out.push(`mergeable: ${r.mergeable}`)
  // WHEN is there no mergeMethod? SINCE the non-conventional name also gets
  // the DEFAULT merge commit (user decision: "the prefix is the instruction,
  // default is the merge commit"), ONLY for an EMPTY headRefName — and that's
  // MISSING DATA, not a convention question.
  if (!r.mergeMethod) out.push('the PR head-branch name is EMPTY (missing data) — mergeMethod cannot be derived')
  return out
}

export function canMergeRow(r) {
  return mergeBlockers(r).length === 0
}

/**
 * The BRANCH NAME's label for display, truncated to the CELL limit.
 *
 * WHY DISPLAY IT AT ALL (user request, verbatim): "the info box has the merge
 * method, which is great, but I can't see the branch name anywhere, even
 * though that's how I'd check whether the method is right. The branch name is
 * important info anyway." `headRefName` was ALREADY in the model — it just
 * wasn't shown.
 *
 * WHY WE TRUNCATE IN THE MIDDLE, and not on the right (this is the key
 * decision): the method follows from the PREFIX (`squash-`/`rebase-`/anything
 * else → merge commit). If we used the usual right-side truncation, for a
 * long name it would keep… no, it would keep exactly the beginning — but the
 * descriptive END would disappear, which is needed to identify the PR. If we
 * truncated on the left instead, the PREFIX would disappear, and the user
 * would lose exactly the signal they wanted to use to check the method.
 * Truncating in the middle shows BOTH: the prefix (the method's source) and
 * the name's tail (identification). This formatter is therefore not
 * stylistic — it's data for the user's checking action.
 *
 * THE MEASURE IS CELLS, NOT CHARACTERS (via `clampCells`): the user reported
 * column-drift FOUR times. A branch name is ASCII today, but nothing
 * guarantees that (git accepts a unicode ref name), and a character-based cut
 * would tear apart the overlay's frame for an emoji-bearing name.
 *
 * For an EMPTY / MISSING name, a TALKING placeholder, not an empty string: an
 * empty head is MISSING DATA (see the corresponding branch of
 * mergeBlockers), and an empty row on the overlay would read as if the field
 * didn't even exist. "We don't know" must not be silenced.
 */
export function branchLabel(head, cells) {
  if (typeof head !== 'string' || head === '') return '— (head-branch name unknown)'
  const limit = Math.max(0, Math.floor(Number(cells) || 0))
  if (limit === 0) return ''
  if (displayWidth(head) <= limit) return head
  // The truncation marker itself takes up space. If the limit is so tight
  // that no meaningful text fits next to the marker, the PREFIX wins: the
  // method's source is the last piece of information we give up (the name's
  // tail identifies, the prefix DECIDES).
  const ELLIPSIS = '…'
  const ell = displayWidth(ELLIPSIS)
  if (limit <= ell + 1) return clampCells(head, limit)
  const room = limit - ell
  // The beginning gets more room (the prefix is the load-bearing part), the
  // tail gets the rest. `clampCells` guarantees we never split a surrogate
  // pair.
  const headRoom = Math.ceil(room / 2)
  const tailRoom = room - headRoom
  const start = clampCells(head, headRoom)
  // The TAIL is measured from the right: we truncate in reversed order, then
  // reverse back. We reverse over the codepoint array (not `.split('')`), so
  // surrogate pairs don't get torn apart.
  const end = tailRoom > 0
    ? [...clampCells([...head].reverse().join(''), tailRoom)].reverse().join('')
    : ''
  const out = `${start}${ELLIPSIS}${end}`
  // FAIL-SAFE: if the above calculation overshoots for any reason (the
  // displayWidth lookahead rule can catch a VS16 right at the cut boundary),
  // the final measure is decided here. We must never emit a label wider than
  // the limit.
  return displayWidth(out) <= limit ? out : clampCells(out, limit)
}

/**
 * THE LANDING PLAN shown by the confirmation overlay: what happens if the
 * user says yes. The user explicitly asked three questions:
 *   - which method will we merge with (rebase-prefix → rebase merge, etc.)
 *   - what happens to the branch
 *   - what will the commit message be
 * The overlay must answer all three, BEFORE THE GESTURE.
 *
 * WHY IT DOESN'T EXECUTE ANYTHING: this is a pure function — execution
 * belongs to the bash `cmd_merge`, which also checks repo permission and the
 * state gate. This is ONLY a description of intent. The two must not
 * diverge: next-tui.test.ts measures the `deletesBranch` rule back against
 * the bash `merge_deletes_branch`.
 *
 * FAIL-CLOSED on TWO inputs, and both are justified:
 *   - without a method (mergeMethod), `null`. A guessed plan ("probably
 *     squash") would give the impression that we know what's going to
 *     happen.
 *   - without a BRANCH NAME (headRefName) too, `null`. The branch's FATE
 *     comes from the prefix; for an empty name, `/^(squash|rebase)-/` gives
 *     false, so the plan would say "the branch stays" — even for a squash
 *     PR, whose branch WILL BE DELETED. That would be a LYING overlay (the
 *     same error class as the "(main-drift)" label that stated a measured
 *     fact falsely), so instead there's no plan.
 */
export function mergePlan(r) {
  if (!r || typeof r !== 'object') return null
  const method = r.mergeMethod
  if (method !== 'squash' && method !== 'rebase' && method !== 'merge') return null
  const head = r.headRefName
  if (typeof head !== 'string' || head === '') return null
  // The branch's fate comes from the PREFIX, not the method: normally the two
  // go together, but the prefix is the source of truth (bash matches on it
  // too). If we only looked at the method, a `merge`-method branch that's
  // still named `squash-` (impossible in principle, but the model doesn't
  // rule it out) would get a different fate here than in bash — and the user
  // would read something different on the overlay than what actually
  // happens.
  const deletesBranch = /^(squash|rebase)-/.test(head)
  return {
    method,
    // THE METHOD'S HUMAN-READABLE NAME. Live rendering showed that the raw
    // key doesn't inflect: the `merge` method turned into "method: merge
    // merge" on screen. We use the GitHub UI's vocabulary, because that's
    // where the user sees these same three buttons.
    methodLabel: method === 'merge' ? 'merge commit'
      : method === 'squash' ? 'squash merge'
      : 'rebase merge',
    deletesBranch,
    branchFate: deletesBranch
      ? 'the branch will be deleted (--delete-branch)'
      : 'the branch stays (ticket branch — the changelog references it)',
    // The commit message is provided by the GitHub repo setting; we do NOT
    // pass --subject/--body. See the bash cmd_merge's head: the
    // squash/merge title+message is repo policy, and changelog generation
    // relies on that.
    commitMessage: 'comes from the repo setting (not overridden)',
  }
}
