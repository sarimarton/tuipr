// tuipr — GITHUB PROVIDER: producing the queue model from `gh` and `git`.
//
// THIS IS THE OTHER SIDE OF THE CONTRACT. The TUI ONLY DISPLAYS the queue
// model — it never recomputes the classification, landability, or
// approvability (see tui-core.mjs). So that layer is a CONTRACT, not an
// implementation's private business, and here is a second implementation of
// the contract: one that relies ONLY on `gh` and `git`, with no workplace
// branch convention.
//
// WHAT THIS PROVIDER DELIBERATELY DOES NOT GIVE:
//   - `classification` (the conflict diagnosis's numeric level) and `dep` —
//     these come from MEASUREMENT (a merge-tree simulation), not a query;
//   - `stackedOn` / `stackRoot` / `stackDepth` — stacking is read out of an
//     integration branch's merge messages, which don't exist here.
// The consumer is FAIL-SAFE for these (rows.mjs `depthOf`/`rootOf`): in their
// absence, a flat, single-level list results. So we don't lie a zero into a
// field we have no measurement for — a missing field means "we don't know",
// while `0` would mean "we measured it and there's none".
//
// LAYER ORDER: imports downward (proc: spawn diagnosis). Imports NOTHING
// from core or above.
import { spawnCollect, spawnFailure } from '../proc.mjs'
import { spawnSync } from 'node:child_process'

/**
 * The `gh pr list` fields. Kept NARROW: every field is separate GraphQL work
 * on the server, and `files` is the most expensive — we only request that
 * when it's actually needed (the dep intersection lives in the measuring
 * provider, not here).
 */
const PR_FIELDS = [
  'number',
  'title',
  'isDraft',
  'headRefName',
  'baseRefName',
  'mergeable',
  'mergeStateStatus',
  'reviewDecision',
  'author',
].join(',')

/**
 * The classification from a QUERY, not a measurement — and the field names
 * carry that distinction too.
 *
 * WHY `mergeable` ISN'T ENOUGH: GitHub's `CONFLICTING`/`MERGEABLE`/`UNKNOWN`
 * triad is the state against BASE. `UNKNOWN` isn't an error, it means "the
 * server is still computing" — in that case `mergeStateStatus` is more
 * informative, and the two must be looked at TOGETHER, otherwise we'd falsely
 * report a PR that's still refreshing as conflicting.
 */
export function classifyPr(pr) {
  if (pr.isDraft) return 'draft'
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return 'conflict'
  // `BLOCKED` ON ITS OWN does NOT mean a blocked PR — a MEASURED finding on
  // cli/cli's open PRs: there, EVERY ONE is `BLOCKED`, because the repo
  // mandates review and the review hasn't happened yet. This is the
  // WAITING-FOR-REVIEW state, completely normal, and exactly the state this
  // tool exists for.
  //
  // If we reported this as `blocked`, the WHOLE list would be ⛔, and the
  // signal wouldn't distinguish anything — the same error class rows.mjs
  // already eliminated once for the everywhere-shown ⬆️. It would also
  // duplicate the review state, which already has its OWN column (rmark).
  //
  // So blocked means what a HUMAN stopped: the requested change.
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'blocked'
  if (pr.mergeStateStatus === 'UNKNOWN' && pr.mergeable === 'UNKNOWN') return 'missing'
  return 'queue'
}

/**
 * Can WE approve it. GitHub doesn't let you approve your own PR either, so we
 * don't offer it — the fail-closed direction here is `false`.
 */
export function canApprovePr(pr, viewer) {
  if (pr.isDraft) return false
  if (viewer && pr.author?.login === viewer) return false
  if (pr.reviewDecision === 'APPROVED') return false
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return false
  return true
}

/**
 * The merge method ALLOWED by the repo. One call, because the answer is a
 * repo property, it doesn't vary per PR.
 *
 * FAIL-SOFT, DELIBERATELY: if the query fails (permissions, offline), we
 * return `merge` — that's GitHub's default too. Denying the WHOLE list over a
 * non-critical supplementary field would be disproportionate.
 */
function repoMergeMethod() {
  const res = spawnSync(
    'gh',
    ['repo', 'view', '--json', 'squashMergeAllowed,rebaseMergeAllowed,mergeCommitAllowed'],
    { encoding: 'utf8' },
  )
  if (spawnFailure(res, 'gh') || res.status !== 0) return 'merge'
  try {
    const r = JSON.parse(res.stdout)
    if (r.mergeCommitAllowed) return 'merge'
    if (r.squashMergeAllowed) return 'squash'
    if (r.rebaseMergeAllowed) return 'rebase'
  } catch {
    return 'merge'
  }
  return 'merge'
}

/** The logged-in user's login name, or `null` if it can't be determined. */
function viewerLogin() {
  const res = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' })
  if (spawnFailure(res, 'gh') || res.status !== 0) return null
  return res.stdout.trim() || null
}

/**
 * The SINGLE parser for `gh pr list --json` output — the shared core of the
 * sync and async paths.
 *
 * THE ERROR IS THROWN, not swallowed: a silently empty list would lead the
 * caller to conclude "no open PRs", when in fact the contract failed. This is
 * the same principle that applied to every call in the original provider.
 */
function parsePrList(res) {
  const spawnErr = spawnFailure(res, 'gh')
  if (spawnErr) throw new Error(`the PR list cannot be queried: ${spawnErr}`)
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim() || '(no output)'
    throw new Error(`gh pr list error (exit ${res.status}): ${detail}`)
  }
  try {
    return JSON.parse(res.stdout)
  } catch (err) {
    throw new Error(`gh pr list output isn't JSON: ${err.message}`)
  }
}

/** Raw `gh` PR → queue-model row. */
export function toQueueRow(pr, { viewer, mergeMethod }) {
  return {
    number: pr.number,
    title: pr.title,
    state: classifyPr(pr),
    isDraft: Boolean(pr.isDraft),
    reviewDecision: pr.reviewDecision || null,
    canApprove: canApprovePr(pr, viewer),
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    mergeMethod,
    author: pr.author?.login ?? null,
  }
}

function listArgs(limit) {
  return ['pr', 'list', '--state', 'open', '--limit', String(limit), '--json', PR_FIELDS]
}

/**
 * `gh pr list` → queue-model array.
 *
 * The HIGH default for `limit` is deliberate: `gh`'s default of 30 would
 * SILENTLY cut off the list in an active repo, and the missing PRs' absence
 * wouldn't be noticed — exactly the error class we're also avoiding with the
 * silently-empty-list case.
 */
export function fetchQueue({ limit = 200 } = {}) {
  const viewer = viewerLogin()
  const mergeMethod = repoMergeMethod()
  const prs = parsePrList(spawnSync('gh', listArgs(limit), { encoding: 'utf8' }))
  return prs.map((pr) => toQueueRow(pr, { viewer, mergeMethod }))
}

/**
 * The ASYNC counterpart of fetchQueue — BYTE-FOR-BYTE the same contract
 * (shape, error text), only the event loop stays free.
 */
export async function fetchQueueAsync({ limit = 200 } = {}) {
  const viewer = viewerLogin()
  const mergeMethod = repoMergeMethod()
  const prs = parsePrList(await spawnCollect('gh', listArgs(limit)))
  return prs.map((pr) => toQueueRow(pr, { viewer, mergeMethod }))
}
