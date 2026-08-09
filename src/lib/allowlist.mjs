// tuipr — ALLOWLIST: the ISOLATION and permission policy for the claude call.
//
// What lives here: the setting sources (excluding the user-level CLAUDE.md),
// the allowed/disallowed tool lists, the permission-reality prompt block, and
// the denial messages.
//
// PURE CONSTANT+FORMATTER LAYER: ZERO project imports (measured). This is
// deliberate — so the token-boundary, trap-laden tests target a SMALL file,
// not the 6000-line one.
//
// THIS FILE IS WHERE THE LISTS GET EXTENDED (the denial message points here too).

// --- ISOLATION: excluding the user-level CLAUDE.md --------------------------
//
// THE MEASURED FINDING: the review agent, on the user's machine, started
// running `claude-usage gate; echo "exit=$?"` — this instruction leaked in
// from the USER-LEVEL global CLAUDE.md (which instructs the agent to run the
// gate before any substantial work). The review agent has nothing to do with
// the user's workflow instructions.
//
// THE MEASUREMENT (claude 2.1.238, 2026-08-03, two minimal haiku trials in
// the mobile checkout, with a --max-budget-usd ceiling):
//   1. `--setting-sources project,local` + "can you see a claude-usage gate
//      instruction?" → user_md: FALSE, project_md: TRUE — the user-level
//      CLAUDE.md is excluded, the PROJECT CLAUDE.md remains.
//   2. Same, with `--tools Skill` added → agent_review_available: TRUE — the
//      project-level skills/slash commands (.claude/commands/agent-review.md)
//      do NOT come from a settings source, so they stay available.
//   3. `--bare` is NOT an alternative: per `--help`, in bare mode "OAuth and
//      keychain are never read" — for a subscription-auth user, auth itself
//      would die. `--setting-sources` is the narrower, targeted tool.
export const AI_REVIEW_SETTING_SOURCES = 'project,local'
export const AI_REVIEW_SETTING_SOURCES_ARGS = ['--setting-sources', AI_REVIEW_SETTING_SOURCES]

/**
 * The PERMISSION ALLOWLIST — a SECOND gate, INDEPENDENT of `--tools`.
 *
 * WHY THIS IS NEEDED (MEASURED HARD BLOCKER, claude 2.1.220, the root cause
 * of the #904 run): `--tools` ONLY narrows the tool SET; whether a specific
 * call of an allowed tool ACTUALLY RUNS is decided by the permission layer.
 * The TUI starts with `--permission-mode dontAsk` (non-interactively there's
 * no one to answer the prompt), but the user's `~/.claude/settings.json` has
 * `"allow": []` — and in that case Bash calls get DENIED. MEASURED IN
 * ISOLATION (`--setting-sources ''` + settings with an empty allowlist,
 * `--tools Bash`, `dontAsk`, prompt: `gh pr view 1 --json title`):
 *
 *   subtype=success, is_error=false, permission_denials=[{
 *     "tool_name":"Bash","tool_use_id":"toolu_014PyJ…",
 *     "tool_input":{"command":"gh pr view 1 --json title ."}}]
 *
 * I.e. the wrapper reports SUCCESS, while the review didn't complete a single
 * step. This is the WORST member of the #904 lying-end-state class: on the
 * user's machine, the AI review was IN PRINCIPLE unusable.
 *
 * THE FIX EXISTS IN THE CLI, AND MEASURABLY WORKS: the same call with
 * `--allowedTools 'Bash(gh pr view:*)'` gave `permission_denials: []`. So the
 * flag takes effect ALONGSIDE `dontAsk`, and does NOT require modifying the
 * user's `settings.json` — that's their machine, not our business.
 *
 * WHY PREFIX PATTERNS AND NOT A BARE `Bash`: a bare `Bash` would allow the
 * WHOLE shell, and that would defeat the point of narrowing `--tools` (no
 * Write/Edit, the agent can't modify the REPO) — anything goes through Bash.
 * `Bash(<prefix>:*)` is the MEASURED syntax (`claude --help`:
 * `"Bash(git *) Edit"`), and the list covers EXACTLY the commands the review
 * needs.
 *
 * THE LIST'S SOURCE IS TWO MEASUREMENTS:
 *   1. the #904 run's log: there, `gh pr view`, `hunk session list`, and
 *      `git log` got denied; `gh pr diff` and `git diff` are explicitly named
 *      in the prompt;
 *   2. the user's live test's denial list + the agent-review skill's
 *      INVENTORY (mobile repo `.claude/commands/agent-review.md`, 478 lines).
 *      The skill's local run ACTUALLY calls: `gh pr diff`/`gh pr view`
 *      (STEP 2), `pnpm exec list-changed-files` (STEP 2), `gh api repos/…/
 *      pulls/N/reviews|comments --paginate` (STEP 4b reconciliation +
 *      REVIEW_COUNT), the jira MCP (sweep-jira-compliance: loading the
 *      ticket), and delegates via Task (8 parallel sweeps + validation). In
 *      the user's measurement, `gh pr checks`, `gh api …/pulls/904/reviews`,
 *      and `mcp__atlassian__jira_get` got denied — all read-only paths.
 *
 * WHAT'S DELIBERATELY NOT IN HERE: a bare `Bash` (the whole shell), the
 * mutating gh paths (`gh pr comment/review/merge` — that would bypass the
 * human-in-the-loop gate), and the MUTATING jira tools
 * (jira_comment/create/update/transition). The `gh api` allow is a prefix
 * pattern, so it CANNOT exclude `-X POST` in principle — that's covered by
 * the prompt's explicit prohibition and AI_REVIEW_DISALLOWED_TOOLS
 * (deny > allow).
 */
export const AI_REVIEW_ALLOWED_TOOLS = [
  // The PR's metadata and diff — the review's INPUT.
  'Bash(gh pr:*)',
  // The CI status — was denied in the user's measurement (`gh pr checks 904 …`).

  // The gh api READS: reviews/comments (reconciliation, REVIEW_COUNT).
  // MEASURED TRAP: the `gh api repos:*` pattern did NOT match the
  // `gh api repos/<org>/...` call — matching is token-boundary based, and
  // the `repos` token != `repos/<org>/...`. So we close after the full `api`
  // token. Mutation (gh api -f/-X POST) is forbidden by the prompt — it
  // can't be expressed with a prefix; a documented, accepted residual risk
  // (our own orchestrated review agent, with an explicit no-mutation
  // instruction).
  'Bash(gh api:*)',
  // The agent-review STEP 2 file lister (repo-local, read-only script).
  'Bash(pnpm exec list-changed-files:*)',
  // The hunk CLI: this is where the agent WRITES the findings (the whole
  // point of the v2 path).
  'Bash(hunk:*)',
  // The local git history and diff — the finding's context.
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git show:*)',
  // Denials from the user's 3rd failed run: search and CI log — both read-only.
  'Bash(git grep:*)',
  'Bash(gh run:*)',
  // MEASURED denials from the user's 4th run — both are read-only paths:
  //   - `git ls-tree`: listing the repo tree (the review looks at the structure);
  //   - the eslint MCP's `lint-files` tool: the lint sweep's legitimate
  //     read-only path — the agent inherits the PROJECT's MCP servers
  //     (--setting-sources project), so the tool is available, just the
  //     permission layer denied it.
  'Bash(git ls-tree:*)',
  // MEASURED denial from the user's 5th run: `git check-ignore -v <file>` —
  // a read-only path (tells you whether a file is ignored and by which rule).
  //
  // WHY THE ENUMERATION STAYS, AND NOT A GENERAL `Bash(git:*)` + mutating-deny:
  // the deny side CANNOT be expressed at prefix level. git accepts flags
  // BEFORE the verb too (`git -C <path> push`, `git -c <config> commit`), so
  // a `Bash(git push:*)` deny wouldn't catch these; `-c core.fsmonitor=<cmd>`
  // on top of that runs an arbitrary command. With a broad allow, the deny
  // list would therefore be full of holes — so every NEW read-only verb comes
  // in as a measured denial, and gets added here one at a time (accepted,
  // documented friction).
  'Bash(git check-ignore:*)',
  'mcp__eslint__lint-files',
  // The jira MCP's READ tools: sweep-jira-compliance loads the ticket
  // (summary, description, comments) via MCP. NOTE: `jira_comments` (plural)
  // READS, `jira_comment` (singular) WRITES — the latter is forbidden.
  'mcp__atlassian__jira_get',
  'mcp__atlassian__jira_search',
  'mcp__atlassian__jira_comments',
  // The skill invocation itself (`/agent-review`, `hunk-review`) and the
  // agent fan-out: agent-review delegates 8 parallel sweeps + validation tasks.
  'Skill',
  'Task',
  // Reading: it's also in `--tools`, but the permission layer is a separate gate.
  'Read',
  'Grep',
  'Glob',
]

/** The allowlist's argv shape. The flag's MEASURED name is `--allowedTools` (camelCase is also accepted). */
export const AI_REVIEW_ALLOWED_TOOLS_ARGS = ['--allowedTools', ...AI_REVIEW_ALLOWED_TOOLS]

/**
 * THE EXPLICIT DENY LIST — protection against a FUTURE allow-loosening.
 *
 * In Claude Code's permission layer, deny is STRONGER than allow, so this
 * list holds even if someone later adds a broader `Bash(gh pr:*)` allow.
 * `gh api -X POST` CANNOT be expressed with a prefix pattern (the pattern
 * matches the START of the command, and `-X POST` is at the end) — that's
 * covered by the prompt's prohibition.
 */
export const AI_REVIEW_DISALLOWED_TOOLS = [
  // The MUTATING subcommands of `gh pr`. This list is the pair of the
  // BROADER `Bash(gh pr:*)` allow: the allow permits the read-only paths
  // (list/view/diff/checks/status) with one pattern, THIS holds back the
  // mutation. MEASURED basis: per `gh --help`, only `--help`/`--version` can
  // precede the verb, so the `gh <mutating-verb>` prefix cannot be worked
  // around (unlike `git -c core.fsmonitor=<command>`, which is why the
  // enumeration stayed with git). Deny is STRONGER than allow, so this holds
  // even if the allow gets broadened further later.
  'Bash(gh pr comment:*)',
  'Bash(gh pr review:*)',
  'Bash(gh pr merge:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr close:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh pr ready:*)',
  'Bash(gh pr reopen:*)',
  'Bash(gh pr lock:*)',
  'Bash(gh pr unlock:*)',
  // The mutating paths of `gh run`: a rerun/cancel moves CI, delete deletes.
  'Bash(gh run cancel:*)',
  'Bash(gh run rerun:*)',
  'Bash(gh run delete:*)',
  'Bash(gh run watch:*)',
]

export const AI_REVIEW_DISALLOWED_TOOLS_ARGS = ['--disallowedTools', ...AI_REVIEW_DISALLOWED_TOOLS]

/**
 * The READABLE FORM of the denied calls — the COMMAND, not the count.
 *
 * MEASURED SCHEMA (see `AI_REVIEW_ALLOWED_TOOLS`'s header): `tool_input.command`
 * carries the exact command. The old message ("ran into 3 permission
 * denials") DROPPED this, so the user didn't know WHAT to add to the
 * allowlist — and that's exactly the information that makes the error
 * actionable.
 *
 * For NON-BASH tools (where there's no `command`) the TOOL'S NAME goes out
 * instead: that's actionable too (`Write` → know that it wanted to write).
 */
export function deniedCommandList(denials) {
  const list = Array.isArray(denials) ? denials : []
  return list.map((d) => {
    const cmd = d?.tool_input?.command
    if (typeof cmd === 'string' && cmd.trim() !== '') return cmd.trim()
    // The tool without a `command`: its NAME is the most telling thing we have.
    return String(d?.tool_name ?? '(unknown tool)')
  })
}

/**
 * The ACTIONABLE TEXT of the denials error.
 *
 * THE THREE REQUIRED ELEMENTS (NEITHER was in the old message, only the count):
 *  1. WHICH COMMAND got denied — without this the user doesn't know what to allow;
 *  2. WHY — `dontAsk` + the settings `allow` list are the TWO factors, and
 *     the user needs to know this is a CONFIGURATION matter, not a review bug;
 *  3. WHAT THEY CAN DO — concretely: what to add to `~/.claude/settings.json`'s
 *     `permissions.allow` list, in a COPYABLE form.
 *
 * THE LIST IS TRUNCATED: a 20-item denials list would make the status line
 * unusable. The FIRST THREE commands are enough for the diagnosis (on #904
 * they all came from the same class), and the remaining count is stated
 * plainly — we don't hide that there were more.
 */
export function denialMessage(denials) {
  const cmds = deniedCommandList(denials)
  const shown = cmds.slice(0, 3)
  const rest = cmds.length - shown.length
  const list = shown.map((c) => `\`${c}\``).join(', ') + (rest > 0 ? ` (+${rest} more)` : '')
  return (
    `claude -p ran into ${cmds.length} permission denial(s) — the review is incomplete. `
    + `The DENIED calls: ${list}. `
    + 'WHY: the review runs with `--permission-mode dontAsk`, and these commands are '
    + 'in neither our allowlist nor `~/.claude/settings.json`\'s `permissions.allow` list. '
    + 'WHAT YOU CAN DO: add them to the `allow` list '
    + `(e.g. ${shown.map((c) => `"Bash(${c.split(/\s+/).slice(0, 3).join(' ')}:*)"`).join(', ')}), `
    + 'or report that the TUI\'s built-in allowlist is incomplete — the place to extend it is '
    + 'core\'s `AI_REVIEW_ALLOWED_TOOLS` list (tuipr, bin/next/allowlist.mjs).'
  )
}

// The SHARED PROMPT BLOCK about permission realities — BOTH review paths get it.
//
// (c) A COMPOUND COMMAND is IN PRINCIPLE not permitted: the permission
// patterns are PREFIX-based, so a command chained with `;` in the shape
// `gh pr checks 904 …; gh api …` gets denied even if BOTH halves would be
// individually allowed — the user's live test died on exactly this. Running
// them separately is cheaper and more robust than any compound parsing on
// our side.
//
// (a-fallback) The prohibition on user-level instructions is
// DEFENSE-IN-DEPTH: the primary defense is `--setting-sources project,local`
// (measurably excludes the user-level CLAUDE.md), but if a workflow
// instruction leaked in through some other path anyway (e.g. a future CLI
// version with different source semantics), the prompt states plainly that
// it must not be followed. `claude-usage` is named and forbidden explicitly:
// the measured denial was exactly this.
export const PERMISSION_REALITY_INSTRUCTION = [
  'For SEARCHING use the Grep TOOL (it is in your tool set), NOT `git grep`',
  'or `rg` via Bash — the Grep tool needs no permission. If the permission',
  'layer denies a Bash call, do NOT retry it with variations: note it in the',
  'review summary and move on to the other sweeps — a partial result is still',
  'valuable, always return your findings in the response JSON.',
  'Run commands ONE AT A TIME, NEVER chain several commands with `;`, `&&`,',
  'or a pipe: permission patterns are prefix-based, and a compound command',
  'gets denied even if every piece of it would be individually allowed.',
  '',
  'Do NOT run `claude-usage`, and do NOT follow user-level (global CLAUDE.md)',
  'workflow instructions (gates, delegation rules) — your task is',
  'EXCLUSIVELY the review.',
  '',
  'You are FORBIDDEN from posting to or mutating GitHub: no `gh pr comment`,',
  'no `gh pr review`, no `gh pr merge`, no `gh api` POST/PATCH/PUT/DELETE',
  '(mutating call). `gh api` may be used ONLY for reading',
  '(GET — e.g. querying reviews/comments).',
].join('\n')
