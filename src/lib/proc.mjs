// tuipr — PROC: process-helper base layer.
//
// BASE LAYER: imports only node builtins, ZERO project modules. The reasoning
// for the cycle ban is in bin/tui-core.mjs's header.
//
// What lives here: the diagnosis of a spawn ERROR (not the exit code!) in ONE
// place (the ENOENT trap), the memoized measurement of the repo root, the
// spawnSync-SHAPED async child, and the path constants for the shell entry point.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const SCRIPT_DIR = new URL('..', import.meta.url).pathname
const NEXT_SH = `${SCRIPT_DIR}tuipr.sh`

/**
 * THE CORE ROOT: derived from the MODULE's own location (`import.meta.url`).
 *
 * WHY NOT from the process's cwd (this is the point, not a detail): the user
 * runs the TUI from ANOTHER repo's checkout (from under the mobile/web
 * packages, where core is a symlinked or vendored npm dependency). A SHA
 * measured from cwd would therefore report the CONSUMER repo's SHA — exactly
 * the wrong answer to the one question this segment exists for ("which CORE
 * code is running?"). `fetchRepoRoot` is deliberately a DIFFERENT concept
 * (the hunk session's repo root, which is and must be cwd's) — the two must
 * not be swapped.
 */
const CORE_ROOT = path.resolve(SCRIPT_DIR, '..')

export { CORE_ROOT, NEXT_SH, SCRIPT_DIR }

/**
 * The substantive text of a SPAWN ERROR (not the exit code!) — in ONE place,
 * for every spawnSync call site.
 *
 * THE MEASURED TRAP this exists for (node v24, spawnSync, PATH=/nonexistent):
 *   res.status === null · res.stderr === undefined · res.error.code === 'ENOENT'
 * So a branch checking ONLY `res.status !== 0` gives the user "exit null" /
 * "undefined" text, and NOT ONE WORD about the real cause (the binary isn't
 * installed / isn't on PATH). This is a bug class the project has already
 * been bitten by: `hunkComments` got its own ENOENT branch for exactly this
 * ("NOT a session error: the binary itself is missing") — this helper gives
 * the same diagnosis to the other call sites too, so it's not true in only
 * one place.
 *
 * Returns `null` if NO spawn error occurred (then the caller goes down the
 * exit-code branch).
 */
export function spawnFailure(res, tool) {
  if (!res?.error) return null
  if (res.error.code === 'ENOENT') {
    return `\`${tool}\` was not found (ENOENT): it isn't installed, or isn't on PATH. `
      + 'This is NOT the operation\'s fault — the binary itself is missing.'
  }
  return `\`${tool}\` could not be started (${res.error.code ?? 'spawn error'}): ${res.error.message}`
}

/**
 * THE REPO ROOT — ONE measurement, ONE place.
 *
 * WHY IT NEEDS TO BE CENTRALIZED: the root was needed on THREE paths (`d`'s
 * cwd, `hunkComments`'s `--repo`, the AI review's `--repo`), and three COPIED
 * `git rev-parse --show-toplevel` calls sat in the code. On `d`'s path,
 * though, NONE of them were there — the hunk started in the TUI's working
 * directory. This duplication is what produced the user-reported bug: the
 * concept of "root" lived in three places, and in one of them it did NOT.
 *
 * THE ERROR IS THROWN, not swallowed: without a root, session affinity is
 * meaningless, and a silent empty string would hand the hunk `--repo ""`.
 *
 * MEMOIZED (wf24/4). The TUI's working directory does NOT change during the
 * session's LIFE (the process's cwd is fixed, hunk-suspend doesn't move it
 * either), so a repeated `git rev-parse` is pure latency — and this is
 * exactly what sat as the FIRST blocking call of the finished review's `r`,
 * before the UI update. Only the SUCCESSFUL measurement is cached: every call
 * remeasures on error (a transient git error must not get stuck for the rest
 * of the session).
 */
let repoRootCache = null

/** DROPPING the memoized root — test anchor (against leakage between fixtures). */
export function resetRepoRootCache() {
  repoRootCache = null
}

export function fetchRepoRoot() {
  if (repoRootCache !== null) return repoRootCache
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  const spawnErr = spawnFailure(res, 'git')
  if (spawnErr) throw new Error(`could not determine the repo root: ${spawnErr}`)
  if (res.status !== 0) {
    throw new Error(
      `could not determine the repo root (git rev-parse, exit ${res.status}): `
      + `${(res.stderr || '').trim() || '(no stderr)'}`,
    )
  }
  const root = (res.stdout || '').trim()
  if (root === '') {
    throw new Error(
      'the repo root came back EMPTY from git. The hunk session is repo-scoped, '
      + 'so it cannot be identified without a root — a `--repo ""` call would '
      + 'silently find SOME OTHER session (or none).',
    )
  }
  repoRootCache = root
  return root
}

/**
 * A spawnSync-SHAPED result ({ status, stdout, stderr, error }) from an
 * ASYNC child — the sync fetches' parse logic can be reused UNCHANGED.
 *
 * WHY THIS IS NEEDED (the user's 5th run, 2nd finding): the soft reload after
 * closing the hunk view ran as spawnSync under runExclusive, and during the
 * MEASURED post-q phase (queue --json ~1.9 s + rev-parse + gh pr list ~0.55 s)
 * the app was deaf ("working for a few seconds"). The async child leaves the
 * event loop free. NEVER rejects: the error is carried by the spawnSync
 * shape (error / non-zero status), the decision belongs to the parsing
 * caller — exactly like on the sync path.
 */
export function spawnCollect(cmd, args) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', error })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => { stderr += d })
    // 'close' can also fire after 'error' — the Promise keeps the FIRST
    // resolve, so the double signal is harmless.
    child.on('error', (error) => resolve({ status: null, stdout, stderr, error }))
    child.on('close', (code) => resolve({ status: code, stdout, stderr }))
  })
}

// --- THE TRUNK'S NAME: which branch the tooling measures against ------------
//
// (dev-trunk migration) A consumer repo's trunk is no longer necessarily
// `main`: app repos are moving to the dev-trunk model, where a PR's target
// and the basis for landability measurement is `dev`. The name resolves from
// ONE SOURCE, in a ranking BYTE-IDENTICAL to the bash side (bin/tuipr.sh
// `MAIN=`):
//   1) `NEXT_WORK_MAIN` env — manual override (the bash side already knew this);
//   2) the CONSUMER repo's package.json's `tuipr.trunk` field — this is a
//      declaration COMMITTED into the repo, so the migration doesn't depend
//      on anyone's local env;
//   3) `'main'` — today's world, unchanged behavior.
//
// FAIL-SOFT ON EVERY BRANCH, and this is CORRECT here (not laxness): a
// missing/unreadable package.json describes exactly today's (pre-migration)
// repos — there 'main' is the correct answer. IN PR CONTEXT `baseRefName`
// REMAINS the source of truth (fetchPrRefs) — this resolver is for
// REPO-LEVEL questions (cache anchor, staleness signature), where there's no
// PR to say so.
let trunkBranchCache = null

/** DROPPING the memoized trunk name — test anchor (against leakage between fixtures). */
export function resetTrunkBranchCache() {
  trunkBranchCache = null
}

/**
 * The trunk branch's name in the CONSUMER repo. Never throws, never empty.
 *
 * @param {object} [opts]
 * @param {string} [opts.root] the repo root — ONLY for test injection; in
 *   production the memoized `fetchRepoRoot()` is the source. An injected root
 *   gets NO memoization (the cache holds the real repo's answer, not the
 *   fixture's).
 */
export function trunkBranch({ root } = {}) {
  const injected = root !== undefined
  if (!injected && trunkBranchCache !== null) return trunkBranchCache
  const resolve = () => {
    const env = (process.env.NEXT_WORK_MAIN || '').trim()
    if (env !== '') return env
    try {
      const repoRoot = injected ? root : fetchRepoRoot()
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
      const declared = typeof pkg?.tuipr?.trunk === 'string' ? pkg.tuipr.trunk.trim() : ''
      if (declared !== '') return declared
    } catch { /* see the fail-soft reasoning in the header */ }
    return 'main'
  }
  const value = resolve()
  if (!injected) trunkBranchCache = value
  return value
}

// --- The trunk's (origin/<main|dev>) SHA: git plumbing on the PROCESS layer --
//
// WHY HERE: this is the other half of the measurement cache's invalidation
// anchor, so its CONSUMERS are the poll (fetchStalenessProbe) AND the
// queue-fetch layer too. If it lived in the queue-fetch module, the poll
// would import UPWARD — exactly the cycle risk the layering rules out. Its
// only dependency is spawnSync/spawnCollect, so the proc layer is its
// natural home.
/**
 * The trunk's (`origin/<trunkBranch()>`) SHA — the other half of the
 * measurement cache's INVALIDATION ANCHOR. The name is historical: "main"
 * here denotes the role of the TRUNK, whose name can be `dev` per repo after
 * the dev-trunk migration (see trunkBranch's header) — renaming it would be
 * pointless churn across the 175-name consumer contract (barrel/entry/tests).
 *
 * Runs ONCE PER RELOAD, not per row: the user's 4th point states that the
 * indicator must not slow the list down. A `git rev-parse` is local, but
 * called per PR it would be 20 processes at 20 rows, EVERY render.
 *
 * WHY IT DOESN'T THROW: half of the anchor may be missing (no remote ref, a
 * fresh clone), and that's NOT a reason for the TUI to fail — `null`
 * fail-closed gives an `unknown` anchor (see cacheAnchor), so nothing will be
 * "fresh", we just remeasure. SILENT SWALLOWING isn't an option in the other
 * direction either: a FALSE SHA (e.g. an empty string accepted as "success")
 * would show two DIFFERENT trunk states as identical, and the cache would
 * present a stale diagnosis as done. So we check both the exit status AND
 * ENOENT, and only accept non-empty output.
 */
export function fetchMainSha(remote = 'origin', branch = trunkBranch()) {
  return parseMainShaResult(spawnSync('git', ['rev-parse', `${remote}/${branch}`], { encoding: 'utf8' }))
}

/** The main-SHA's SINGLE parser — the shared core of the sync and async paths. */
function parseMainShaResult(res) {
  // ENOENT (no git) and any other spawn error: no SHA. `spawnFailure` gives
  // the same diagnosis as on the other paths — just here we don't throw, we
  // signal the "unknowable" anchor with null instead.
  if (res.error) return null
  if (res.status !== 0) return null
  const sha = (res.stdout || '').trim()
  return sha === '' ? null : sha
}

/** fetchMainSha's ASYNC counterpart — the same null contract, with a free event loop. */
export async function fetchMainShaAsync(remote = 'origin', branch = trunkBranch()) {
  return parseMainShaResult(await spawnCollect('git', ['rev-parse', `${remote}/${branch}`]))
}

// --- THE LOADED CORE'S IDENTIFIER (1a) --------------------------------------
//
// THE USER'S MEASURED COST, which is why this exists: "TODAY I repeatedly
// couldn't tell whether I was running fresh code, and it cost me a lot of
// time". The TUI can start from four different paths (live checkout, git
// worktree, symlinked workspace package, vendored npm dependency), and
// nothing on screen so far said WHICH one it's running. The header timestamp
// only says when we loaded the QUEUE — not which CODE loaded it.
//
// THREE SOURCES, RANKED. The ranking isn't arbitrary: the MORE PRECISE
// identifier wins, because the question is "is this the commit just pushed".
//   1) `git -C <coreRoot> rev-parse --short HEAD` — the developer path. This
//      is the ONLY one that's commit-exact.
//   2) the first 7 characters of `.source-sha` — the vendored path, if the
//      sync tool laid down the source commit. Also commit-exact, just not live.
//   3) `package.json`'s version — the last resort. NOT commit-exact (one
//      version covers many commits), but more informative than nothing.
//
// FOURFOLD FAIL-SOFT, and this is a CONTRACT, not laxness: this is a
// COSMETIC header segment. A throw (non-git directory, unreadable file,
// corrupt JSON) would kill the WHOLE TUI — which is infinitely more
// expensive than a missing SHA. So every branch resolves to `null`, and the
// caller OMITS the segment.
//
// WHY WE DON'T WRITE "unknown" (the task's explicit stipulation): "core
// unknown" gives the impression that the program WANTED to know and failed —
// and the user is looking at the header for exactly the opposite: to get
// RELIABLE information. A missing segment is silent; a lying segment is costly.

/** The short SHA's length — matching git's `--short` default. */
const SHORT_SHA_LEN = 7

let coreShaCache
let coreShaCached = false

/** DROPPING the memoized core SHA — test anchor (against leakage between fixtures). */
export function resetCoreShaCache() {
  coreShaCache = undefined
  coreShaCached = false
}

/** The git path: short HEAD SHA from the core root. `null` if not git (or no git). */
function coreShaFromGit(coreRoot) {
  // `--short` gives git's default length (7+, more on collision) — we don't
  // truncate it, because git knows how much is needed for UNIQUENESS in this repo.
  const res = spawnSync('git', ['-C', coreRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
  // ENOENT (no git) and every other spawn error: no SHA on this path.
  if (res.error) return null
  if (res.status !== 0) return null
  const sha = (res.stdout || '').trim()
  return sha === '' ? null : sha
}

/** The vendored path: the first 7 characters of `.source-sha`. `null` if missing/unreadable. */
function coreShaFromSourceFile(coreRoot) {
  try {
    const raw = fs.readFileSync(path.join(coreRoot, '.source-sha'), 'utf8').trim()
    if (raw === '') return null
    const head = raw.slice(0, SHORT_SHA_LEN)
    return head === '' ? null : head
  } catch {
    // NO-FILE and UNREADABLE-FILE get the same answer: no SHA on this path.
    // Separating the two would give nothing here (the user has nothing to do
    // with it), and a throw would take the TUI down over the header.
    return null
  }
}

/** The vendored path's last resort: `package.json`'s version. */
function coreShaFromPackageVersion(coreRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(coreRoot, 'package.json'), 'utf8'))
    const v = pkg?.version
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
  } catch {
    // CORRUPT JSON also lands here: fail-soft (see the section's header).
    return null
  }
}

/**
 * The LOADED CORE's SHORT IDENTIFIER for the header, or `null`.
 *
 * MEMOIZED, and this is LOAD-BEARING, not an optimization: `headerLine`
 * RECOMPUTES on every render (Ink re-renders the tree on every keystroke,
 * every poll tick, every spinner frame). A `spawnSync` lurking here would
 * therefore start one process PER FRAME — the same bug class `fetchRepoRoot`
 * is memoized against, just hit much more densely. The `null` RESULT IS ALSO
 * CACHED (separate `coreShaCached` flag): otherwise, on the non-git path
 * every frame would retry the spawn, and on exactly the worst (slowest) branch.
 *
 * The `coreRoot` PARAMETER is only a test anchor; in production the module's
 * own location (CORE_ROOT) is the only correct answer — see CORE_ROOT's header.
 */
export function fetchCoreSha({ coreRoot = CORE_ROOT } = {}) {
  if (coreShaCached) return coreShaCache
  const sha = coreShaFromGit(coreRoot)
    ?? coreShaFromSourceFile(coreRoot)
    ?? coreShaFromPackageVersion(coreRoot)
  coreShaCache = sha
  coreShaCached = true
  return sha
}
