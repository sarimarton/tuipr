// tuipr — AI-REVIEW-CONFIG: the AI review's PRECONDITIONS and user choices.
//
// What lives here: scope filtering (generated/lockfile exclusion), locating
// the claude binary, the blockers, the dwell gate (typeahead), the spend cap
// (DEFAULT OFF) and the model picker (default opus), the review-path options,
// and the confirmation screen's summary text.
//
// LAYER ORDER: imports downward (layout: measures in the summary's cells;
// queue-fetch: the PR's files). Imports NOTHING from the core or above it.
//
// The tests measure the spend cap's DEFAULT-OFF invariant ACROSS THE WHOLE
// MODULE SURFACE (not a single function parameter may yield a non-zero cap)
// — the flag can only go out on an EXPLICIT user decision.
import { displayWidth, stepIndex } from './layout.mjs'
import process from 'node:process'
import { accessSync, constants } from 'node:fs'
import { spawnSync } from 'node:child_process'

// --- AI review: `claude -p` from the TUI ('r' key) --------------------------
//
// THE RESPONSIBILITY MODEL: the call consumes the RUNNING DEVELOPER's local
// Claude credential (OAuth/keychain), not CI's org-level secret pool. This is
// the same bucket as the hunk-level local review, so the responsibility
// category does NOT change — but the spend is real, hence the confirmation
// requirement (see aiReviewSummary + the TUI's confirm gate).
//
// THE CONTRACT IS FAIL-CLOSED AT THREE POINTS, and all three answer a
// MEASURED trap:
//
//  1. THE EXIT CODE IS NOT THE GATE. `claude -p` can give exit 0 +
//     `subtype:"success"` + `is_error:false` while the review did NOT run —
//     measured: `/security-review` returned "runnable inside a git
//     repository, but the cwd isn't one" prose, wrapped in a fully
//     successful envelope. Without a fail-closed gate the TUI would have
//     reported "0 findings, all clear" — exactly the dishonest empty
//     response the --json contract bans. So the REAL gate is the structured
//     findings parse (parseAiReviewResult), and a missing findings key is a
//     THROW, not an empty list.
//  2. SCOPE FILTERING IS A PRECONDITION, not an option. #911's full diff
//     measured ~8.88 MB / 275,248 lines ≈ 2.2-2.5M tokens, the context
//     window is 1M — the naive "just feed in the diff" path GUARANTEED to
//     fail. 97% of the churn is 13 generated fixtures (a single pack.json,
//     198,483 lines); the actual code is 87 files / 7,882 lines ≈ 184k
//     tokens, which fits comfortably. The confirmation screen SHOWS the
//     exclusion: the developer needs to know what the AI did NOT review.
//  3. THE SPEND CAP IS HARD. `--max-budget-usd` is always filled in, because
//     the review skills' agent fan-out makes spend non-linear with diff
//     size: an estimate is not protection, the cap is.
//
// WHAT'S DELIBERATELY NOT HERE: findings do NOT go straight to GitHub.
// runAiReview's result goes into the HUNK SESSION (injectHunkComments),
// where the developer goes through them, deletes/edits — and the existing
// 'f' path fills it in. This human-in-the-loop gate is what makes the body's
// `verifiedBy` claim TRUE.

/**
 * The pattern list of generated/derived files — the AI review skips these.
 *
 * Why a glob list and not a size heuristic: size alone says nothing about
 * reviewability (a hand-written 2000-line view is worth reviewing, a
 * 12-line generated snapshot isn't), whereas being generated follows from
 * the file's ROLE. `reason` is the confirmation screen's text, hence
 * English.
 */
const GENERATED_PATTERNS = [
  { re: /(^|\/)pack\.json$/, reason: 'generated scenario pack' },
  { re: /\.jsonl$/, reason: 'generated event stream (jsonl)' },
  { re: /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Podfile\.lock)$/, reason: 'lockfile' },
  { re: /(^|\/)__snapshots__\//, reason: 'jest snapshot' },
  { re: /\.snap$/, reason: 'jest snapshot' },
  { re: /(^|\/)(generated|__generated__)\//, reason: 'generated directory' },
  { re: /\.generated\.[a-z]+$/, reason: 'generated file' },
]

/**
 * From the PR's file list, the reviewable scope and the excluded ones.
 *
 * The return SHAPE is deliberately asymmetric: `scope` is a plain path list
 * (this goes into the prompt), whereas `excluded` comes WITH A REASON —
 * because that's what the confirmation screen shows, and an unexplained
 * "13 files excluded" isn't auditable.
 */
export function aiReviewScope(files) {
  const scope = []
  const excluded = []
  for (const f of files) {
    const hit = GENERATED_PATTERNS.find((p) => p.re.test(f.path))
    if (hit) excluded.push({ path: f.path, reason: hit.reason, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })
    else scope.push(f.path)
  }
  return { scope, excluded }
}

// The file count above which the confirmation screen warns EMPHATICALLY.
// #911 (100 files) is in mind, but the threshold isn't tuned to it: above 40
// files an AI review is already several hundred thousand tokens, and the
// developer can't read through the findings in one sitting either. The
// threshold is a VISIBLE constant, not a magic number scattered around.
const AI_LARGE_FILES = 40
const AI_LARGE_CHURN = 5000

/**
 * The `claude` binary's path, or null. Its absence is a BLOCKER, not a
 * silent no-op.
 *
 * We walk PATH OURSELVES rather than shelling out to `command -v`: the
 * `shell: true` + args combination is Node-deprecated (DEP0190,
 * concatenation without escaping), and it also saves us spawning a
 * `/bin/sh`. `spawnSync('claude', …)`'s ENOENT isn't an early enough signal:
 * the confirmation screen wants to know BEFORE the call whether claude
 * exists at all.
 */
export function claudePath() {
  const dirs = (process.env.PATH || '').split(':').filter((d) => d.length > 0)
  for (const d of dirs) {
    const p = `${d}/claude`
    try {
      // X_OK: mere existence isn't enough, it has to be executable too.
      accessSync(p, constants.X_OK)
      return p
    } catch {
      // Not in this directory — on to the next PATH element. This is NOT
      // swallowing an error: absence is the normal case, and we signal it
      // with null at the end.
    }
  }
  return null
}

/**
 * The AI review's blockers, LISTED — the confirmation screen shows this, and
 * `y` only starts with an empty list (same mechanism as mergeBlockers).
 *
 * claude's absence gives an EXPLANATORY error, not just a "no claude": per
 * the project's rule, silent/unintelligible error-swallowing is banned.
 */
export function aiReviewBlockers({ claudePath: cp, scope }) {
  const out = []
  if (!cp) {
    out.push(
      'the `claude` CLI was not found on PATH — the AI review calls the local Claude Code '
      + 'installation (`claude -p`). Install it, or put it on PATH, then try again.',
    )
  }
  if (!scope || scope.length === 0) {
    out.push(
      'the review scope is EMPTY: every file in the PR is a generated/lock file, so there\'s '
      + 'nothing to hand to the AI review. Review the diff by hand (`d`).',
    )
  }
  return out
}

/**
 * The confirmation screen's MINIMUM dwell time in ms: we don't accept 'y'
 * for this long after mounting. 250 ms — the eye-hand loop for a deliberate
 * keypress is slower than this, whereas a buffered keypress lands at ~0 ms.
 */
export const CONFIRM_DWELL_MS = 250

// --- The spend cap: OFF BY DEFAULT ------------------------------------------
//
// THE MEASURED FACT the decision follows from (`claude --help`):
//     --max-budget-usd <amount>   Maximum dollar amount to spend on API calls
//                                 (only works with --print)
// So the flag is an API-SPEND concept: it cuts the run off in dollars. The
// user, though, consumes a SUBSCRIPTION limit (no ANTHROPIC_API_KEY,
// OAuth-based auth), where there's no dollar bill to cut against. There, a
// hard cutoff based on a number is a no-op in the best case, and in the
// worst case cuts the review off HALFWAY: the tokens spent, no findings
// given. A cut-off review is WORSE than running with no cap.
//
// SO the contract has three points:
//   1. DEFAULT OFF, and disabled `--max-budget-usd` isn't in argv AT ALL
//      (not 0, not "unlimited", not an undefined-string — no flag);
//   2. switchable ad hoc in the TUI, but UNEMPHASIZED: one dimmed row at the
//      bottom of the overlay. It gets no highlight and no explanatory
//      paragraph, because what it does is uncertain — the UI shouldn't
//      claim to believe more about it than that;
//   3. the REAL protection against the subscription limit is the PR-SIZE
//      INFO (file count + diff lines, emphasized on a large PR) — that's
//      proven useful, so that's the emphasized part, not this.
//
// THE CHOICE ISN'T STICKY beyond the session: no persistence. A forgotten
// cap written to disk would be exactly the silent cutoff the rationale above
// bans.

/**
 * The selectable cap tiers in USD. A VISIBLE, fixed list, not free entry: a
 * free numeric input in the TUI would add more code and more error cases
 * (parsing, validation, cursor) than a flag of uncertain effect is worth.
 * Five tiers are enough to express "order of magnitude".
 */
export const BUDGET_STEPS_USD = [1, 2, 3, 5, 10]

/**
 * The cap's STARTING STATE: `{ enabled, usd }`.
 *
 * The env var (`TUIPR_AI_REVIEW_BUDGET_USD`) only gives a STARTING VALUE —
 * if it has a valid value, we start enabled with that number. Without env,
 * DISABLED state, `usd: undefined`, so there's nothing to pass on the call
 * path.
 *
 * An INVALID env does NOT enable it (fail-closed toward DISABLED):
 * `Number('')` gives 0, `Number('abc')` gives NaN, and neither is a signal
 * of intent. 0 would be an immediately cut-off review, and NaN a parse error
 * on claude's side — both worse than running with no cap.
 */
export function aiReviewBudgetState({ env } = {}) {
  const n = Number(env)
  if (env !== undefined && env !== null && String(env).trim() !== '' && Number.isFinite(n) && n > 0) {
    return { enabled: true, usd: n }
  }
  return { enabled: false, usd: undefined }
}

/**
 * The `b` key: on/off. On enabling it settles back onto the last (or
 * default) tier, on disabling `usd` DISAPPEARS — not a "preserved but
 * inactive" value, because an inactive number on the call path is exactly
 * the leak the argv-guard test bans.
 */
export function budgetToggle(state) {
  const on = state?.enabled === true
  if (on) return { enabled: false, usd: undefined }
  const prev = Number(state?.usd)
  const usd = BUDGET_STEPS_USD.includes(prev) ? prev : BUDGET_DEFAULT_USD
  return { enabled: true, usd }
}

// The tier taken on enabling. 3 USD is the list's middle: not the smallest
// (which would cut halfway), not the largest (which would look "unlimited").
const BUDGET_DEFAULT_USD = 3

/**
 * The `←`/`→` step through the tiers, WRAPPING AROUND.
 *
 * NO-OP in DISABLED state: stepping does NOT enable it. The switch is `b`,
 * and if the arrow also enabled it, a stray arrow press would silently pull
 * a cap onto the run — exactly the silent state change the fail-closed
 * principle bans.
 */
export function budgetStep(state, delta) {
  if (state?.enabled !== true) return { enabled: false, usd: undefined }
  const i = BUDGET_STEPS_USD.indexOf(Number(state.usd))
  const from = i >= 0 ? i : BUDGET_STEPS_USD.indexOf(BUDGET_DEFAULT_USD)
  return { enabled: true, usd: BUDGET_STEPS_USD[stepIndex(from, BUDGET_STEPS_USD.length, delta)] }
}

/**
 * The budget row's TEXT — one row, dimmed, at the bottom of the overlay.
 *
 * THE UNCERTAINTY IS STATED, but in parentheses and briefly: per
 * `claude --help` the flag applies to "API calls", whereas the user consumes
 * a subscription limit, so we don't know whether it'll cut anything at all.
 * This half-line is the honest statement — an explanatory paragraph, though,
 * would give it exactly the emphasis the user EXPLICITLY didn't ask for
 * ("can be in a very unemphasized spot").
 */
export function budgetLine(state) {
  if (state?.enabled !== true) return 'budget: off (b)'
  return `budget: ${state.usd} USD (b: off · ←/→: ${BUDGET_STEPS_USD.join('/')} — uncertain effect under subscription)`
}

/**
 * The `--max-budget-usd` argv fragment — EITHER two elements, OR an empty
 * array.
 *
 * Whether the flag goes out is decided in ONE place: the v1 findings path
 * and the agent path's SEPARATE command builders would have made this same
 * decision twice, and the default-OFF guarantee could have drifted apart
 * exactly from fixing one and not the other.
 *
 * THE GUARD IS FAIL-CLOSED toward OMITTING the flag: non-number, non-finite,
 * non-positive input gets NO flag. `String(undefined)` = "undefined" is a
 * parse error on claude's side, and `0` is an immediate cutoff — the missing
 * flag beats both.
 */
export function budgetArgs(maxBudgetUsd) {
  const n = Number(maxBudgetUsd)
  if (maxBudgetUsd === undefined || maxBudgetUsd === null || !Number.isFinite(n) || n <= 0) return []
  return ['--max-budget-usd', String(n)]
}

// --- THE REVIEW AGENT'S MODEL: ALWAYS EXPLICIT, DEFAULT OPUS ----------------
//
// THE MEASURED FINDING (the user's live test, a #904 self-run): our
// `claude -p` call did NOT pass `--model`, so it inherited the user's SAVED
// DEFAULT — Fable 5 for them, the most expensive tier — and a SINGLE review
// exhausted their session budget. Omitting the flag, then, isn't neutral:
// it's a silent cost escalation for whoever's default is expensive. THAT'S
// WHY `--model` is MANDATORY in argv (see the end of both command builders),
// and the default, per the user's suggestion, is opus.
//
// THE CHOICE is three items, as a VISIBLE list (the TUI toggle cycles
// through this): opus is the balanced default, sonnet the cheap/fast path,
// fable the strongest — but its row STATES the consequence (exhausts the
// session budget quickly), because the user ran into exactly this without
// measuring.
export const AI_REVIEW_DEFAULT_MODEL = 'opus'

export const AI_REVIEW_MODELS = [
  // The opus row DELIBERATELY has no "default" word: the user got burned by
  // exactly the silent default inheritance, and the word itself would
  // suggest "something was decided elsewhere". The concrete name + its
  // character is the honest form.
  { id: 'opus', label: 'opus — recommended (thorough review, normal budget consumption)' },
  { id: 'sonnet', label: 'sonnet — cheaper, fast' },
  { id: 'fable', label: 'fable — the strongest, but exhausts the session budget quickly' },
]

/**
 * The model picker's STARTING STATE: `{ id, fromEnv }`.
 *
 * The env var (`TUIPR_AI_REVIEW_MODEL`) only gives a STARTING VALUE — the
 * TUI toggle overrides it per run (same pattern as the budget env). We do
 * NOT filter the env value against our own list: `--model` also accepts a
 * full model name (`claude --help`: "or a model's full name"), and the
 * user's intent to pin a model is stronger than our own selection. An
 * empty/whitespace env is NOT a choice — the default (opus) is used.
 */
export function aiReviewModelState({ env } = {}) {
  const v = typeof env === 'string' ? env.trim() : ''
  if (v !== '') return { id: v, fromEnv: true }
  return { id: AI_REVIEW_DEFAULT_MODEL, fromEnv: false }
}

/**
 * The model toggle (the `m` key on the confirmation panel): CYCLES through
 * the list.
 *
 * From a LIST-FOREIGN model (a full name pinned from env), the FIRST step
 * goes to the START of the list (the default): stepping is thus
 * deterministic, and the user doesn't get stuck on a name the toggle doesn't
 * know. There's deliberately no way back to the env value — whoever pinned
 * via env doesn't press the toggle; whoever presses it wants to choose from
 * the visible selection.
 */
export function modelStep(state, delta = +1) {
  const i = AI_REVIEW_MODELS.findIndex((m) => m.id === state?.id)
  if (i < 0) return { id: AI_REVIEW_MODELS[0].id, fromEnv: false }
  return { id: AI_REVIEW_MODELS[stepIndex(i, AI_REVIEW_MODELS.length, delta)].id, fromEnv: false }
}

/**
 * The model row's TEXT on the confirmation panel — always the CONCRETE
 * model name.
 *
 * The old "Model: claude (default)" form is BANNED: it hid exactly the fact
 * that "default" could be ANYTHING on the user's machine (for them it was
 * the most expensive tier). The fable row also carries the budget warning;
 * a list-foreign name from env shows in its own form.
 */
export function modelLine(state) {
  const id = state?.id ?? AI_REVIEW_DEFAULT_MODEL
  const known = AI_REVIEW_MODELS.find((m) => m.id === id)
  const label = known ? known.label : `${id} (fixed from env)`
  return `model: ${label} (m: switch — ${AI_REVIEW_MODELS.map((m) => m.id).join('/')})`
}

/** The `--model` argv fragment — ALWAYS two elements (default inheritance is banned). */
export function modelArgs(model) {
  const id = typeof model === 'string' && model.trim() !== '' ? model.trim() : AI_REVIEW_DEFAULT_MODEL
  return ['--model', id]
}


// --- Review path selection ---------------------------------------------------
//
// THE NEW MODEL: the AI-review agent itself writes the findings into the
// hunk session (via the hunk-review skill's `comment apply` batch path), NOT
// the TUI. The TUI only STARTS `claude -p` and waits for it. So "review
// path" = which slash command runs under `claude -p` — and that choice is
// VISIBLE, not hardcoded.
//
// EXCLUDED PATHS, and WHY (this list is itself the decision's
// documentation):
//   - builtin `/review`: a SINGLE-agent one-shot, so no fan-out, no verify —
//     finds an order of magnitude less than the 6-sweep agent-review;
//   - `/code-review ultra`: runs in the CLOUD ($5-25/run), and the binary
//     BANS starting agents — can't even be run from the TUI.

export const REVIEW_PATHS = [
  {
    id: 'agent-review',
    default: true,
    label: 'agent-review (6 skill-delegated sweeps, bit-identical to CI)',
    command: '/agent-review',
    note: 'The path BIT-IDENTICAL to CI: the same 6 skill-delegated sweeps, the same JSON schema. '
      + 'Whatever you see here is what CI will flag too.',
  },
  {
    id: 'code-review',
    default: false,
    label: '/code-review high (multi-agent fan-out + verify, normal usage)',
    command: '/code-review high',
    note: 'Modern multi-agent path (fan-out + verify), runs from normal usage. Does NOT review by '
      + 'CI\'s rules, so CI may surface different findings. `xhigh` is deeper, more expensive.',
  },
]

/**
 * The offered review paths. The DEFAULT is `agent-review`, because it's
 * bit-identical to CI: the local review then says nothing different from
 * what the gate will say.
 */
export function reviewPathOptions() {
  return REVIEW_PATHS.map((p) => ({ ...p }))
}

// The cost warning's thresholds. VISIBLE constants: per the user's decision,
// above 30 files OR 2000 diff lines an emphatic warning is needed, because
// there the agent fan-out's token spend is already significant.
const REVIEW_WARN_FILES = 30
const REVIEW_WARN_CHURN = 2000

/**
 * Cost warning for the review-path picker screen, or null.
 *
 * The MEASURED number is in the text: a generic "this is a large PR" isn't
 * auditable, and the user wouldn't know how large.
 */
export function reviewPathWarning({ fileCount = 0, churn = 0 } = {}) {
  const byFiles = fileCount > REVIEW_WARN_FILES
  const byChurn = churn > REVIEW_WARN_CHURN
  if (!byFiles && !byChurn) return null
  const reasons = []
  if (byFiles) reasons.push(`${fileCount} files (> ${REVIEW_WARN_FILES})`)
  if (byChurn) reasons.push(`${churn} diff lines (> ${REVIEW_WARN_CHURN})`)
  // The closing sentence "consumes your own tokens" is DELIBERATELY not
  // here (user's complaint: unnecessary). The MEASURED numbers stay — those
  // are auditable.
  return (
    `WARNING — COST: ${reasons.join(' and ')}. The review paths are agent-fanned-out, so `
    + 'token spend at this size is already significant, and reading through the findings will take a while.'
  )
}

/**
 * Is the confirmation (the 'y') acceptable on THIS keypress? — the
 * TYPEAHEAD GATE.
 *
 * THE MECHANISM'S RATIONALE LIVES HERE, IN A CODE COMMENT, not in the UI:
 * the gate is INVISIBLE in normal use (a deliberate keypress's eye-hand loop
 * is slower than the dwell), so explaining it on the confirmation screen was
 * just noise — that was exactly the user's complaint. Whoever hits it gets
 * a short "too early" line.
 *
 * WHY IT'S NEEDED: `askAiReview` does BLOCKING synchronous I/O (`gh pr view
 * --json files`, ~1 second on a live PR), then opens the confirmation
 * screen. Ink keeps stdin in raw mode, and does NOT drop the input buffer on
 * a view switch. A 'y' struck DURING the gh call is thus processed AFTER
 * the confirm screen mounts, going straight into the confirmation branch —
 * the user WOULD HAVE READ the screen, but never got the chance, and the
 * token-spending `claude -p` started anyway. On a live PR (#911, 100 files)
 * that's real spend.
 *
 * WHY THE `busy` GUARD ISN'T ENOUGH: `setBusy(true)` and `setBusy(false)`
 * run in the SAME synchronous block (try/finally), so React never RENDERS a
 * `busy === true` state. The useInput handler always sees `busy === false`
 * for a buffered keypress — the guard is structurally incapable of catching
 * this case.
 *
 * THE GATE'S ASYMMETRY IS DELIBERATE: we only delay the confirmation, NEVER
 * the cancellation. The dwell protects the SPEND; cancelling is free, so a
 * buffered keypress can go ahead and do it too — that's the safe direction
 * (fail-closed).
 */
export function confirmAccepts(state, input) {
  if (input !== 'y') return false
  const armedAt = state?.armedAt
  // If there's no arm timestamp, the gate is CLOSED: we don't infer
  // permission from a missing measurement (same fail-closed principle as
  // the merge/AI blockers).
  if (typeof armedAt !== 'number' || !Number.isFinite(armedAt)) return false
  const now = typeof state?.now === 'number' ? state.now : Date.now()
  return now - armedAt >= CONFIRM_DWELL_MS
}

/**
 * The confirmation screen's content — the PR's SIZE, the scope, the
 * excluded files, and the CAP.
 *
 * Why the cap and not an estimate: an estimate (tokens × price) can be off
 * by an order of magnitude because of the agent fan-out, whereas
 * `--max-budget-usd` is a hard limit. If the developer sees the cap, they
 * see the worst case — that's the informed decision.
 */
// The `model` PARAMETER REMOVED (5b): the model isn't a static line in the
// summary, it's the confirmation's SWITCHABLE field (modelLine) — two
// renderers for the same fact is exactly the drift class we already ruled
// out for the budget row.
export function aiReviewSummary({ pr, files, maxBudgetUsd }) {
  const { scope, excluded } = aiReviewScope(files)
  const additions = files.reduce((a, f) => a + (f.additions ?? 0), 0)
  const deletions = files.reduce((a, f) => a + (f.deletions ?? 0), 0)
  const churn = additions + deletions
  const large = files.length >= AI_LARGE_FILES || churn >= AI_LARGE_CHURN
  const exAdd = excluded.reduce((a, f) => a + f.additions + f.deletions, 0)

  const lines = []
  lines.push(`#${pr} — ${files.length} files, +${additions} / -${deletions} lines`)
  if (large) {
    lines.push(
      `WARNING: this is a LARGE PR (${files.length} files, ${churn} lines of churn). The AI review `
      + 'will consume a lot of tokens on this, and reading through the findings will take a while.',
    )
  }
  lines.push(`Review scope: ${scope.length} files.`)
  if (excluded.length > 0) {
    // The excluded files' NAMES show (up to 5 + a remainder), because "13
    // files excluded" isn't an auditable claim.
    const shown = excluded.slice(0, 5).map((e) => `${e.path} (${e.reason})`)
    const rest = excluded.length - shown.length
    lines.push(
      `Excluded ${excluded.length} generated/lock files (${exAdd} lines of churn): `
      + shown.join(', ') + (rest > 0 ? `, +${rest} more` : ''),
    )
    lines.push('Whatever the AI excludes, YOU need to review it, if it matters.')
  }
  // THE PRECONDITION IS STATED: findings go into the HUNK SESSION, so this
  // repo needs a live session. In the user-reported #904 bug this turned
  // unintelligible for exactly this reason — the UI stated the precondition
  // NOWHERE — only a raw hunk-stderr came after the failure. The text is the
  // SHARED HUNK_SESSION_HINT, so it can't drift apart from the error
  // message.
  //
  // THE PARALLEL MODEL IS STATED BEFORE the confirmation: the user knows
  // that (a) the diff WILL OPEN (the hunk takes over the terminal), and (b)
  // the review runs in the BACKGROUND, so the findings appear before their
  // eyes. Without this, the post-confirmation terminal takeover would land
  // WITHOUT EXPLANATION — and the core of the #904 report was exactly that
  // the UI didn't state what was happening.
  //
  // `HUNK_SESSION_HINT` IS LEFT OUT HERE: the TUI now opens the session
  // ITSELF, so the "open one" instruction would be misleading here (the user
  // has nothing to do). The hint stays on the ERROR path, where it's
  // actually needed.
  lines.push('')
  lines.push(
    'The review runs in the BACKGROUND, THIS panel shows the progress. The findings go into the hunk '
    + 'session (without a live session we load them from the review response), and the '
    + 'hunk opens when there IS SOMETHING to see.',
  )
  // THE CAP ROW ONLY EXISTS IF THERE IS A CAP. By default there isn't (see
  // the budget chapter), and a "Spend cap: --max-budget-usd undefined" row
  // would be worse than silence: it would claim there's protection. The
  // disabled state is stated by the UI's unemphasized budget row ("budget:
  // off"), not this.
  //
  // WHAT'S DELIBERATELY NOT HERE: the "this consumes YOUR OWN tokens"
  // sentence. Per the user's complaint it's unnecessary — the developer
  // knows it uses their local credential. The responsibility model's
  // description lives in the module's header and in the docs, not in the
  // UI.
  const hasBudget = Number.isFinite(Number(maxBudgetUsd)) && Number(maxBudgetUsd) > 0
  if (hasBudget) {
    lines.push(`Spend cap: --max-budget-usd ${maxBudgetUsd} (per claude --help, applies to API spend)`)
  }
  // The cap ALSO goes out MECHANICALLY: the confirmation's y-branch passes
  // THIS on to claude, so the user gets exactly the cap they SAW on the
  // screen. If the runner recomputed it from elsewhere, the displayed and
  // the live cap could drift apart.
  return {
    fileCount: files.length, additions, deletions, churn, large, scope, excluded,
    maxBudgetUsd: hasBudget ? maxBudgetUsd : undefined,
    lines,
  }
}
