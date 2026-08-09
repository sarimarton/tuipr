// tuipr — REVIEW-STORE: the DISK CACHE for review results (/tmp).
//
// THE USER'S REQUEST (verbatim): "the app should cache reviews to disk,
// because it's tiring to always restart. /tmp is enough I think, that clears
// itself eventually."
//
// LAYERING: ZERO project imports, only node builtins — the same level as
// `proc.mjs`. This is intentional: its consumer is the app layer, so it
// could be called from any core module, and an upward import (e.g. from
// cache.mjs) would immediately create a cycle risk. The cycle-ban rationale
// lives in the header of bin/tui-core.mjs, the mechanical guard is
// scripts/check-next-modules.mjs.
//
// WHY A SEPARATE MODULE, AND WHY NOT IN cache.mjs:
// `cache.mjs` has a MECHANICALLY GUARDED ZERO-I/O INVARIANT —
// test/next-cache.test.ts reads the WHOLE file and forbids any
// `spawnSync`/`spawn`/`readFileSync`/`writeFileSync` calls in it. This isn't a
// formality: the cache indicator producers (cacheState, cacheIndicatorFlag) run
// on EVERY render, for EVERY row, so a file I/O placed there would mean one
// syscall per PR on every frame — exactly the slowdown the cache was built to
// prevent in the first place. Persistence therefore lives in a separate layer,
// and the memory cache still stands on the render path.
//
// THE MEMORY CACHE'S ROLE IS UNCHANGED (the "not on disk" rationale in
// next-cache.test.ts's header applies to THAT cache, and still holds): the
// DIAGNOSTIC measurements stay session-scoped, because the next picture moves
// hourly. This module ONLY persists the REVIEW RESULT, which is data of a
// DIFFERENT nature: it's PAID FOR (spent tokens), and it's not about queue
// state but about the PR's diff — so it stays valid exactly as long as the
// anchor holds.
//
// THE ANCHOR HAS THREE PARTS — BUT THEY ARE NOT EQUAL, and this ranking is the
// heart of this module. TWO parts describe the review's SUBJECT (the diff),
// the THIRD describes the review's TOOL (the measuring code):
//
//   THE SUBJECT (BLOCKING — a mismatch bans loading):
//   1) the PR's `updatedAt` — a new push/rebase means the reviewed diff is no
//      longer this one;
//   2) the trunk (`origin/<main|dev>`, see trunkBranch) SHA — the diff is
//      interpreted AGAINST the trunk, so a trunk move changes the review's
//      SUBJECT without touching the PR.
//
//   THE TOOL (NOT BLOCKING — a mismatch is a SIGNAL, `tool-drift`):
//   3) the CORE SHA — a DIFFERENT CODE ran the review.
//
// WHY THE CORE SHA DOESN'T BLOCK (a MEASURED FINDING, from the user's finding —
// the #904 review sat on disk, schema-correct, with a matching `updatedAt` and
// `mainSha`, yet still didn't load): in production, `fetchCoreSha` returns the
// git HEAD of the RUNNING TUI. The core is UNDER DEVELOPMENT, so EVERY core
// commit — even a comment rewording — GLOBALLY invalidated EVERY cached review
// in EVERY repo. The cache thus practically NEVER survived the next startup,
// which brought back exactly the complaint it was built for ("tiring to always
// restart").
//
// AND WHY THIS IS ALSO RIGHT IN PRINCIPLE: findings are claims ABOUT the PR's
// DIFF. If the measuring code's version changes, the findings do NOT become
// false claims — at worst, a review done TODAY might produce DIFFERENT
// findings too. That's a RESERVATION, not an invalidity; discarding the paid
// (token-spent) result would be a disproportionate response to it. SCHEMA
// COMPATIBILITY — the original rationale, "different code may produce a
// different schema" — does NOT rest on this anchor, but on
// `REVIEW_STORE_SCHEMA`: when the shape changes, THAT is bumped, and the old
// entry becomes `null` (see there).
//
// THE DIFFERENCE SHOWS IN THE UI, NOT SWEPT UNDER THE RUG: a drifted entry's
// findings DO LOAD, but the panel's `caveat` line states that a DIFFERENT core
// version measured it — the same "it shows, but we don't withhold the
// reservation" pattern that the degraded review paths' caveat uses.
//
// FAIL-SOFT ON EVERY PATH, and this is a CONTRACT: this is a CONVENIENCE
// layer. /tmp not writable, corrupt JSON, unreadable file, schema mismatch →
// the caller gets `null`/`false`, the TUI falls back to the memory cache, and
// NO raw error reaches the UI. The review's result EXISTS in memory; throwing
// here for the sake of persistence would take away exactly the PAID result.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/**
 * The COLLECTOR DIRECTORY's name under TMPDIR.
 *
 * WHY /tmp (the user's decision, with a stated reason): "it clears itself
 * eventually". The review cache doesn't even need to outlive that — an entry
 * kept for weeks would almost certainly have a stale anchor, so it would just
 * take up space. OS-level cleanup is thus exactly the right expiry policy,
 * for free.
 */
export const REVIEW_STORE_DIR_NAME = 'tuipr-review-cache'

/**
 * The SCHEMA VERSION. BUMP it when the entry's SHAPE (not its content)
 * changes.
 *
 * WHY WE DON'T CONVERT from the old shape: the review is RE-RUNNABLE, but a
 * misinterpreted finding is a FALSE CLAIM about the code — and that ruins
 * exactly the trust the review was made for. An unknown schema therefore
 * becomes `null` (as if there were no entry), not a guessed migration.
 *
 * THIS IS THE ONLY SCHEMA GATE, and this is a COMMITMENT: the `coreSha` anchor
 * has LOST this role (see the header's ranking — it now only signals). So if
 * you change the SHAPE of the finding objects (rename a field, change its
 * meaning), you MUST bump it HERE — the core commit itself will no longer
 * invalidate old entries. From now on, the assumption "the core SHA will move
 * and protect us" is FALSE.
 */
export const REVIEW_STORE_SCHEMA = 1

/** Length of the repo-identifier hash. 12 hex chars: collision odds are negligible. */
const REPO_KEY_LEN = 12

/**
 * OVERRIDING THE CACHE ROOT — a TEST HOOK, and deliberately NOT via `TMPDIR`.
 *
 * WHY IT'S NEEDED, AND WHY REDIRECTING TMPDIR IS A MEASURED TRAP (this bug
 * ACTUALLY HAPPENED, measured across the whole suite — 31 tests failed at
 * once): the first test variant pointed `process.env.TMPDIR` at a tempdir,
 * then restored it in `finally` and discarded the directory. The problem is
 * that EVERY stub of the render harness (`bash`, `git`, `gh`, `hunk`, `claude`)
 * is also built UNDER `os.tmpdir()` — which reads the SAME `TMPDIR`. Rewriting
 * the global env therefore redirected OTHER tests' stub directories, and they
 * silently vanished: the failures depended on a SIDE EFFECT, not on the
 * behavior under test, and running in isolation they were all green. A global
 * env variable at the process level is SHARED state — a PARAMETER is not.
 */
let baseOverride = null

/** Redirect the cache root (test). `null` resets to `${TMPDIR:-/tmp}`. */
export function setReviewStoreBase(dir) {
  baseOverride = typeof dir === 'string' && dir !== '' ? dir : null
}

/** The `${TMPDIR:-/tmp}` semantics, read at runtime. */
function tmpBase() {
  if (baseOverride !== null) return baseOverride
  // `os.tmpdir()` ITSELF also reads TMPDIR, but it also normalizes the
  // trailing separator — that's why we use this, not the raw env variable.
  return os.tmpdir()
}

/**
 * THE REPO'S IDENTIFIER: a short, deterministic hash of the root path.
 *
 * WHY A HASH, and not the raw path (TWO reasons, both load-bearing):
 *   1) ISOLATION: the user works in several checkouts at once (a live
 *      `packages/*`, plus worktrees for PR work). If the key were just the PR
 *      number, #911's review from ONE repo would show up in ANOTHER — different
 *      code, different diff, same number. That's silent, misleading data.
 *   2) SECURITY: a raw path containing separators could write under /tmp into
 *      an arbitrarily deep tree (or, with `..`, OUTSIDE it). The hash is
 *      GUARANTEED to be one directory level, and contains nothing outside
 *      `[0-9a-f]`.
 *
 * DETERMINISTIC: the same path yields the same key — without this the cache
 * would be lost on every startup, which would bring back exactly the user's
 * complaint.
 */
function repoKey(repoRoot) {
  // THE SENTINEL IS A HASH INPUT, NOT A MESSAGE: it feeds the digest that names
  // the cache directory, so changing it changes the key for the "no repo root"
  // case and orphans anything cached under the old one. That cost is acceptable
  // here and only here — the tool has not shipped, the cache is local and
  // regenerates on demand — and one Hungarian identifier left inside an
  // otherwise English codebase would have outlived it by a long way.
  const src = typeof repoRoot === 'string' && repoRoot !== '' ? repoRoot : '(no-repo-root)'
  return crypto.createHash('sha256').update(src).digest('hex').slice(0, REPO_KEY_LEN)
}

/** The directory for the repo's entries. */
export function reviewStoreDir({ repoRoot } = {}) {
  return path.join(tmpBase(), REVIEW_STORE_DIR_NAME, repoKey(repoRoot))
}

/** The path of a SINGLE PR's entry. */
export function reviewStorePath({ repoRoot, pr } = {}) {
  // The PR number goes into the filename normalized AS A NUMBER: a "pr" of
  // the shape `../x` would otherwise allow a path escape. After `Number` +
  // `Math.trunc`, only digits (and possibly `-`) remain.
  const n = Number.isFinite(Number(pr)) ? Math.trunc(Number(pr)) : 0
  return path.join(reviewStoreDir({ repoRoot }), `${n}.json`)
}

/**
 * Assembling the ANCHOR from its three parts, normalizing a missing one to
 * `null`.
 *
 * ALL THREE PARTS STAY IN — `coreSha` TOO, even though it doesn't block: the
 * `tool-drift` signal needs to know EXACTLY WHICH core version measured the
 * entry, and that data only exists if we WRITE IT OUT. A "it doesn't block,
 * so let's not even save it" step would make the signal impossible (and the
 * diagnostics too: it lets you later determine which code produced an old
 * entry).
 *
 * AN EMPTY STRING IS ALSO "UNKNOWABLE": if we silently coerced it to `''`,
 * two entries measured in DIFFERENT states would have MATCHING anchors, so
 * we'd show a stale review as "fresh". This is the same fail-closed doctrine
 * as the memory cache's `cacheAnchor`.
 */
export function reviewStoreAnchor({ row, mainSha, coreSha } = {}) {
  const norm = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null)
  return {
    updatedAt: norm(row?.updatedAt),
    mainSha: norm(mainSha),
    coreSha: norm(coreSha),
  }
}

/**
 * THE SUBJECT PARTS — the anchor fields that INVALIDATE the review (see the
 * header). As a constant, because the field list is walked by BOTH readers
 * (`subjectMatches` and the missing-check), and writing it in two places
 * could drift apart.
 */
const SUBJECT_KEYS = ['updatedAt', 'mainSha']

/**
 * SUBJECT-ANCHOR match — the condition that makes a review VALID.
 * A MISSING (null) part NEVER matches — not even against itself.
 *
 * FAIL-CLOSED: better to re-measure (the review is re-runnable) than lie
 * about freshness. A review shown as "fresh" that's actually stale is the
 * most expensive mistake in this system: the user approves based on it.
 *
 * `coreSha` DOES NOT APPEAR HERE — that's the TOOL, not the subject (the
 * header's ranking). Its mismatch signals via `toolDrifted`, and does NOT ban
 * loading.
 */
function subjectMatches(a, b) {
  if (!a || !b) return false
  for (const k of SUBJECT_KEYS) {
    if (a[k] === null || a[k] === undefined) return false
    if (b[k] === null || b[k] === undefined) return false
    if (a[k] !== b[k]) return false
  }
  return true
}

/**
 * HAS THE TOOL DRIFTED: a DIFFERENT core version measured the entry than the
 * one running NOW.
 *
 * THE THREE BRANCHES, and all three are intentional:
 *   - both sides KNOWN and DIFFERENT → `true` (the case worth signaling);
 *   - both sides KNOWN and MATCH     → `false` (nothing to signal);
 *   - EITHER side UNKNOWABLE (null)  → `false`.
 *
 * THE THIRD BRANCH IS NOT fail-closed, and this DIFFERS from the
 * subject-anchor doctrine — deliberately. `toolDrifted` is a WARNING signal,
 * not a gate: if we don't know whether it drifted, a "a DIFFERENT core
 * version measured this" label would be a CLAIM about something we didn't
 * measure (in a non-git checkout, `fetchCoreSha` returns `null`). A false
 * warning is noise that trains the user to stop reading caveats — and it's
 * exactly what would devalue the real caveats that the degraded review paths
 * write. On the SUBJECT side, fail-closed is correct because there the cost
 * of a mistake is a lying "fresh" review; HERE the cost of a mistake is a
 * lying warning.
 */
function toolDrifted(a, b) {
  const x = a?.coreSha ?? null
  const y = b?.coreSha ?? null
  if (x === null || y === null) return false
  return x !== y
}

/**
 * WRITING OUT a review result. `true` on success, `false` on ANY error.
 *
 * THE `applied` FLAG NEVER GOES TO DISK (an explicit stipulation of the task,
 * with a real reason): the hunk session is REPO-scoped, and dies with the
 * TUI. A persisted `applied: true` would lie on the NEXT startup, claiming
 * the findings are already in the session — the new, EMPTY session would
 * stay without loading them, and the notes would "disappear". That was
 * exactly the core of the user's 5/3 finding, just now reaching across the
 * process boundary. The parameter is ACCEPTED (and discarded) so the caller
 * can pass the memory-cache entry through UNCHANGED — so callers don't have
 * to remember the rule at every call site.
 *
 * ATOMIC WRITE (tmp file + rename): a half-written JSON would produce exactly
 * the corrupt entry that we handle fail-soft on the read side — but it's
 * better not to produce it at all. `rename` is atomic on the same filesystem.
 */
export function reviewStoreWrite({ repoRoot, pr, anchor, findings, summary = null } = {}) {
  try {
    if (!Array.isArray(findings)) return false
    const dir = reviewStoreDir({ repoRoot })
    fs.mkdirSync(dir, { recursive: true })
    const target = reviewStorePath({ repoRoot, pr })
    const body = JSON.stringify({
      schema: REVIEW_STORE_SCHEMA,
      // The ANCHOR from the three parts, normalized — not the caller's raw object.
      anchor: {
        updatedAt: anchor?.updatedAt ?? null,
        mainSha: anchor?.mainSha ?? null,
        coreSha: anchor?.coreSha ?? null,
      },
      pr: Number(pr),
      summary: typeof summary === 'string' ? summary : null,
      findings,
      // WHEN we wrote it — diagnostic data (the file's mtime also gives this,
      // but the OS tools that clean up /tmp sometimes touch it). NOT part of
      // the anchor.
      writtenAt: new Date().toISOString(),
    })
    // The `.tmp` file is in the SAME directory, so the rename doesn't cross a
    // filesystem boundary (there it's not atomic, and can even fail with
    // EXDEV).
    const tmp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(tmp, body, { mode: 0o600 })
    fs.renameSync(tmp, target)
    return true
  } catch {
    // FAIL-SOFT: /tmp not writable (read-only mount, quota, sandbox), disk
    // full. The review EXISTS in memory — throwing here for the sake of
    // persistence would take away the paid-for result.
    return false
  }
}

/** A raw entry → validated shape, or `null`. The schema gate is closed HERE. */
function parseEntry(raw) {
  let obj
  try {
    obj = JSON.parse(raw)
  } catch {
    return null // CORRUPT JSON (partial write, a read during /tmp cleanup)
  }
  if (!obj || typeof obj !== 'object') return null
  // THE SCHEMA GATE: unknown/old version → as if there were no entry (see
  // the REVIEW_STORE_SCHEMA header: we don't guess a migration).
  if (obj.schema !== REVIEW_STORE_SCHEMA) return null
  if (!Array.isArray(obj.findings)) return null
  return {
    anchor: {
      updatedAt: obj.anchor?.updatedAt ?? null,
      mainSha: obj.anchor?.mainSha ?? null,
      coreSha: obj.anchor?.coreSha ?? null,
    },
    findings: obj.findings,
    summary: typeof obj.summary === 'string' ? obj.summary : null,
    writtenAt: typeof obj.writtenAt === 'string' ? obj.writtenAt : null,
  }
}

/**
 * The entry + its STATE measured against the CURRENT anchor.
 *
 * `null` — no entry, or unparseable (corrupt / foreign schema / unreadable).
 *          The caller behaves as before in this case.
 * `{ state: 'fresh',      loadable: true,  toolDrift: false, … }`
 *          — the SUBJECT anchor matches, and the same core version measured
 *            it.
 * `{ state: 'tool-drift', loadable: true,  toolDrift: true,  … }`
 *          — the SUBJECT anchor matches (the diff is the SAME), but a
 *            DIFFERENT core version measured it. LOADABLE, the UI states the
 *            reservation (see the header).
 * `{ state: 'stale',      loadable: false, toolDrift: …,     … }`
 *          — there IS a result, but the SUBJECT (the diff) has moved: NOT
 *            loadable.
 *
 * `state` has THREE values, while `loadable` has only TWO — and this split is
 * DELIBERATE: the STATE (what we know about the entry) and the DECISION
 * (whether to load it) used to coincide, and now they don't. A caller who
 * only cares about the decision still reads `loadable`, and the appearance of
 * the third state did NOT break it — the `toolDrift` boolean is for whoever
 * ALSO WRITES OUT the reservation.
 *
 * WHY WE DON'T DELETE ON STALENESS (the memory cache's doctrine, here too):
 * the list needs to signal that a measured result EXISTS, just no longer
 * valid (the `~` mark). Deletion ("no review") and staleness ("there was one,
 * but the base moved") mean a DIFFERENT action for the user.
 *
 * `applied` IS ALWAYS FALSE: an entry coming from disk is, by definition, "not
 * loaded" (the hunk session didn't survive the process) — so opening it
 * (`d`, since wf31/6) reloads it, on the ALREADY EXISTING logic tied to
 * session identity.
 */
export function reviewStoreRead({ repoRoot, pr, anchor } = {}) {
  let raw
  try {
    raw = fs.readFileSync(reviewStorePath({ repoRoot, pr }), 'utf8')
  } catch {
    // NO FILE and UNREADABLE FILE get the SAME response: no usable entry.
    // Separating the two would give the caller nothing.
    return null
  }
  const entry = parseEntry(raw)
  if (!entry) return null
  const subjectOk = subjectMatches(entry.anchor, anchor)
  const drift = toolDrifted(entry.anchor, anchor)
  return {
    pr: Number(pr),
    anchor: entry.anchor,
    findings: entry.findings,
    summary: entry.summary,
    writtenAt: entry.writtenAt,
    state: subjectOk ? (drift ? 'tool-drift' : 'fresh') : 'stale',
    // LOADABILITY is tied to the SUBJECT anchor: we do NOT load findings for
    // a stale DIFF (that would be a claim about the code that is NO LONGER
    // VALID). A tool drift, however, does NOT ban it — the findings are about
    // the diff, which still stands.
    loadable: subjectOk,
    // The RESERVATION travels INDEPENDENTLY of `loadable`: it can be true on
    // a stale entry too, and the list indicator (which also shows stale
    // entries) can know about it.
    toolDrift: drift,
    // NEVER persisted — see the reviewStoreWrite header.
    applied: false,
  }
}

/**
 * DELETING the entry (the discard path). `true` if there was something to
 * delete.
 *
 * WHY WE ALSO HAVE TO DELETE FROM DISK: the double-`x` discard is a
 * PRECONDITION for `r`'s restart (deliberate friction against an accidental
 * double spend). If it stayed on disk, the discarded findings would come back
 * on the NEXT startup — the cache would silently undo the user's explicit
 * decision.
 *
 * IDEMPOTENT and FAIL-SOFT: `false` for a non-existent entry, `false` on
 * error — no throw. The discard HAPPENED in memory; throwing here would take
 * down the UI over a cleanup operation.
 */
export function reviewStoreDelete({ repoRoot, pr } = {}) {
  try {
    fs.unlinkSync(reviewStorePath({ repoRoot, pr }))
    return true
  } catch {
    return false
  }
}

/**
 * ALL of the repo's entries, keyed by PR number — the LAZY load at TUI
 * startup.
 *
 * WHY WE NEED A BATCH READER: the list indicator needs to know WHICH PRs have
 * cached findings. A per-PR `reviewStoreRead` on the render path would be
 * per-row file I/O on every frame — exactly what the cache wants to avoid.
 * This runs ONCE (at startup), and the caller gets a plain object, on which
 * per-row work is an index lookup.
 *
 * THE ANCHOR CHECK DOES NOT HAPPEN HERE: at startup, the current anchor
 * DIFFERS per PR (the `updatedAt` comes from the queue, which isn't even
 * loaded yet at this point). The caller decides freshness after the queue
 * arrives — the entry CARRIES its own anchor, so the comparison can be done
 * afterward too, without a new file read.
 *
 * PER-ENTRY FAIL-SOFT: one corrupt file in the directory doesn't take down
 * the REST. The old (read-everything-at-once) pattern would have meant that
 * one half-written file invalidated ALL cached reviews.
 */
export function reviewStoreLoadAll({ repoRoot } = {}) {
  const out = {}
  let names
  try {
    names = fs.readdirSync(reviewStoreDir({ repoRoot }))
  } catch {
    // NO DIRECTORY: first startup with this repo. NOT an error.
    return out
  }
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name)
    if (!m) continue // leftover `.tmp`, a foreign file: skip it
    let raw
    try {
      raw = fs.readFileSync(path.join(reviewStoreDir({ repoRoot }), name), 'utf8')
    } catch {
      continue
    }
    const entry = parseEntry(raw)
    if (!entry) continue
    out[Number(m[1])] = {
      pr: Number(m[1]),
      anchor: entry.anchor,
      findings: entry.findings,
      summary: entry.summary,
      writtenAt: entry.writtenAt,
      // NEVER persisted: at startup EVERY entry is "not loaded", so opening
      // it (`d`, since wf31/6) reloads (the existing logic tied to session
      // identity).
      applied: false,
    }
  }
  return out
}

/**
 * The state of an ALREADY LOADED (from loadAll) entry against the current
 * anchor: `'none'` | `'fresh'` | `'tool-drift'` | `'stale'` — the SAME
 * vocabulary as `reviewStoreRead`'s `state` (the same two predicates decide,
 * from one source).
 *
 * A SEPARATE FUNCTION, because `loadAll` runs BEFORE the queue (there's no
 * `updatedAt` yet at that point), while the comparison is needed AFTER the
 * queue arrives — without a new file read, from the entry's own anchor.
 *
 * THE CALLER SHOULD NOT COMPARE AGAINST A STRING if all it needs is the
 * decision: that's what `reviewStoreStateLoadable` is for. A stray
 * `!== 'fresh'` is exactly the class of bug this change was born from —
 * `tool-drift` would have silently fallen into the "don't load" branch, the
 * way `coreSha` used to.
 */
export function reviewStoreEntryState(entry, anchor) {
  if (!entry) return 'none'
  if (!subjectMatches(entry.anchor, anchor)) return 'stale'
  return toolDrifted(entry.anchor, anchor) ? 'tool-drift' : 'fresh'
}

/**
 * IS this state LOADABLE — the `state` → decision mapping in ONE PLACE.
 *
 * WHY A FUNCTION, AND NOT A COMPARISON AT THE CALL SITE: the `state`
 * vocabulary now has THREE values, and an `=== 'fresh'` scattered across call
 * sites would silently fall into the banning branch when a FOURTH value is
 * introduced — exactly the class of silent loss this commit fixes. Here it's
 * decided in ONE place, so it can't drift apart.
 */
export function reviewStoreStateLoadable(state) {
  return state === 'fresh' || state === 'tool-drift'
}
