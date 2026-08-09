// tuipr — QUEUE-FETCH: the data-source calls (ACQUISITION).
//
// What lives here: the queue (sync + async), fetching PR refs, and PR-file
// size. SEPARATE from diagnosis, because that's INTERPRETATION, this is
// ACQUISITION.
//
// LAYER ORDER: imports downward (proc: spawn diagnosis, NEXT_SH,
// spawnCollect). Imports NOTHING from core or above.
//
// ONE PRINCIPLE ACROSS EVERY CALL: a spawn ERROR (ENOENT) and a NON-ZERO EXIT
// each get their own diagnosis, and the error is THROWN — a silently empty
// list would lead the caller to conclude "no data", when in fact the contract
// failed.
//
// --- PROVIDER SELECTION ------------------------------------------------------
//
// The queue model is a CONTRACT, not an implementation: the layers above it
// display it, they never recompute it. So here we only decide WHO produces
// it.
//
// The default is `providers/github.mjs` — it only uses `gh` and `git`, so it
// runs on any repo. `TUIPR_QUEUE_CMD` wires in an EXTERNAL provider instead:
// any command that writes JSON matching the contract to stdout. That way, the
// richer, MEASUREMENT-based model (conflict diagnosis, transitive stacking)
// can be plugged back in without modifying the TUI.
import { spawnCollect, spawnFailure } from './proc.mjs'
import { fetchQueue as ghFetchQueue, fetchQueueAsync as ghFetchQueueAsync } from './providers/github.mjs'
import { spawnSync } from 'node:child_process'

/** The external provider's command, split into words — or `null` if none is configured. */
function externalProvider() {
  const raw = process.env.TUIPR_QUEUE_CMD?.trim()
  if (!raw) return null
  const parts = raw.split(/\s+/)
  return { cmd: parts[0], args: parts.slice(1) }
}

/** The SINGLE parser for the external provider's output (shared core of sync + async). */
function parseQueueResult(res, tool) {
  const spawnErr = spawnFailure(res, tool)
  if (spawnErr) throw new Error(`the queue cannot be queried: ${spawnErr}`)
  if (res.status !== 0) {
    throw new Error(`queue --json error (exit ${res.status}): ${(res.stderr || res.stdout || '').trim() || '(no output)'}`)
  }
  return JSON.parse(res.stdout)
}

/** The queue model — per the configured provider. */
export function fetchQueue() {
  const ext = externalProvider()
  if (!ext) return ghFetchQueue()
  return parseQueueResult(spawnSync(ext.cmd, ext.args, { encoding: 'utf8' }), ext.cmd)
}

/**
 * The ASYNC counterpart of fetchQueue — BYTE-FOR-BYTE the same contract
 * (shape, error text), only the event loop stays free. The background-reload
 * path after a hunk close (5/2).
 */
export async function fetchQueueAsync() {
  const ext = externalProvider()
  if (!ext) return ghFetchQueueAsync()
  return parseQueueResult(await spawnCollect(ext.cmd, ext.args), ext.cmd)
}


/**
 * Fetching the PR's head branch into a local ref, so hunk sees an actual
 * git range (this gives file-level navigation and hunk anchors, unlike the
 * `gh pr diff | hunk patch -` path).
 * Returns: [baseRef, headRef].
 */
/**
 * Is this checkout a shallow clone?
 *
 * WHY IT IS WORTH ASKING BEFORE FETCHING A PR: a shallow clone has no common
 * ancestor to compute, so the `base...head` range the diff viewer is given
 * cannot resolve. What the user sees is the viewer's own complaint — "no merge
 * base" — flashed for a fraction of a second before the list returns. Every
 * word of it is true and none of it says what to do, or that the repository
 * (not the tool, and not the PR) is the thing that is unusual.
 *
 * This is not an exotic setup: `--depth 1` is the default in most CI
 * checkouts, and it is what an impatient clone of a large repository looks
 * like too. It cost an hour here before someone read the flash.
 */
function isShallowRepo() {
  const res = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' })
  // UNKNOWN IS NOT SHALLOW: if git cannot be asked, we do not invent a
  // diagnosis — the later failure will report itself in its own words.
  if (spawnFailure(res, 'git') || res.status !== 0) return false
  return (res.stdout || '').trim() === 'true'
}

export function fetchPrRefs(pr, remote = 'origin') {
  if (isShallowRepo()) {
    throw new Error(
      'this is a shallow clone, so there is no common ancestor to diff against. '
      + 'Run `git fetch --unshallow` (or clone without --depth) and try again.',
    )
  }
  const ref = `refs/tuipr/pr/${pr}`
  const fetched = spawnSync('git', ['fetch', '-q', remote, `pull/${pr}/head:${ref}`], { encoding: 'utf8' })
  const fetchSpawnErr = spawnFailure(fetched, 'git')
  if (fetchSpawnErr) throw new Error(`cannot start fetching #${pr}: ${fetchSpawnErr}`)
  if (fetched.status !== 0) {
    // We do NOT interpolate stderr raw: on a spawn error it would be
    // `undefined`, and the user would get a "failed: undefined" line.
    throw new Error(`fetching #${pr} failed (exit ${fetched.status}): ${(fetched.stderr || '').trim() || '(no stderr)'}`)
  }
  // The base ref must NOT silently fall back to 'main'. For a stacked PR, the
  // real base is ANOTHER PR's head branch; if we guessed 'main' after a
  // transient gh error (auth, rate limit, partial GraphQL response), the
  // reviewer would get the origin/main...head diff, which ALSO includes the
  // BASE PR's commits — so they'd end up reviewing (and then approving) a
  // different PR than the one they think they are. Guessing here is worse
  // than a loud failure.
  const baseJson = spawnSync('gh', ['pr', 'view', String(pr), '--json', 'baseRefName', '--jq', '.baseRefName'], { encoding: 'utf8' })
  const baseSpawnErr = spawnFailure(baseJson, 'gh')
  if (baseSpawnErr) throw new Error(`cannot query #${pr}'s base branch: ${baseSpawnErr}`)
  if (baseJson.status !== 0) {
    throw new Error(`fetching #${pr}'s base branch failed: ${(baseJson.stderr || '').trim() || `gh exit ${baseJson.status}`}`)
  }
  const base = (baseJson.stdout || '').trim()
  if (!base) throw new Error(`#${pr}'s base branch came back empty from gh — the base cannot be guessed`)
  return [`${remote}/${base}`, ref]
}

/**
 * The PR's file list with sizes (`gh pr view --json files`) — the
 * confirmation screen computes the file count, +/- lines, and scope from
 * this.
 *
 * Why not from `queue --json`: that model deliberately carries no size data
 * (per-file additions/deletions), and we don't want to put it there either —
 * only the AI review needs it, once per PR, on demand.
 *
 * The error is THROWN: a silently empty file list would give the
 * confirmation screen a "0 files, +0/-0" picture, from which the developer
 * would think the PR is trivial — and hit y.
 */
export function fetchPrFiles(pr) {
  const res = spawnSync(
    'gh',
    ['pr', 'view', String(pr), '--json', 'files', '--jq', '.files'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
  // THE SPAWN ERROR FIRST, before the exit code: on ENOENT, status is null
  // and stderr is empty, so the branch below would give "gh exit null" — a
  // LYING diagnosis (gh didn't return a failing exit, it never even started).
  const spawnErr = spawnFailure(res, 'gh')
  if (spawnErr) throw new Error(`cannot fetch #${pr}'s file list: ${spawnErr}`)
  if (res.status !== 0) {
    throw new Error(`cannot fetch #${pr}'s file list: ${(res.stderr || '').trim() || `gh exit ${res.status}`}`)
  }
  const text = (res.stdout || '').trim()
  if (!text) throw new Error(`#${pr}'s file list came back empty from gh — the PR's size cannot be guessed`)
  const files = JSON.parse(text)
  if (!Array.isArray(files)) throw new Error(`#${pr}'s file list isn't an array: ${text.slice(0, 200)}`)
  return files.map((f) => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 }))
}
