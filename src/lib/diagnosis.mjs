// tuipr — DIAGNOSIS: the INTERPRETATION of the conflict diagnosis and the
// progressive measurement.
//
// What lives here: the diagnosis → recommendation mapping (the
// PHANTOM-CULPRIT semantics), the explanation of the dep signal (`i`), the
// progressive-measurement state machine + NDJSON reader + measurement
// launcher, and the info model.
//
// LAYER ORDER: imports downward (merge: the landing blockers; proc: spawn
// diagnosis and NEXT_SH). Imports NOTHING from core or above.
//
// SEPARATE FROM QUEUE-FETCH: the data-source call is the ACQUISITION, this is
// the INTERPRETATION. `fetchDiagnosis` lives here NONETHELESS, because the
// `conflict --json` contract and the `conflictAdvice` that reads it form ONE
// topic — the TUI does NOT reimplement the measurement, it just calls the
// subcommand.
import { canMergeRow, mergeBlockers } from './merge.mjs'
import { NEXT_SH, spawnFailure } from './proc.mjs'
import { spawn, spawnSync } from 'node:child_process'

// --- Conflict diagnosis → recommendation ------------------------------------

/**
 * The TUI's action recommendation from the `tuipr conflict --json` diagnosis.
 *
 * The stacking-recommendation rule is based on a MEASUREMENT (recon tried it
 * out live on #911): we recommend it ONLY if
 *   (a) there is NO conflict with main — otherwise a rebase onto main is
 *       needed first, and stacking would only postpone the real problem, and
 *   (b) there is EXACTLY ONE culprit — stacking can only point at a single PR
 *       at a time, so with more than one culprit it's partial by definition.
 *       #911 had four culprits, and per the measurement, putting all four
 *       into the base (composite base) STILL left a conflict: there, stacking
 *       would have given FALSE confidence — the correct answer is waiting out
 *       the queue order.
 *
 * What we deliberately do NOT check here: whether the colliding file is a
 * generated/lock file (`pnpm-lock.yaml`, `package.json`), and whether the
 * culprit's own base is itself blocked. Per recon these are further
 * disqualifying reasons, but judging them is the user's call — the `summary`
 * names the files so they can SEE what they'd be stacking onto. Stacking only
 * runs with confirmation anyway.
 */
export function conflictAdvice(diag) {
  // The LANDABLE culprits: only these can be stacked onto, and the queue
  // order only resolves these. A `candLandable === false` candidate conflicts
  // with main, so CI skips it — it will never be part of next. (If the field
  // is missing, we're getting a diagnosis under the old contract: there we
  // didn't measure it, so we also can't claim it won't land → we treat it as
  // landable.)
  const all = diag.queueConflicts ?? []
  const landable = all.filter((c) => c.candLandable !== false)
  const unlandable = [
    ...all.filter((c) => c.candLandable === false),
    ...(diag.phantomConflicts ?? []),
  ]
  const culprits = landable.map((c) => c.number)
  const named = landable.map((c) => `#${c.number} (${c.files.join(', ')})`).join(', ')
  // We NAME the PHANTOMS, but NOT as an action item: the user sees the
  // next-conflict label and wants to know why there's nothing to do about it.
  const phantomNote = unlandable.length === 0
    ? ''
    : ` Note: ${unlandable.map((c) => `#${c.number}`).join(', ')} also conflicts with you, `
      + 'but it is not landable itself either (it conflicts with main), so it will not be built into next either — nothing to do about it.'
  // The SEMANTICS OF THE MEASUREMENT vs. the CI's operation. The probe
  // simulates a MERGE with `git merge-tree` (net diff), whereas CI REBASEs
  // commit by commit (NEXT_STRATEGY: rebase, no merge-fallback). MEASURED: on
  // a modify-then-revert PR, merge-tree exits 0 (CLEAN), while `git rebase`
  // hits CONFLICT + exit 1. This difference must be spelled out on every
  // non-blocking verdict, otherwise the user reads "nothing to do" where
  // there is something.
  //
  // WHY A SEPARATE FIELD, AND WHY NOT AT THE END OF THE SUMMARY (the old
  // shape): the caveat is VERBATIM THE SAME on EVERY non-blocking verdict —
  // per the user's report this produces warning fatigue (by the fourth PR
  // they no longer even read it). The panel therefore hides it with
  // progressive disclosure (a closed footnote line + Enter), AND THIS IS ONLY
  // POSSIBLE if the caveat does NOT sit in the same string as the ACTION ITEM
  // (stacking recommendation, "wait for #N to land"). The old code spliced it
  // in via concatenation in FOUR places; disclosure there would have either
  // hidden the action item too, or the view would have had to carve the
  // caveat out with a regex — which is a SECOND, drifting text source.
  //
  // THE SHAPE `{ text, command }`: the COMMAND stands apart because the view
  // renders it in a CYAN line (the panel renders every other actionable
  // command the same way). The command MUST remain visible in some form even
  // in the closed state — this is the UI's ONLY place where the
  // `git rebase origin/next` instruction is voiced, and it rests on a
  // MEASURED fact (merge-tree exit 0 vs. git rebase CONFLICT).
  //
  // THE `--json` PATH IS NOT AFFECTED: there the bash `recommendation` field
  // speaks, which is separate text and carries its own caveat.
  //
  // (wf31/4) THE `detail` FIELD: THE HOME OF THE VERDICT-REDUNDANCY. The
  // user's finding, verbatim: "Verdict clean is the same as 'found no
  // conflict', so 'found no conflict' is already a detail to hide."
  //
  // THE MEASURED DUPLICATION on the clean panel is FOUR lines with THREE
  // identical statements:
  //     ✓ main: no conflict
  //     ✓ within next: no collision (4 candidates measured)
  //     Verdict: clean
  //     The merge-tree probe found NO conflict (4 candidates measured) —
  //     neither with main, nor with those ahead of it in the queue.
  // The fourth line is a SUMMARY of the THREE lines above it, with no new
  // information: "found NO conflict" = `Verdict: clean`, "neither with main,
  // nor with those ahead of it in the queue" = exactly the two measurement
  // lines.
  //
  // THE SOLUTION USES THE EXISTING DISCLOSURE, it doesn't build a new one:
  // the text goes into `caveat.detail`, which `caveatLines` renders on the
  // OPEN branch (Enter-toggle). Closed, only `Verdict: clean` + the one-line
  // `…` affordance remain — exactly what the user asked for.
  //
  // WHY I DIDN'T DELETE IT: the candidate count (`N candidates measured`)
  // states the SCOPE OF THE MEASUREMENT, which is an attestation fact —
  // hiding is not deleting. The `detail` field therefore HIDES, but
  // PRESERVES.
  //
  // WHY INTO THE CAVEAT BLOCK, AND WHY NOT A THIRD TOGGLE: the caveat talks
  // about the same MEASUREMENT (what it simulated, what it doesn't see), and
  // `detail` is the RESULT of that measurement. A second, competing toggle
  // would want two keys for the same concept in an already crowded set.
  const probeCaveat = {
    text: 'The measurement simulates a MERGE, but CI REBASEs — this probe '
      + 'does not see commit-level collisions. The certain answer:',
    command: 'git rebase origin/next <branch>',
    // The `detail` is the BRANCH-SPECIFIC measurement result — on the
    // `clean` branch the "found no conflict" sentence goes here (see there).
    // `null` on the other branches: there the summary carries an ACTION ITEM
    // (stacking, rebase), not redundancy.
    detail: null,
  }

  // The subcommand did NOT measure a STACKED PR (its fate is decided by its
  // base), and its diagnosis is empty queueConflicts + mainConflict=false —
  // meaning the naive branch order would say "no conflict measured", which is
  // A LIE: we didn't even measure. This is the same error class as the
  // "(main-drift)" label was, which is why this branch comes before every
  // other one.
  if (diag.verdict === 'stacked') {
    const on = diag.stackedOn === null || diag.stackedOn === undefined
      ? `the ${diag.baseRef} branch`
      : `#${diag.stackedOn}`
    return {
      offerStack: false,
      stackOn: null,
      command: null,
      // NO CAVEAT: the stacked PR was NOT EVEN MEASURED, so the
      // merge-vs-rebase discrepancy has nothing to apply to here. The `null`
      // (not `''`) is a MACHINE-READABLE answer for the view to the "is
      // there a footnote?" question — an empty string would have rendered an
      // empty, dimmed footnote line.
      caveat: null,
      summary: `This is a STACKED PR: ${on} is its base, so its fate is decided there — next contains it via its base. Diagnose the base.`,
    }
  }
  if (diag.mainConflict) {
    return {
      offerStack: false,
      stackOn: null,
      command: null,
      // NO CAVEAT: here the rebase ITSELF is the action item (the summary
      // says so too), not a measurement caveat. Putting it in a footnote
      // would mean hiding the most important action item.
      caveat: null,
      summary: `REAL conflict with main: ${(diag.mainConflictFiles ?? []).join(', ')} — this blocks landing. Rebase onto main.`,
    }
  }
  if (culprits.length === 0) {
    // A SEPARATE BRANCH for when we MEASURED a conflict, but EVERY culprit is
    // a phantom. The "found NO conflict" text would be A LIE here: we did
    // find one, only the culprits themselves don't land either. The user
    // sees the next-conflict label — they deserve an explanation.
    if (unlandable.length > 0) {
      const namedPhantoms = unlandable.map((c) => `#${c.number} (${c.files.join(', ')})`).join(', ')
      return {
        offerStack: false,
        stackOn: null,
        command: null,
        caveat: probeCaveat,
        summary: `There is NO conflict with main — your landing is not at risk. You collide on `
          + `next (${namedPhantoms}), BUT none of the colliding PRs are landable themselves either `
          + `(all of them conflict with main), so they won't be built into next either. Action `
          + `item: none on your side — the next-conflict label can stay until the next rebuild.`,
      }
    }
    return {
      offerStack: false,
      stackOn: null,
      command: null,
      // (wf31/4) THE MEASUREMENT RESULT MOVED INTO THE CAVEAT'S `detail`, the
      // summary is EMPTY.
      //
      // The user: "Verdict clean is the same as 'found no conflict', so
      // 'found no conflict' is already a detail to hide." The sentence
      // summarized the THREE lines above it (the two measurement lines + the
      // `Verdict: clean`), with no new information — the redundancy is
      // MEASURABLE, not an opinion.
      //
      // (wf31/32) TWO PATHS, TWO TEXTS — AND THE `ci` BRANCH HAS NO CAVEAT.
      //
      // `nextFrom: 'ci'` — the PR IS IN next, so CI's CUMULATIVE rebase went
      // through it cleanly. The merge-vs-rebase caveat does NOT apply here:
      // CI ACTUALLY rebased, we didn't simulate a merge. A caveat tacked on
      // here would suggest we're less certain than we are — and would
      // produce exactly the caveat inflation the user objected to elsewhere.
      // The `detail`, however, STATES how we know.
      //
      // `nextFrom: 'probe'` — a LOCAL pairwise merge-tree. Here the caveat is
      // MANDATORY (the probe simulates a merge, CI rebases), and the
      // candidate count is also relevant.
      caveat: diag.nextFrom === 'ci'
        ? {
            // `text`/`command` ARE OMITTED: there's no caveat to state, and a
            // `git rebase origin/next` instruction would be a meaningless
            // action item on a PR that's ALREADY built in.
            text: '',
            command: '',
            detail: 'There is NO conflict with main (measured), and it has '
              + 'ALREADY BEEN BUILT INTO next — the CI cumulative rebase went '
              + 'through it cleanly. The queue-internal prefix therefore did '
              + 'not need to be measured.',
          }
        : {
            ...probeCaveat,
            detail: `The merge-tree probe found NO conflict (${diag.probed} candidates measured) — `
              + `neither with main, nor with those ahead of it in the queue.`,
          },
      // EMPTY STRING, NOT `null`: the field's TYPE stays string (the
      // `--json` path and the other branches also give a string), so no
      // consumer has to write a null branch. And the view does NOT SPAWN A
      // LINE (`infoBody`) from an empty summary — an empty line descriptor
      // would take up the same HEIGHT as a substantive one, and
      // `clipBodyLines` counts DISPLAYED lines (the wf28/3 gap-line error
      // class).
      summary: '',
    }
  }
  if (culprits.length === 1) {
    const on = culprits[0]
    return {
      // (wf31/68) THE FIELD NAME IS HISTORICAL — IT'S NO LONGER A
      // RECOMMENDATION, BUT A TARGET DESIGNATION.
      //
      // From here on `true` only means: THERE IS a clear stacking target
      // (exactly one landable culprit), so the TUI can offer the `s` key.
      // The TEXT, however, does not recommend — see the reasoning for the
      // summary.
      offerStack: true,
      stackOn: on,
      // Execution goes through the EXISTING publish path — there is no
      // parallel stacking implementation in the TUI.
      command: `tuipr publish --stack-on ${on}`,
      caveat: probeCaveat,
      // (wf31/68) THE "STACKING WILL PROBABLY RESOLVE IT" PROMISE WAS
      // REMOVED — A MEASURED OWN ERROR, AND NOT UNCERTAINTY BUT A MISTAKE.
      //
      // The user's question: "if the conflict requires resolution, why are
      // we recommending stacking at all? It doesn't help with anything." —
      // and derived from the code, they are right, STRUCTURALLY:
      //
      //   · `queueConflicts` contains EXCLUSIVELY real culprits (the bash
      //     `$real` branch: those the merge-tree MEASURED a conflict with);
      //   · so `culprits.length === 1` ⟹ THERE IS a substantive collision
      //     with the target;
      //   · so rebasing onto it requires MANUAL RESOLUTION — always.
      //
      // In other words, there is no case where the offered stacking would
      // run through cleanly. "Probably" cannot be backed by measurement: the
      // claim itself is false. (Verified live on the #911 → #904 pair: the
      // merge-tree gave the same single file as the dry rebase, which
      // conflicted at commit 74.)
      //
      // WHAT STACKING ACTUALLY DOES: it brings forward the same resolution
      // that also has to be done on the "wait for it to land" path — in
      // exchange the PR DROPS OUT OF NEXT until the target lands (the
      // next-rebuild filters on `--base main`, and a stacked PR's base is
      // not main). This latter point had not been stated anywhere until now,
      // and the user rightly believed the opposite.
      //
      // THAT'S WHY THE SUMMARY NOW STATES A FACT, NOT AN ACTION ITEM: the two
      // paths and their cost. Whether you build on it functionally, the
      // machine does NOT know — that's your decision, and the text doesn't
      // act as if it decided for you.
      summary: `There is NO conflict with main — your landing is not at risk. You collide on next with `
        + `the ${named} PR. The resolution is unavoidable: either NOW, by stacking onto #${on} (the rebase `
        + `conflicts in these same files, and the PR drops out of next until #${on} lands), or AFTER #${on} `
        + `lands, by rebasing onto main. #${on} does NOT conflict with main, AS MEASURED, so it can land as `
        + `a stacking target.`
        + `${phantomNote}`,
    }
  }
  return {
    offerStack: false,
    stackOn: null,
    command: null,
    caveat: probeCaveat,
    // (wf31/68) NO PROMISE HERE EITHER — the same fix as on the
    // single-culprit branch.
    //
    // "The queue order will probably resolve it" was equally false: the
    // next-rebuild rebases CUMULATIVELY, so AFTER the culprits are built in,
    // our PR's rebase runs into exactly the same substantive collisions — it
    // gets skipped until the author resolves it. The order doesn't resolve
    // anything, it only postpones it.
    summary: `There is NO conflict with main. You collide on next with ${culprits.length} PRs: ${named}. `
      + `You cannot stack (a PR points at one base at a time) — the resolution happens after the culprits `
      + `land, by rebasing onto main; until then you're left out of next.`
      + `${phantomNote}`,
  }
}

// --- "Why dep?" — the explanation of the dep signal ('i' key) --------------

/** How many shared files to list before switching to "+N more". */
const DEP_FILES_SHOWN = 8

/**
 * The EXPLANATION of the dep signal for one row: in which files there is an
 * intersection with the dep PR.
 *
 * A PURE function: its input is the row built from `queue --json`
 * (buildRows), no process call, no network. We do NOT compute the
 * intersection here — the queue's jq gives that (depFiles), in the same pass
 * that also derives the dep number. This is deliberate: there is one
 * intersection logic, and the explanation must not diverge from the signal
 * it explains.
 *
 * The file list being UNKNOWN (there is a dep, depFiles is empty) is a
 * separate field, not "no shared files": the queue's dep computation is
 * FAIL-CLOSED, so it also reports a dep when data is missing (GitHub limits
 * the files list on large PRs). There, an "empty intersection" would look
 * like a false measured fact — it must be stated that it's not knowable.
 */
export function depExplanation(row, shown = DEP_FILES_SHOWN) {
  // A stacked row doesn't have a "dep", it has a BASE: its base sits in the
  // queue, and its fate is decided there. The dep axis is not defined there
  // (the model's dep is also null), so it gets a separate sentence, not "no
  // dep".
  if (row.stackedOn !== null && row.stackedOn !== undefined) {
    return {
      hasDep: false,
      dep: null,
      files: [],
      shown: [],
      more: 0,
      moreLabel: '',
      filesUnknown: false,
      summary: `#${row.number} is a stacked PR — its base is #${row.stackedOn}, its fate is decided there. Look at #${row.stackedOn}'s row.`,
    }
  }
  if (!row.dep) {
    return {
      hasDep: false,
      dep: null,
      files: [],
      shown: [],
      more: 0,
      moreLabel: '',
      filesUnknown: false,
      summary: `#${row.number}: no dep — it has no file intersection with any of the open PRs ahead of it in the queue.`,
    }
  }
  const files = Array.isArray(row.depFiles) ? row.depFiles : []
  const filesUnknown = files.length === 0
  const head = files.slice(0, shown)
  const more = Math.max(0, files.length - head.length)
  return {
    hasDep: true,
    dep: row.dep,
    files,
    shown: head,
    more,
    moreLabel: more > 0 ? `… +${more} more` : '',
    filesUnknown,
    summary: filesUnknown
      // Fail-closed with missing dep data: the fact of the dependency
      // stands, the WHAT-IN does not.
      ? `#${row.number} depends on #${row.dep}, but the list of shared files is NOT knowable (the files data is missing — GitHub limits it on large PRs). We report the dependency fail-closed.`
      : `#${row.number} shares with #${row.dep}: ${head.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`,
  }
}

/**
 * `tuipr conflict <PR> --json` → diagnosis object.
 *
 * The TUI does NOT reimplement the merge-tree measurement: it calls the
 * subcommand. This is the same principle by which we also don't recompute
 * the queue model here — the duplicated decision chain is what produced the
 * drift that package (b) eliminated.
 *
 * The error IS THROWN, we don't swallow it: a silent empty diagnosis would
 * lead the caller to believe there's no conflict.
 */
export function fetchDiagnosis(pr) {
  const res = spawnSync('bash', [NEXT_SH, 'conflict', String(pr), '--json'], { encoding: 'utf8' })
  const spawnErr = spawnFailure(res, 'bash')
  if (spawnErr) throw new Error(`could not fetch the diagnosis for #${pr}: ${spawnErr}`)
  if (res.status !== 0) {
    throw new Error(`conflict --json error (exit ${res.status}): ${(res.stderr || res.stdout || '').trim() || '(no output)'}`)
  }
  return JSON.parse(res.stdout)
}

// --- The 'i' (info) panel: fast part + PROGRESSIVE, ABORTABLE measurement --
//
// WHY ONE KEY. There used to be two panels: 'i' = "why dep?" (instant, from
// the queue model) and 'c' = conflict diagnosis (expensive, `tuipr
// conflict`). From the user's point of view, though, there is ONE question —
// "what's going on with this PR, and why?" — and they had to know which key
// gives which half. The user's decision: "run the measurement, just don't
// let it take minutes; if you can display it progressively and also abort
// it, that settles the question."
//
// THE COST ASYMMETRY doesn't disappear, it's just not pushed onto the user:
// the fast part renders IMMEDIATELY (zero wait), while the expensive part
// loads in the background, with a live status line, abortable with Esc. The
// 'd'/'r' (free vs. token) asymmetry, by contrast, REMAINS two keys: there
// the expensive path has an EXTERNAL effect (spends tokens), so it requires
// confirmation. The measurement is read-only and local — there's nothing to
// confirm, only to abort.

/**
 * One `--progress` NDJSON line into an event object.
 *
 * FAIL-CLOSED, at two points:
 *   - a non-JSON line IS THROWN, we don't skip it. A silent skip would give
 *     the impression that the measurement is progressing, when in fact the
 *     measurer is already producing incoherent output (e.g. after a future
 *     format change) — the status line would sit at "3/7" forever.
 *   - the `pr` field is MANDATORY. Stale-dropping is built on this: without
 *     a PR number we cannot tie the event to a row, so the race protection
 *     would be lost, and another PR's measurement could slip through onto
 *     the selected row.
 */
export function parseProgressEvent(line) {
  let ev
  try {
    ev = JSON.parse(line)
  } catch (error) {
    throw new Error(`the progress event cannot be parsed as JSON: ${error.message} — raw line: ${line}`)
  }
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
    throw new Error(`the progress event is not an object: ${line}`)
  }
  if (typeof ev.event !== 'string' || ev.event === '') {
    throw new Error(`the progress event is missing the \`event\` key: ${line}`)
  }
  if (typeof ev.pr !== 'number' || !Number.isFinite(ev.pr)) {
    throw new Error(`the progress event is missing the \`pr\` number: ${line} — without it, it cannot be tied to the selected row (race protection)`)
  }
  return ev
}

/** The start of measurement state for ONE PR. The `pr` is the stale-drop anchor. */
export function progressInit(pr) {
  return { pr, running: true, done: 0, total: 0, diag: null, aborted: false, error: null }
}

/**
 * Applying an event to the measurement state. PURE: returns a new object.
 *
 * TWO DROP RULES, each closing off a real error class:
 *   1) STALE PR: we drop the event where `ev.pr !== st.pr`. A live race: the
 *      #911 measurement is running, the user navigates to #905, a
 *      measurement starts there too, and #905's result arrives FIRST — #905's
 *      conflicts would end up in #911's panel.
 *   2) AFTER ABORT: a `result` that arrives late into an aborted measurement
 *      is also not written in. The child's kill is ASYNCHRONOUS (an
 *      already-written line can be sitting in the pipe), so a complete
 *      diagnosis could overwrite "aborted at 3/7" — the user would read as a
 *      measured fact what they just aborted.
 */
export function progressReducer(st, ev) {
  if (ev.pr !== st.pr) return st
  if (st.aborted) return st
  switch (ev.event) {
    case 'start':
      return { ...st, total: typeof ev.total === 'number' ? ev.total : st.total }
    case 'probe':
      return {
        ...st,
        done: typeof ev.done === 'number' ? ev.done : st.done,
        total: typeof ev.total === 'number' ? ev.total : st.total,
      }
    case 'result':
      // The ABSENCE of `diagnosis` is not an "empty diagnosis": that is the
      // measurer breaching the contract. Silently writing in a null
      // diagnosis would give the impression that there's no conflict.
      if (ev.diagnosis === null || typeof ev.diagnosis !== 'object') {
        return { ...st, running: false, error: 'the `result` event from the measurer arrived without a diagnosis — the output contract was violated' }
      }
      return { ...st, running: false, diag: ev.diagnosis }
    case 'error':
      // AN ERROR NEVER TURNS INTO A DIAGNOSIS: diag stays null, and the
      // error shows.
      return { ...st, running: false, diag: null, error: String(ev.message ?? 'unknown measurement error') }
    default:
      // Unknown event type: we do NOT throw (a newer measurer version may
      // add an extra event), but we also don't interpret it — the state is
      // unchanged.
      return st
  }
}

/** Aborting the measurement. The PARTIAL result (done/total) is kept — see progressLabel. */
export function progressAbort(st) {
  if (!st.running) return st
  return { ...st, running: false, aborted: true }
}

/**
 * Applying a measurement event to the INFO PANEL state — the PANEL-LEVEL
 * stale protection. PURE: for a stale event it returns the RECEIVED state
 * (reference-identical), so the React setState stays a no-op.
 *
 * WHY THIS IS NEEDED ALONGSIDE progressReducer: the reducer closes off
 * `ev.pr !== st.pr`, i.e. another PR's event landing in a measurement. The
 * check here is a different error class: the user opened a panel on a
 * DIFFERENT row in the meantime (j/k), and the old measurement's callback
 * would write into the NEW panel's state. The `pr` is the row number at the
 * time the measurement was started; if that's no longer the panel's row, the
 * event is to be dropped — otherwise the user would read another PR's
 * measured conflict fact (or measurement error) in the fresh panel.
 *
 * `null` info (panel closed in the meantime) and `progress: null`
 * (non-measurable, stacked row) also go back unchanged: a closed/non-
 * measuring panel doesn't come back to life.
 */
export function applyProgressToInfo(cur, pr, ev) {
  if (!cur || cur.row.number !== pr || !cur.progress) return cur
  return { ...cur, progress: progressReducer(cur.progress, ev) }
}

/** The status line from the measurement state. States MEASURED numbers, doesn't estimate. */
export function progressLabel(st) {
  if (!st) return ''
  if (st.error) return `measurement error: ${st.error}`
  if (st.aborted) {
    // We only print the DENOMINATOR if we MEASURED it (the `start` event
    // arrived). Before that "at 0/0 candidates" would read as a measured
    // fact ("there were zero candidates"), when in fact we didn't know the
    // candidate count yet — measured live on a measurement aborted at 80 ms.
    return st.total > 0
      ? `measurement aborted at ${st.done}/${st.total} candidates`
      : 'measurement aborted (before the candidate list)'
  }
  if (st.running) {
    // total is 0 until the `start` event has arrived — in that case we do
    // NOT guess the denominator ("3/?"), because a false denominator
    // suggests false progress.
    return st.total > 0 ? `measuring: ${st.done}/${st.total} candidates…` : 'measurement starting…'
  }
  if (st.diag) return `measurement done (${st.diag.probed ?? st.done} candidates measured)`
  return ''
}

/**
 * The info panel's model: the FAST part (instant) + the SLOW part
 * (progressive).
 *
 * The split is by COST, not by topic: everything that is ALREADY THERE in
 * the queue model (dep intersection, mergeMethod, landing blockers,
 * stacked-info) goes into `fast` and renders with zero wait; whatever
 * requires MEASUREMENT (merge-tree probes) goes into `slow`, and only
 * appears once it has arrived. `slow.state` makes this machine-readable:
 *   idle | measuring | done | aborted | error
 *
 * `measurable` says whether there is anything to measure at all. A STACKED
 * row is not measurable: its fate is decided by its base, and a probe
 * measured against it would show the base's conflicts as its own (the bash
 * side also excludes this on a separate branch).
 */
export function buildInfoModel({ row, progress = null }) {
  const dep = depExplanation(row)
  const stacked = row.stackedOn !== null && row.stackedOn !== undefined
  const fast = {
    dep,
    state: row.state,
    mergeMethod: row.mergeMethod ?? null,
    // The BRANCH NAME from the model, RAW. Truncation belongs to the view
    // (that's where the frame's inner width is known), but the name must
    // come from the MODEL so the render doesn't grope at the row —
    // `headRefName` is the method's source, so it must come from the same
    // record as `mergeMethod`, otherwise the two could drift apart (e.g. on
    // a partial refresh).
    headRefName: typeof row.headRefName === 'string' ? row.headRefName : '',
    stackedOn: stacked ? row.stackedOn : null,
    // The landing blockers come from the same pure function the merge
    // confirmation screen uses — one rule, two displays.
    landableBlockers: canMergeRow(row) ? [] : mergeBlockers(row),
    // THE PROVIDER SIGNAL, PASSED THROUGH: `classification` only exists in
    // the MEASURING provider (the gh/git provider deliberately doesn't
    // populate it). The view uses this to decide whether it can display the
    // integration branch's rebuild state — without it, MEASURED and INFERRED
    // knowledge would blur together.
    classification: row.classification ?? null,
  }
  const measurable = !stacked
  let slow = { state: 'idle', diag: null, advice: null, label: '', error: null }
  if (progress) {
    if (progress.error) {
      slow = { state: 'error', diag: null, advice: null, label: progressLabel(progress), error: progress.error }
    } else if (progress.aborted) {
      // WE DO NOT STATE A CONFLICT FACT FROM AN ABORTED MEASUREMENT: diag
      // stays null, only the partial result ("3/7") shows. An interrupted
      // series of probes proves neither a conflict nor its absence.
      slow = { state: 'aborted', diag: null, advice: null, label: progressLabel(progress), error: null }
    } else if (progress.diag) {
      slow = {
        state: 'done',
        diag: progress.diag,
        // The recommendation is DERIVED from the MEASURED diagnosis — the
        // same pure function the old 'c' panel used. The measurement path
        // changed, the decision did not.
        advice: conflictAdvice(progress.diag),
        label: progressLabel(progress),
        error: null,
      }
    } else if (progress.running) {
      slow = { state: 'measuring', diag: null, advice: null, label: progressLabel(progress), error: null }
    }
  }
  return { row, measurable, fast, slow }
}

/**
 * Launching the measurement AS A STREAM: `tuipr conflict <PR> --progress`.
 *
 * WHY spawn (async) and not spawnSync: spawnSync FREEZES Ink's render loop
 * for the entire duration of the measurement — you could neither navigate
 * nor quit, and this was exactly the old 'c' panel's problem (7 candidates
 * on #911, seconds). With the async path the UI stays usable throughout.
 *
 * `spawn` is INJECTABLE (opts.spawn): this makes the stream handling — the
 * line-by-line buffering, the kill, the exit and ENOENT branches —
 * unit-testable without a real child process.
 *
 * THE ERROR BRANCHES ARE SEPARATE, because they deserve different
 * diagnoses:
 *   - non-zero exit WITHOUT `result` → the measurer crashed (we pass through
 *     stderr),
 *   - `error` event with ENOENT → the bash/script itself is not found. This
 *     must be distinguished via `res.error?.code`; as an exit code it would
 *     look like "null", and would give a false "the measurement returned
 *     empty" diagnosis.
 *
 * NO MORE EVENTS AFTER ABORT (a measured race, it WAS A BLOCKER):
 * `child.kill()` is ASYNCHRONOUS, and Node emits the stdout `data` event even
 * AFTER the kill for bytes ALREADY SITTING in the pipe (measured at 0/5/20/100
 * ms delay, all of them). So the interrupted probe series' `result` arrived
 * ANYWAY, and whoever didn't filter it took it as a measured fact: the list
 * gave a `✓` DONE marker to a PR that was never even measured, and reopening
 * `i` served the "no conflict" picture from the cache.
 *
 * THIS IS WHY THE GUARD IS HERE, AT THE SOURCE, not with the consumers: the
 * panel side (`progressReducer`: `if (st.aborted) return st`) was already
 * protected, the cache write WAS NOT — the two layers stated DIFFERENT
 * things about the same measurement. With a source-side suppression every
 * consumer improves at once, and the filtering doesn't need to be repeated
 * at every new call site (the missing repetition was the bug).
 */
export function startProgressDiagnosis(pr, { onEvent, onExit, spawn: spawnImpl = spawn } = {}) {
  const child = spawnImpl('bash', [NEXT_SH, 'conflict', String(pr), '--progress'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let buf = ''
  let stderr = ''
  let sawResult = false
  let finished = false
  let aborted = false

  const finish = (info) => {
    if (finished) return
    finished = true
    onExit?.(info)
  }

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => {
    // SILENT AFTER ABORT: the output of an aborted measurement is not a
    // fact. We also stop growing the buffer — there's no one to hand the
    // remainder of the interrupted stream to.
    if (aborted) return
    buf += chunk
    // LINE-BY-LINE parse: a half line is NOT parseable (would be a JSON
    // error), so we keep the remainder in the buffer until the next chunk.
    // The pipe's chunk boundary can be anywhere — live, the `result` (a
    // large object) regularly gets cut in two.
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line === '') continue
      let ev
      try {
        ev = parseProgressEvent(line)
      } catch (error) {
        // A parse error is LOUD: the stream's contract was violated, so the
        // measurement's result is not knowable. Skipping it silently would
        // leave the status line stuck forever.
        finish({ error: error.message })
        child.kill?.()
        return
      }
      if (ev.event === 'result') sawResult = true
      onEvent?.(ev)
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => { stderr += chunk })

  // THE SCRIPT IS SIMPLY NOT PART OF THIS BUILD, and saying so beats reporting
  // a crash. The measurement runs a script that has not been generalized yet
  // (see ROADMAP, "What still calls the original script"). Without this branch
  // the user is told "the measurer crashed (exit 127)" followed by an absolute
  // path — every word true, and none of it answering the only question they
  // have, which is whether they broke something. They did not; the feature is
  // not here yet.
  // KEPT SHORT ON PURPOSE: the panel clamps this line to the frame width, and a
  // sentence that gets cut off mid-word answers nothing. The line below it
  // ("the measurement did NOT run") already carries the warning, so this only
  // has to say why.
  const MISSING_MEASURER = 'not wired up in this build yet — see ROADMAP'

  child.on('error', (error) => {
    // ENOENT separate: "bash not found" is NOT the same as a crashed
    // measurement.
    finish({
      error: error?.code === 'ENOENT'
        ? MISSING_MEASURER
        : `the measurer cannot be started: ${error?.message ?? String(error)}`,
    })
  })
  child.on('close', (code) => {
    if (aborted) { finish({ aborted: true }); return }
    if (code === 0 && sawResult) { finish({ ok: true }); return }
    // NON-ZERO exit OR a 0 without a result: both are errors. "exit 0, but
    // no result" is one too, because the caller would otherwise get an empty
    // panel and read it as "no conflict".
    finish({
      error: code === 0
        ? 'the measurer returned 0, but did not give a `result` event — the output is truncated'
        // Exit 127 is the shell's own "command not found": bash started, the
        // script did not exist. Same situation as the ENOENT above, reached by
        // a different route, so it gets the same answer.
        : code === 127
          ? MISSING_MEASURER
          : `the measurer crashed (exit ${code}): ${stderr.trim() || 'no stderr'}`,
    })
  })

  return {
    /**
     * Aborting: we KILL the child so no zombie merge-tree probe is left
     * running in the background. The caller marks the partial result already
     * received with progressAbort — a `result` arriving late here is dropped
     * by the reducer (see the abort rule there).
     */
    abort() {
      aborted = true
      child.kill?.('SIGTERM')
    },
  }
}
