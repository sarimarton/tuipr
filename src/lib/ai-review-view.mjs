// tuipr — AI-REVIEW-VIEW: the AI review's VISIBILITY.
//
// What lives here: the elapsed-time formatter, the progress label, the
// mapping of the SEVEN end states, the `r` lifecycle key and its label, and
// the rows of the panel's AI section.
//
// SEPARATE FROM RUN, because this is PURE FORMATTING (the tests cover it
// this way too): execution has side effects, rendering doesn't. run IMPORTS
// AI_REVIEW_TIMEOUT_MS from here (for the watchdog) — the direction is
// ONE-WAY, view requests NOTHING from run (measured).
//
// LAYERING: imports downward (layout: the panel rows' measured wrapping in
// CELLS).
import { clampCells, wrapCells } from './layout.mjs'
import process from 'node:process'

// === THE BACKGROUND REVIEW'S VISIBILITY ====================================
//
// THE USER'S REPORT (#904), verbatim: "I started a review on #904, but it's
// just a few lines of change, and after 5 minutes I see no feedback
// anywhere, the app still shows the message above. […] I checked back a few
// hours later, and it says 'aborted'. This isn't a great experience."
//
// THE DIAGNOSIS found THREE, MUTUALLY INDEPENDENT bugs — and the "aborted"
// was NOT what it looked like:
//
//  1. The `done` promise stayed PENDING FOREVER (see the comment on
//     `startAgentReview`'s close branch). `showError` therefore NEVER ran,
//     and the status line stayed on "the AI review is running in the
//     BACKGROUND" forever. This is the root of "no feedback after 5
//     minutes".
//  2. THERE WAS NO PROGRESS: the static status got printed, and nothing
//     after that. `--output-format json`, measured, gives ONE big JSON at
//     the END (stdout EMPTY in between), so there was nothing to stream in
//     the first place.
//  3. THE END STATES GOT MIXED TOGETHER: a single `if (outcome.aborted)`
//     branch wrote "aborted", which is a LIE in every case not triggered by
//     the user.
//
// THE MEASURED TIMES (mobile `claude-code-review.yml`, n=76 successful
// runs, two stuck outliers filtered out): p50 = 440 s (7:20), p75 = 619 s,
// p90 = 1037 s (17:17), p95 = 1186 s, max = 1866 s (31:06). The user's
// 5-minute wait was therefore BELOW THE MEDIAN: the feature isn't slow —
// the FEEDBACK was missing. That's why the signal STATES the typical time
// outright: a "2:14 / typical 7:20" pair reassures on its own.

/**
 * THE BACKGROUND REVIEW'S CEILING. Close to the MEASURED maximum (31:06):
 * it doesn't cut off legitimate long reviews, but it does cut off infinite
 * hangs.
 *
 * WHY OUR OWN WATCHDOG and not a CLI flag: `claude --help` (2.1.220),
 * measured, doesn't know `--timeout` or `--max-turns`. What exists
 * (`--max-budget-usd`) is for API spend — the user, though, consumes a
 * subscription limit, and there's nothing to cut in dollars there. The
 * ceiling is therefore OUR responsibility.
 */
export const AI_REVIEW_TIMEOUT_MS = Number(process.env.TUIPR_AI_REVIEW_TIMEOUT_MS) > 0
  ? Number(process.env.TUIPR_AI_REVIEW_TIMEOUT_MS)
  : 1_800_000

/**
 * THE TYPICAL (p50) time — MEASURED, not estimated. THIS IS WHAT WE SHOW the
 * user: the elapsed time alone isn't information ("2:14" — is that a lot?
 * a little?), measured against the typical it becomes one.
 */
export const AI_REVIEW_TYPICAL_MS = 440_000

/** The p90 — above this the signal starts to WARN rather than reassure. */
export const AI_REVIEW_P90_MS = 1_037_000

/**
 * The threshold of "long run": we count up to here, after which the tone
 * changes too ("still running, that's normal for a big PR"). The user was
 * already unsure at 2 minutes.
 */
export const AI_REVIEW_LONG_MS = 120_000

/**
 * ELAPSED TIME in `m:ss` form.
 *
 * WHY NOT `134s`: the minute-sense is needed for the decision (measured
 * against the typical 7:20), and a raw second count doesn't give that. The
 * seconds are ZERO-PADDED: `2:4` is easy to misread, and the row's width
 * would jitter on every tick.
 *
 * FAIL-CLOSED: a negative or non-number input THROWS. A `-1:-1` shape in
 * the status line would silently lie about the measurement — exactly the
 * class the feature forbids everywhere else.
 */
export function formatElapsed(ms) {
  // THE TYPE CHECK IS STRICT, NOT a `Number()` CONVERSION. MEASURED TRAP:
  // `Number(null) === 0` and `Number('') === 0`, so a missing measurement
  // would SILENTLY give "0:00" — the status line would show the review as
  // having just started, even though there's no measurement at all. Exactly
  // the silent lie the feature forbids.
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    throw new Error(`elapsed time is not a MEASURED value: ${JSON.stringify(ms)}`)
  }
  const n = ms
  const total = Math.floor(n / 1000)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

/**
 * THE RUNNING background-review status line — the answer to "is it still
 * alive?".
 *
 * THE THREE PIECES OF INFORMATION, in order of usefulness:
 *  1. ELAPSED TIME + TYPICAL TIME — this alone answers the user's question;
 *  2. FINDING COUNT — the REAL progress ("3 findings written"), from
 *     periodic reads of the hunk session (MEASURED cost: 0.42 s/call
 *     alongside a live TUI);
 *  3. TOOL SIGNAL — from the `stream-json` `tool_use` blocks (MEASURED: the
 *     stream immediately gives `system/init`, then per-message tool_use).
 *
 * THE ABORT PATH IS ALWAYS INCLUDED: the user didn't know for 5 minutes
 * whether they could stop it.
 */
export function aiReviewProgressLabel({ pr, elapsedMs, findings = 0, tool = null, xArmed = false }) {
  const elapsed = formatElapsed(elapsedMs)
  // THE WORD "BACKGROUND" STAYS IN: this signal REPLACES the old static
  // status line, so it has to carry the same contract — the user knows from
  // this that the TUI stays USABLE (can navigate, close the panel) while
  // the review runs. The old test ("the TUI stays RESPONSIVE DURING a
  // background review") guards exactly this word, and rightly so: without
  // it the signal reads like the progress of a blocking operation.
  const parts = [`#${pr}: AI review running in the BACKGROUND — ${elapsed}`]
  // THE TYPICAL TIME IS THE ANCHOR: without it, the elapsed time is a bare
  // number.
  if (elapsedMs >= AI_REVIEW_P90_MS) {
    // ABOVE p90 we warn: at this point it really is longer than usual.
    parts.push(`longer than usual (p90: ${formatElapsed(AI_REVIEW_P90_MS)})`)
  } else if (elapsedMs >= AI_REVIEW_LONG_MS) {
    // ABOVE 2 MINUTES WE REASSURE. The user's complaint was precisely that
    // even after 5 minutes they didn't know if something was wrong —
    // against the typical 7:20, it wasn't.
    parts.push(`still running, normal for a big PR (typical: ${formatElapsed(AI_REVIEW_TYPICAL_MS)})`)
  } else {
    parts.push(`typical: ${formatElapsed(AI_REVIEW_TYPICAL_MS)}`)
  }
  // THE FINDING COUNT is the REAL progress — but only when there's
  // something to say ("0 findings written" in the first second would just
  // be noise).
  if (Number(findings) > 0) parts.push(`${Number(findings)} findings written`)
  if (tool) parts.push(String(tool))
  // THE ABORT KEY IS VISIBLE, at the END of the signal. THE DOUBLE-X
  // confirmation (the user's request, verbatim): after the first `x` the
  // label switches to "confirm abort" — the second `x` executes, any other
  // key cancels.
  parts.push(xArmed ? 'x: confirm abort' : 'x: abort')
  return parts.join(' · ')
}

/**
 * THE BACKGROUND REVIEW'S END STATES — SEVEN BRANCHES, EACH WITH ITS OWN
 * MESSAGE.
 *
 * THIS IS THE POINT OF THE FIX. The old code knew ONE branch:
 *   `if (outcome.aborted) setStatus('the AI review was aborted')`
 * — and the user saw this hours later, after a review that had run into a
 * permission denial. "Aborted" ASSERTS that the USER decided; if they
 * didn't, this is a lying signal, and the worst kind: it takes the real
 * cause (and the fix) away from view.
 *
 * THE SEVEN BRANCHES AREN'T A STYLE CHOICE: each prescribes a DIFFERENT
 * ACTION for the user.
 *   `done`           → review the findings (`d` opens them), then `f`
 *   `done-answer`    → the hunk wasn't alive: findings stored from the
 *                      RESPONSE — `d` loads them (the hybrid (c) branch)
 *   `no-findings`    → nothing to do, but know it RAN (not an error)
 *   `aborted`        → you aborted it; `r` restarts
 *   `timeout`        → the ceiling ran out; raise the ceiling or narrow the PR
 *   `failed`         → claude crashed; stderr says what
 *   `killed-by-exit` → closing the TUI killed it; DON'T close it while it runs
 *
 * FAIL-CLOSED: an unknown `kind` THROWS. A silent default text would be
 * exactly the old catch-all branch smuggled back in, just hidden now.
 */
export function aiReviewOutcome(o) {
  const pr = o?.pr
  switch (o?.kind) {
    case 'done': {
      const meta = [o.reviewPath, o.model ?? '?', o.costUsd === undefined || o.costUsd === null ? '$?' : `$${o.costUsd}`]
        .filter((x) => x !== undefined && x !== null)
        .join(', ')
      return {
        kind: 'done',
        isError: false,
        message:
          `#${pr}: ${o.added} AI findings written into the hunk session (${meta}). `
          + "Review them ('d'), delete the bad ones, then 'f' to upload.",
      }
    }
    case 'done-answer': {
      // THE HYBRID (c) branch: the hunk session wasn't alive, but the
      // findings were stored FROM THE REVIEW'S RESPONSE. A "run it again"
      // style message is FORBIDDEN here: the spend already happened, and
      // the response JSON exists exactly so a re-spend isn't needed — the
      // next step is LOADING, not reviewing.
      const meta = [o.reviewPath, o.model ?? '?', o.costUsd === undefined || o.costUsd === null ? '$?' : `$${o.costUsd}`]
        .filter((x) => x !== undefined && x !== null)
        .join(', ')
      return {
        kind: 'done-answer',
        isError: false,
        message:
          `#${pr}: ${o.added} AI findings STORED from the review's response (${meta}) — the hunk session `
          + 'wasn\'t alive during the run, but the findings were NOT lost. '
          + '`r` on the PR panel opens the hunk and loads them.',
      }
    }
    case 'no-findings':
      // NOT AN ERROR OVERLAY: the gate throwing used to show this as an
      // "AI review error", when the most common cause is that there simply
      // was nothing to report. The tone, though, isn't purely reassuring
      // either: per the measured trap, even a review that never ran can
      // give 0 findings, so the user needs to know that `r` re-running is a
      // legitimate response.
      return {
        kind: 'no-findings',
        isError: false,
        message:
          `#${pr}: the AI review RAN, but wrote no findings at all `
          + `(${o.before ?? 0} before, ${o.after ?? 0} after). This could be good news `
          + "(no defects), but the successful envelope doesn't prove it — if in doubt, 'r' restarts it.",
      }
    case 'aborted':
      // ONLY for a REAL user abort. The `x` (the path advertised on the
      // status line).
      return {
        kind: 'aborted',
        isError: false,
        message:
          `#${pr}: you aborted the AI review ('x') — the findings written into the hunk session so far `
          + "REMAIN ('d' opens them). 'r' restarts the review.",
      }
    case 'timeout':
      return {
        kind: 'timeout',
        isError: false,
        message:
          `#${pr}: the AI review stopped on TIMEOUT (${formatElapsed(o.timeoutMs ?? AI_REVIEW_TIMEOUT_MS)} `
          + `ceiling; the measured typical is ${formatElapsed(AI_REVIEW_TYPICAL_MS)}, the longest measured 31:06). `
          + 'The findings already written remain. What to do: check them with `d`, and if the PR is '
          + 'genuinely large, raise the ceiling (`TUIPR_AI_REVIEW_TIMEOUT_MS`) or restart with `r`.',
      }
    case 'failed': {
      // THE FIRST LINE OF STDERR: the status line is ONE LINE, and a
      // multi-line stack trace would bury the point. The full text lives in
      // the error overlay.
      const first = String(o.stderr ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '')[0] ?? '(no stderr)'
      // THE SIGNAL-KILLED PROCESS GETS ITS OWN BRANCH — the REMAINING piece
      // of the #904 error class.
      //
      // MEASURED FACT: if `claude` is NOT killed BY US (OOM killer, `pkill`,
      // the machine sleeping, the shell's SIGHUP), Node's `close` event
      // gives `code === null` — the exit happened VIA SIGNAL. Measured in
      // isolation, `parseAgentReviewEnvelope`'s `status !== 0` branch
      // catches it, with `exitCode: null`.
      //
      // THE LIE this replaces: `o.exitCode ?? '?'` turned the `null` into
      // `'?'`, and stderr was empty, so the user saw THIS:
      //   "the AI review FAILED (exit ?): (no stderr)"
      // The same harm as the old "aborted": the text doesn't say WHAT
      // happened, doesn't say it's NOT the user's fault, and gives no next
      // step. After a review that ran for HOURS, this is the most likely
      // real ending.
      if (o.exitCode === null || o.exitCode === undefined) {
        // THE SIGNAL'S NAME IS THE DIAGNOSIS, NOT DECORATION. It comes from
        // the SECOND argument of `close` (the core `startAgentReview` hangs
        // it onto the error), and marks THREE SEPARATE next steps:
        //   SIGKILL → the OOM killer or `kill -9`: the machine ran out of
        //             memory, or someone killed it forcibly. Remedy: less
        //             parallel work, or a narrower PR.
        //   SIGTERM → an ORDERLY shutdown request (system shutdown, a
        //             `pkill`, a process manager). Not a memory issue.
        //   SIGHUP  → the TERMINAL closing / the session ending.
        // THE NAMELESS CASE ISN'T SILENT EITHER: we state outright that we
        // DON'T KNOW the cause. Honesty is the point here — the old "exit
        // ?" gave the impression that we knew something (a code), when we
        // didn't.
        const sig = typeof o.signal === 'string' && o.signal.trim() !== '' ? o.signal.trim() : null
        const hint = sig === 'SIGKILL'
          ? ' `SIGKILL` is typically the OOM killer or a `kill -9` — the machine may have run out of memory.'
          : sig === 'SIGTERM'
          ? ' `SIGTERM` was an ORDERLY shutdown request (system shutdown, `pkill`, process manager).'
          : sig === 'SIGHUP'
          ? ' `SIGHUP` is the terminal/session ending — the shell running the TUI closed.'
          : ''
        return {
          kind: 'failed',
          isError: true,
          message:
            `#${pr}: a SIGNAL killed the AI review from the outside `
            + (sig === null
              ? '(the process didn\'t exit with a code, and we DON\'T KNOW the signal\'s name — so '
                + 'we can\'t name the cause). '
              : `(\`${sig}\`, didn't exit with a code).${hint} `)
            + 'This could be external intervention: the machine went to sleep, the OOM killer stepped in, or someone '
            + '`pkill`\'d claude — NOT your fault, and NOT a review error either.'
            + `${String(o.stderr ?? '').trim() === '' ? '' : ` stderr: ${first}`} `
            + 'The findings already written remain (`d` opens them); `r` restarts the review.',
        }
      }
      // THE TOKEN SPEND IS STATED OUTRIGHT — IN BOTH DIRECTIONS. "We didn't
      // spend" isn't a footnote: it's the reassuring information that
      // decides whether a retry is free.
      const spend = Number(o.costUsd) > 0
        ? `tokens WERE SPENT: $${o.costUsd}`
        : 'no tokens were spent (or it isn\'t measurable)'
      return {
        kind: 'failed',
        isError: true,
        message: `#${pr}: the AI review FAILED (exit ${o.exitCode ?? '?'}): ${first} — ${spend}.`,
      }
    }
    case 'killed-by-exit':
      // KILLED by the exit. The most likely real ending of the user's #904
      // case, which the old "aborted" DIDN'T state — and which is NOW asked
      // about BEFORE the exit too (see the app's exit warning).
      return {
        kind: 'killed-by-exit',
        isError: false,
        message:
          `#${pr}: closing the TUI interrupted the AI review (\`claude -p\` writes into the hunk `
          + 'session, so it can\'t be left running after exit). The findings already written '
          + 'remain. If you want it to run to completion, don\'t quit while it\'s running.',
      }
    default:
      throw new Error(
        `unknown AI review end state: ${JSON.stringify(o?.kind)}. A silent default text is `
        + 'FORBIDDEN: it would be exactly the catch-all branch that produced the #904 lying "aborted".',
      )
  }
}

/**
 * THE `r` LIFECYCLE STATE for a PR: 'idle' | 'running' | 'done'.
 *
 * THE USER'S EXPLICIT REQUEST (4th live test): `r` is a state-dependent key —
 *   idle    → start (confirmation panel, as before);
 *   running → disabled (the "already running" hint stays), the footer gives
 *             a dimmed signal;
 *   done    → OPEN THE REVIEW (hunk + load + --agent-notes).
 *
 * 'done' CAN COME FROM TWO SOURCES: the session's AI-review state (done /
 * done-answer), OR the cached, not-yet-loaded response findings (the state
 * may already be serving a DIFFERENT PR — the cache is keyed by PR).
 * RE-REVIEWING is NOT allowed from the 'done' state: restarting requires the
 * explicit discard precondition (double-`x` → cacheDiscardAiFindings + the
 * state being cleared).
 *
 * The closed-but-fruitless end states (no-findings / aborted / timeout /
 * killed-by-exit / failed) give 'idle': there `r` is a legitimate restart.
 */
export function aiReviewLifecycle({ review = null, pr, pending = null } = {}) {
  const own = review && typeof review === 'object' && review.pr === pr ? review : null
  // (wf24/4) THE OPENING PROCESS GETS ITS OWN LIFECYCLE STATE: during
  // `opening` `r` doesn't start a new one and doesn't open a confirm — the
  // footer announces `loading…`. This branch comes BEFORE the pending
  // branch, because during loading, pending is still applied=false, which
  // would give 'done' (an open offer) instead.
  if (own && own.status === 'opening') return 'opening'
  if (own && (own.status === 'starting' || own.status === 'running')) return 'running'
  if (pending && pending.applied !== true && Array.isArray(pending.findings) && pending.findings.length > 0) {
    return 'done'
  }
  if (own && (own.status === 'done' || own.status === 'done-answer')) return 'done'
  return 'idle'
}

/**
 * The `r` key's STATE-DEPENDENT footer label (the shared source for the
 * global KEYS and panelFooter — two separate texts for the same key would
 * drift apart).
 */
export function rKeyLabel({ lifecycle = 'idle', xArmed = false } = {}) {
  // (wf24/4) THE OPENING PROCESS IS ALSO VISIBLE IN THE FOOTER: on the very
  // first frame after the keypress, the label switches to `loading…`, even
  // before the blocking spawnSyncs — without this the user sees a silent,
  // "dead" panel for a couple of seconds.
  if (lifecycle === 'opening') return 'r: loading…'
  // (wf31/5) THE `r` SEGMENT DISAPPEARS WHILE A REVIEW IS RUNNING — the
  // label is EMPTY.
  //
  // THE USER'S FINDING, verbatim: "after starting a review, no need for an
  // 'r: review (already running)' legend, just don't show it there."
  //
  // THE ERROR CLASS: an advertised key that ONLY says it DOESN'T WORK is a
  // DEAD KEY — the same thing `modalHasChoices` rules out for arrow-key
  // choices ("an advertised but non-functional arrow is a dead key"). In
  // the cramped footer it also TAKES UP SPACE from keys that DO work: the
  // `panelFooter` sits right at `clampCells`'s limit past 100 columns, so
  // the "already running" label cost a real action segment its spot.
  //
  // THE ABORT ISN'T LOST: the `x` is advertised by the PANEL'S PROGRESS
  // LINE (the `running` branch of `aiReviewPanelLines`) — right there,
  // WHERE THE WAITING HAPPENS. This is the module's stated principle ("the
  // `x` is advertised at the END of the panel's progress line, so the user
  // sees it right there"), and it's a stronger signal too: the footer is a
  // static bar, the progress line is the focus of attention. So the segment
  // doesn't come back on the `xArmed` branch either.
  //
  // THE EMPTY STRING (and not a missing return): `rKeyLabel` is the shared
  // source for the footer builders, and the callers splice it into a
  // segment list. The empty label is filtered out by the SPLICER
  // (`panelFooter`, `legendWithRLabel`) — so the "what's visible" contract
  // is decided in ONE place, and a dangling separator (`· ·`) is mechanically
  // ruled out.
  if (lifecycle === 'running') return ''
  if (lifecycle === 'done') {
    // (wf31/6) THE DONE STATE'S `r` NO LONGER OPENS — it advertises the
    // DISCARD.
    //
    // THE USER'S FINDING: "when a review has arrived, 'r' shouldn't open the
    // review, 'd' should. In hunk the notes can be hidden anyway, so that
    // makes much more sense."
    //
    // WHY IT ADVERTISES THE DISCARD, AND WHY IT DOESN'T STAY SILENT
    // ENTIRELY (like the `running` branch): under `running`, the `x` is
    // advertised on the PANEL'S PROGRESS LINE, so silencing the footer loses
    // no information there. In the `done` state, though, there IS NO
    // progress line (the measurement has finished), so the discard key has
    // NO OTHER ADVERTISER — a silenced `x` here would mean the user has no
    // way to know how to get rid of an unwanted review.
    //
    // (wf31/12) THIS SEGMENT IS THE DISCARD'S ONLY ADVERTISER — and it's
    // been LOAD-BEARING since the status line was retired. The earlier
    // shape had a second advertiser too: the status line shown on pressing
    // `r` used to list `d` and the double-`x`. The user retired that line
    // ("completely unnecessary, no need to spell it out"), so if this label
    // also fell silent, the discard key would appear NOWHERE.
    //
    // WHY IT CAN'T START A NEW ONE: an unwanted, not-yet-loaded finding set
    // would be OVERWRITTEN by a silent restart — both in the in-memory cache
    // AND on disk (review-store writes to the same PR key). So the
    // precondition for a new start REMAINS the explicit discard (double-`x`).
    //
    // (wf31/8) THE EARLIER RATIONALE here claimed "the cache only lives in
    // memory" — that was the state BEFORE the disk cache (review-store) was
    // introduced, and the user caught it from the lying exit warning it
    // produced. THE PROTECTED INVARIANT IS UNCHANGED (the friction before a
    // restart), only the REASON is now precise: they don't get lost, they
    // get OVERWRITTEN.
    //
    // (wf31/12) THE LABEL NAMES THE REAL KEY: `x: discard review`, not
    // `r: discard (x)`. The user's request, and a MEASURABLE
    // misdirection fixed: the discard is done by `x` (on a double press),
    // the `r` on this state is a LOUD NO-OP. The old shape advertised `r`
    // at the START of the segment — the eye jumps there — and put the real
    // key in parentheses at the end. The idiom is now consistent too: every
    // other segment is `<key>: <action>` (`d: diff`, `a: approve`), this
    // was the only `<wrong key>: <action> (<right key>)` exception.
    //
    // THE WORD ORDER IS "discard review", not "discard": the neighboring
    // segments also name the OBJECT (`f: upload review`), and a bare
    // "discard" doesn't say WHAT is being discarded — several things could
    // be discardable in the panel at once (findings, the measurement).
    return xArmed ? 'x: discard review — one more x' : 'x: discard review'
  }
  // (1c) THE IDLE LABEL IS SHORT: the user's request. The footer is the
  // most cramped, degrading surface — there the "AI-" prefix doesn't
  // distinguish anything (`d` is the diff review, `r` is the other one),
  // but it does take up space from other keys. The provenance texts (panel
  // sections, attestation, errors) KEEP "AI review" — there it really is
  // informative to say what spent tokens.
  return 'r: review'
}


// --- THE PANEL'S AI-REVIEW SECTION (3) --------------------------------------

/** This many findings the panel's short list shows; the rest are stated as a count. */
export const AI_PANEL_FINDINGS_SHOWN = 5

/**
 * THE SUMMARY LINE CEILING — A FAIL-SOFT SAFEGUARD, NOT A PLANNED LIMIT.
 *
 * (wf31/50) The user's question: "the review summary is currently capped at
 * 4 lines […] Is it worth keeping it capped? It's a summary anyway, it
 * could just show in full, no?" — and the answer is yes, because the
 * PREVIOUS VALUE (4) WAS PROTECTING THE WRONG THING.
 *
 * THE OLD RATIONALE was that "the long summary shouldn't push out the
 * findings list". That was a PRIORITY decision, not a space question: the
 * physical limit is handled by `clipBodyLines` (it clips the panel body to
 * the terminal height, AND states it too: "… panel truncated"). The 4-line
 * cap, then, decided who wins on tight space — the summary or the findings —
 * and decided it BACKWARDS:
 *
 *   · the FINDINGS are available elsewhere too: `d` opens them in the hunk,
 *     next to the code, IN FULL — the panel's 5-item list
 *     (`AI_PANEL_FINDINGS_SHOWN`) is just a preview anyway, and the "… and N
 *     more" says so;
 *   · the SUMMARY, though, exists NOWHERE ELSE. This is the verdict —
 *     exactly what the user missed earlier ("the findings list is NOT a
 *     verdict", wf24/2). If it gets truncated here, it's gone.
 *
 * The place to shorten, then, is the findings list, not the summary.
 *
 * WHY A CEILING REMAINS ANYWAY, AND WHY EXACTLY 12: not for the planned
 * case, but for a RUNAWAY MODEL RESPONSE. The prompt asks for 2-4
 * sentences, which wraps to 3-6 lines in cells — a 12-line ceiling never
 * touches the NORMAL case, but it does stop a 40-line hallucinated summary
 * from flooding the panel. This is a safety net, not a UI decision.
 *
 * THE TRUNCATION IS STILL STATED via the `…` — a silent cut would give the
 * impression that the verdict ended there.
 */
export const AI_PANEL_SUMMARY_LINES = 12

/**
 * THE ROW DESCRIPTORS for the PR panel's AI-review section — the app's
 * render tree is built from these.
 *
 * WHY IN THE PANEL (the user, verbatim): "the status message at the bottom
 * of the screen isn't a good spot, it mutates the layout". The
 * confirmation, the progress, the end state, the findings list, and the
 * load offer ALL live in the PR panel; the bottom global status line's use
 * for AI-review purposes has ended.
 *
 * A PURE function: `now` is injected, so the running branch's elapsed-time
 * computation is deterministically testable. Every line is clamped in
 * display CELLS.
 */
export function aiReviewPanelLines(review, { innerWidth = 80, now = Date.now() } = {}) {
  if (!review || typeof review !== 'object') return []
  const W = Math.max(1, Math.floor(Number(innerWidth) || 1))
  // THE DEGRADED review's caveat comes BEFORE every end-state line: the
  // findings are visible, but the "not complete" fact must not be
  // suppressed (attestation!).
  const caveatLine = review.caveat
    ? [{ key: 'ai-caveat', color: 'yellow', text: clampCells(`⚠ ${review.caveat}`, W) }]
    : []
  switch (review.status) {
    case 'starting':
      // THE IMMEDIATE FEEDBACK (6): even before the session check and the
      // git fetch.
      return [{ key: 'ai-0', color: 'cyan', text: clampCells('⏳ AI review starting…', W) }]
    case 'opening':
      // (wf24/4) THE SAME ERROR CLASS AS 'starting': the finished review's
      // `r` also starts with blocking spawnSyncs (repo root, session id, PR
      // refs), so after the keypress the UI silently froze — the user's
      // "still not responsive" finding. The signal goes out on the very
      // first frame after the keypress, before the blocking calls.
      return [{ key: 'ai-0', color: 'cyan', text: clampCells('⏳ loading…', W) }]
    case 'running': {
      const label = aiReviewProgressLabel({
        pr: review.pr,
        elapsedMs: Math.max(0, now - (review.startedAt ?? now)),
        findings: review.findings ?? 0,
        tool: review.tool ?? null,
        // ARMING THE DOUBLE-X: after the first `x` the label switches to
        // "confirm abort" — the signal changes RIGHT WHERE we advertise
        // the `x`.
        xArmed: review.xArmed === true,
      })
      return [{ key: 'ai-0', color: 'cyan', text: clampCells(`⏳ ${label}`, W) }]
    }
    case 'done':
    case 'done-answer': {
      const out = []
      // THE HEADER IS OVERRIDABLE (`headNote`): on the degraded paths the
      // caller gives an HONEST header — with a ref-fetch error alongside a
      // live session (lying-label-1) or a failed hunk-write measurement
      // (double-load-1), the default "the hunk session wasn't alive during
      // the run" would be a FALSE claim.
      //
      // (wf24/1) THE DEFAULT HEADER IS TERSE. The user, verbatim: the "…
      // STORED — the hunk session wasn't alive during the run" was VERBOSE
      // AND UNINTERESTING — an implementation detail that isn't for the
      // user. What IS for the user: how many findings there are, and what
      // their next step is (on the `done` branch ALREADY in the hunk, on
      // the `done-answer` branch WAITING to be loaded). The degraded
      // paths' `headNote` still OVERRIDES — there, stating the reason is
      // attestation, not detail.
      const head = typeof review.headNote === 'string' && review.headNote !== ''
        ? review.headNote
        : review.status === 'done'
        ? `✓ ${review.added} findings in the hunk`
        : `✓ ${review.added} findings (waiting to be loaded)`
      out.push({ key: 'ai-0', color: 'green', text: clampCells(head, W) })
      out.push(...caveatLine)
      // (wf24/2) THE SUMMARY GOES ABOVE THE FINDINGS. This is what the user
      // was missing: the findings list is NOT a verdict. Wrapped to cells,
      // and (since wf31/50) with ONLY a fail-soft ceiling — the place to
      // shorten is the findings list, not the summary; the rationale is at
      // the head of `AI_PANEL_SUMMARY_LINES`.
      const summaryText = typeof review.summary === 'string' ? review.summary.trim() : ''
      if (summaryText !== '') {
        const wrapped = wrapCells(summaryText, W)
        const shownSum = wrapped.slice(0, AI_PANEL_SUMMARY_LINES)
        if (wrapped.length > shownSum.length) {
          // THE TRUNCATION IS STATED: a silent cut would give the
          // impression that the verdict ended there. The `…` goes onto the
          // end of the ALREADY-CLAMPED line, so the last line is re-clamped
          // together with the marker.
          const last = shownSum[shownSum.length - 1]
          shownSum[shownSum.length - 1] = clampCells(`${last} …`, W)
        }
        shownSum.forEach((t, i) => out.push({ key: `ai-sum${i}`, text: t }))
      }
      const findings = Array.isArray(review.findings) ? review.findings : []
      const shown = findings.slice(0, AI_PANEL_FINDINGS_SHOWN)
      shown.forEach((f, i) => {
        const pos = f.newLine !== undefined && f.newLine !== null
          ? `:${f.newLine}`
          : f.oldLine !== undefined && f.oldLine !== null ? `:-${f.oldLine}` : ''
        out.push({ key: `ai-f${i}`, dimColor: true, text: clampCells(`  · ${f.filePath}${pos} — ${f.summary}`, W) })
      })
      if (findings.length > shown.length) {
        out.push({ key: 'ai-more', dimColor: true, text: clampCells(`  … and ${findings.length - shown.length} more`, W) })
      }
      // (wf24/3) THE ACTION-OFFER LINE IS GONE. The user, verbatim:
      // "operation labels are in the status line. In the modal, the state
      // that the review is done is enough." The `r`/`x` keys are
      // advertised by the panel's FOOTER (rKeyLabel + panelFooter), so this
      // line was pure duplication.
      //
      // The `review.offer` FLAG REMAINS and STILL CONTROLS BEHAVIOR
      // UNCHANGED: the Enter/`r` path, arming the `x` discard, and the load
      // being fulfilled (`offer:false`) all decide from it — only the
      // PRINTING disappeared, not the BEHAVIOR.
      return out
    }
    case 'no-findings':
    case 'aborted':
    case 'timeout':
    case 'killed-by-exit':
      return wrapCells(String(review.message ?? ''), W).slice(0, 6)
        .map((t, i) => ({ key: `ai-${i}`, dimColor: true, text: t }))
    case 'failed':
      // THE ERROR ALSO LIVES IN THE PANEL (not the global error overlay):
      // every AI-review state is readable in ONE place. In red, wrapped,
      // with a limited line count (so the raw stderr doesn't push the list
      // out).
      return wrapCells(String(review.message ?? ''), W).slice(0, 12)
        .map((t, i) => ({ key: `ai-${i}`, color: 'red', text: t }))
    default:
      throw new Error(
        `unknown AI-review panel status: ${JSON.stringify(review.status)} — a silent default `
        + 'would be exactly the #904 catch-all-branch error class.',
      )
  }
}
