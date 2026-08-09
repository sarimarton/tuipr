// AI-ASSISTED CONFLICT RESOLUTION — FOR QUEUE-INTERNAL COLLISIONS.
//
// (wf31/71) WHY A SEPARATE MODULE, AND WHY A SPECIAL PROMPT: the user's
// stipulation — "in the TUI, the conflict indicator doesn't mean a conflict
// against main, it means one against a queue culprit, so this needs a special
// prompt."
//
// THE DIFFERENCE IS NOT STYLISTIC. A generic "resolve this conflict" prompt
// assumes that one of the two sides is the FINISHED TRUTH (main), and the
// other must be adjusted to match it. For a queue-internal collision, NEITHER
// SIDE IS THAT:
//
//   · the culprit is a PR THAT HASN'T LANDED YET, NOT YET REVIEWED — not "the
//     state of main", but a parallel line of work that can itself still
//     change or fail;
//   · our own PR isn't "stale" either — relative to main it can be entirely
//     fresh (measured on #911: it was MERGEABLE against main, the conflict's
//     source was four queue-internal PRs);
//   · the correct output is therefore not "accept one of them", but the
//     SEMANTIC UNIFICATION OF THE TWO INTENTS — or stating that they can't be
//     unified.
//
// THAT'S WHY THE PROMPT SUPPLIES THREE THINGS a generic resolve can't:
//   1. that this is a queue-internal collision (main is NOT affected — or if
//      it is, that too);
//   2. that the culprit is a PR, with its number and its own intent (title,
//      diff);
//   3. that the decision's output is NOT JUST code: it must also say whether
//      the two pieces of work are FUNCTIONALLY related — because that
//      determines whether stacking is even warranted in the first place (we
//      stated in wf31/68: a machine can't decide this, but an AI can, by
//      ANALYZING the two diffs).

import { budgetArgs, claudePath, modelArgs } from './ai-review-config.mjs'

/** The two operating modes of resolve. */
export const RESOLVE_MODES = ['analyze', 'apply']

/**
 * THE JSON SCHEMA for the resolution analysis (`--json-schema`).
 *
 * WHY A SCHEMA: the output is displayed by the TUI and also consumed by the
 * CLI — parsing prose would be the same error class that the machine-readable
 * form of `queueConflicts` already eliminated. Schema validation runs on the
 * model's side, so a malformed shape shows up there, not for us.
 */
export function resolveAnalysisSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['functionallyRelated', 'confidence', 'summary', 'files'],
    properties: {
      // THE MOST IMPORTANT FIELD: this determines whether stacking is
      // warranted.
      functionallyRelated: {
        type: 'boolean',
        description: 'Whether the two PRs substantively touch the same functionality (not just the same file).',
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      // THE NATURE OF THE RESOLUTION — this tells the user how much work to
      // brace for.
      resolutionKind: {
        type: 'string',
        enum: ['mechanical', 'semantic', 'needs-decision'],
        description: 'mechanical: the two changes sit side by side without conflict. '
          + 'semantic: the logic needs to be merged together. '
          + 'needs-decision: a human decision is needed (conflicting intent).',
      },
      summary: { type: 'string', description: '2-4 sentences: what each side wants, and why they collide.' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'ours', 'theirs'],
          properties: {
            path: { type: 'string' },
            ours: { type: 'string', description: 'What OUR PR changes in this file.' },
            theirs: { type: 'string', description: 'What the CULPRIT changes in this file.' },
            advice: { type: 'string', description: 'How it can be unified (or why it can\'t).' },
          },
        },
      },
    },
  }
}

/**
 * THE PROMPT — with the context of the queue-internal collision.
 *
 * `mode: 'analyze'` ONLY ANALYZES (writes no file), `apply` also performs the
 * resolution in the ALREADY-CONFLICTED worktree. The split between the two is
 * deliberate: analysis is CHEAP and side-effect-free, so it can always be run;
 * resolution WRITES CODE, so it deserves an explicit gesture (the same
 * principle as the `c` measurement).
 */
export function resolvePrompt({
  pr,
  prTitle = '',
  culprit,
  culpritTitle = '',
  files = [],
  mainConflict = false,
  mode = 'analyze',
}) {
  const fileList = files.length > 0
    ? files.map((f) => `  - ${f}`).join('\n')
    : '  (the list cannot be measured — read it from the git state)'
  // THE MAIN AXIS IS STATED IN BOTH STANCES: if there's no main-conflict, that
  // is IMPORTANT information (landing isn't at risk, so there's nothing to
  // "fix" about the PR); if there is one, that's a DIFFERENT task, and the
  // prompt must not conflate the two.
  const mainNote = mainConflict
    ? 'NOTE: this PR ALSO conflicts with MAIN. That is a SEPARATE, more serious problem — '
      + 'flag it, but analyze the queue-internal collision independently of it.'
    : 'The PR does NOT conflict with MAIN (measured). So its landing is not at risk — '
      + 'do NOT try to bring the PR "up to date" with main, because there is nothing to fix there.'

  const shared = `PR #${pr}${prTitle ? ` ("${prTitle}")` : ''} conflicts with PR #${culprit}${culpritTitle ? ` ("${culpritTitle}")` : ''}.

THIS IS A QUEUE-INTERNAL COLLISION, NOT A MAIN CONFLICT. What that means:

- #${culprit} is a PR that HASN'T LANDED YET, not necessarily reviewed —
  a parallel line of work that can itself still change or fail. NOT "the
  finished truth".
- #${pr} isn't stale either: ${mainNote}
- Neither side has priority. The question isn't "which one do we accept",
  but whether the TWO INTENTS can be unified, and how.

Conflicting files:
${fileList}

The repo's conventions are described by the project's review skills
(code-quality, patterns, ui-components, types-api) — if the unification
needs a convention decision, follow those.`

  if (mode === 'apply') {
    return `${shared}

TASK: in the ALREADY-CONFLICTED git state (mid-rebase, with conflict markers),
resolve the collisions.

Rules:
1. UNIFY THE TWO INTENTS. Discarding one side entirely is ONLY correct if the
   other literally contains it — and even then, state why.
2. No conflict marker (<<<<<<<, =======, >>>>>>>) may remain in the files.
3. Do NOT commit, do NOT continue the rebase, do NOT touch the git index
   beyond writing the file. The review is the user's job — yours is to
   clean up the WORKING TREE.
4. If a collision requires a HUMAN DECISION (conflicting intent, e.g. both
   sides introduce the same field with a different semantics), do NOT resolve
   it unilaterally: leave the markers AND state in your answer which file it's
   in and why.

Give your answer per the provided JSON schema, also stating in
\`resolutionKind\` whether what you did was a mechanical or a semantic
unification.`
  }

  return `${shared}

TASK: ONLY ANALYZE — DO NOT MODIFY A SINGLE FILE.

Read both sides' changes (from git: the diffs of #${pr} and #${culprit} for the
conflicting files), and determine:

1. Are the two pieces of work FUNCTIONALLY related? (The question isn't
   whether they write to the same file — that's a given. The question is
   whether they shape the same BEHAVIOR, whether one builds on something the
   other introduced.) This is the most important output: it determines
   whether it's worth stacking #${pr} on top of #${culprit}, or whether it's
   better to wait for it to land and rebase onto main afterward.
2. What is the nature of the resolution: mechanical (the two changes sit side
   by side without conflict), semantic (the logic needs to be merged
   together), or does it need a human decision.
3. Per file: what our side wants, what the culprit wants, and how it can be
   unified.

Give your answer per the provided JSON schema.`
}

/**
 * Assembling the `claude -p` call.
 *
 * THE TOOLSET SHRINKS BY MODE: `analyze` does NOT get `Edit`/`Write` — we
 * don't "ask it" not to modify anything, it simply CAN'T. The prompt's
 * prohibition isn't a safety net by itself (a model can misread it); the
 * tool list is.
 */
export function resolveCommand({
  pr,
  prTitle,
  culprit,
  culpritTitle,
  files,
  mainConflict,
  mode = 'analyze',
  maxBudgetUsd,
  model,
}) {
  const tools = mode === 'apply'
    ? 'Bash,Read,Grep,Glob,Edit,Write,Skill'
    : 'Bash,Read,Grep,Glob,Skill'
  const args = [
    '-p', resolvePrompt({ pr, prTitle, culprit, culpritTitle, files, mainConflict, mode }),
    '--output-format', 'json',
    '--json-schema', JSON.stringify(resolveAnalysisSchema()),
    ...budgetArgs(maxBudgetUsd),
    '--permission-mode', 'dontAsk',
    '--tools', tools,
    ...modelArgs(model),
  ]
  return [claudePath(), args]
}
