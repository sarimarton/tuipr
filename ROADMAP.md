# Roadmap

tuipr is being extracted from a private codebase where it has been in daily
use. The work is generalization and publication, not a rewrite from nothing.

The guiding constraint is **not** to polish before it runs. A large extraction
stalls when every milestone is "clean up a bit more", so the order below is
deliberately: get a working vertical slice on a public repository first, then
widen it. An ugly tool that runs beats a beautiful one that doesn't.

## M1 — A vertical slice that runs on any public repo ✅

**Reached.** `tuipr` starts against an arbitrary GitHub repository, lists open
PRs with computed status, navigates, and opens the detail panel. Verified live
against `cli/cli` (65 open PRs): drafts, conflicts, approvals and the
changes-requested case all classify correctly.

Two findings from getting here are worth keeping:

- **`mergeStateStatus: BLOCKED` alone does not mean a blocked PR.** On a
  repository that requires review, *every* open PR reports it — it is the
  ordinary awaiting-review state. Treating it as blocked would paint the whole
  list red and distinguish nothing. Only a human's `CHANGES_REQUESTED` counts.
- **`node-pty` does not survive `bun build --compile`.** It resolves its native
  addon through a dynamically built path, and the bundler can only embed
  addons it sees as a static literal. This does not block single-file binaries:
  the terminal handoff already has a second path that uses `script(1)`, an
  external binary, and that path compiles. The cost is losing an escape-sequence
  filter, so the binary flickers slightly on returning from the diff viewer.
  The clean fix is upstream — a flag asking the viewer not to manage the
  alternate screen — which is worth a patch rather than a fork.

The existing TUI is a pure consumer of one contract: a JSON queue model. It
never recomputes classification, landability or approvability — it displays
them. That contract is the seam.

- [x] Treat the queue JSON as a **provider interface** and write a second
      implementation of it that depends only on `gh` and `git`.
- [x] Port the TUI across unchanged against that provider.
- [x] **Spike: does the app survive `bun build --compile`?**

The richer conflict-prediction model (which PRs will collide, and why) is
**additive**, not foundational: it is a second, better provider behind the same
interface, and it lands after M1.

## What still calls the original script

Exactly two paths, both narrow and both failing loudly rather than silently:

| key | feature | why it needs the script |
|---|---|---|
| `c` | conflict measurement | runs `merge-tree` probes against the PRs ahead in the queue and reports which ones actually collide |
| `v` | AI conflict resolution | drives a resolution attempt and reports whether a marker was left behind |

Everything else — the queue, diff review, budgeted AI review, approval and
merge — runs without it. Generalizing the measurement is the natural home for
the richer provider described above, since that is where the measured
`classification` and `dep` fields come from.

## M2 — Decoupling and English ✅

- [x] Workplace-specific vocabulary removed — done before the first public
      commit, since git history is permanent.
- [x] **Comments and interface strings translated to English**, across ~17k
      lines. Each file was checked with `scripts/verify-translation.mjs`, which
      compares the code's skeleton before and after: comments stripped, string
      literals replaced by a placeholder, template interpolations kept as code.
      `node --check` proves syntax; this proves meaning.
- [ ] Make the diff reviewer **pluggable** (see below).

The translation's real hazard turned out not to be mistranslation but
**cross-file text coupling**: one file matched a pattern against text produced
in another, and when the producer became English the match silently stopped
working. Nothing failed, no test noticed, a warning simply lost its colour.
Where such a pattern still exists, it now says so at the point of use.

## M3 — Installable

- [x] `npm i -g tuipr` works — verified by packing the tarball, installing it
      into a clean project and running the installed binary.
- [x] **The diff viewer is not bundled.** Depending on it directly took the
      install from 23 MB to 367 MB: 97 MB of platform binary, 61 MB of bun,
      23 MB of typescript, plus 62 MB for `node-pty`. One command to install
      one binary (`brew install hunk`) is the better trade, and the code
      already resolved it from `PATH`. This reverses an earlier plan — the
      measurement decided it.
- [x] **A single-file binary works.** `npm run build:binary` produces a 61 MB
      executable that runs from anywhere with no Node and no `node_modules` —
      verified against a real repository in a real terminal.

      Getting there needed one change in our own code, and it is the more
      interesting half of the finding. The app module was imported through a
      variable, so a bundler could not see which module the entry needs and
      left it out entirely: the binary started and then died on
      `Cannot find module './tui-app.mjs'`. The program worked; the packaging
      did not. The default specifier is now a static literal, with the
      variable path kept for the test handle that needs it.

- [ ] Per-platform release artifacts + a Homebrew tap whose formula declares
      `hunk` as a dependency, so the binary path also installs in one command.
- [ ] Onboarding docs: authentication, requirements, first run.

## M4 — Portfolio grade

- [x] Tests around the two contracts that can lie silently: what the provider
      claims is true about a PR, and what the row layer shows about it.
- [x] CI on Linux and macOS, including a check that the entry point never
      returns silently.
- [x] **Screenshots of the running tool**, captured from a real terminal and
      rendered to SVG by `scripts/ansi-to-svg.mjs` — sharp at any size, and
      regenerated by re-running the script rather than by hand.
- [x] Landing page showing the same.
- [ ] A recorded session, once the remaining flows are wired up. A still image
      shows the shape; it does not show the rhythm of working through a queue.

## Design decisions

**The diff reviewer is pluggable, with honest capability tiers.** The
integration is deep — findings are injected into a live review session and
inline comments are read back out — and that depth is specific to one viewer.
Rather than reduce everything to a lowest common denominator, adapters declare
what they can do:

| capability | who can |
|---|---|
| open a diff and take over the terminal | any viewer |
| accept injected agent findings | full adapters only |
| return inline comments | full adapters only |

Everything else — the queue, the gates, the attestation, the budget — works
regardless of which viewer is installed.

**The diff reviewer is a runtime dependency, not a library.** It sits in the
same category as `git` and `gh`: a tool the user has. Reimplementing it would
mean rebuilding, worse, the thing that is not this project's contribution.

**No downstream fork.** Forking would mean carrying a per-platform build matrix
for someone else's fast-moving project. If an integration hook is missing, the
correct move is a patch upstream — which is also a better thing to have done
than a private fork. Forking stays available as a fallback; there is no reason
to spend it now.

**Scope stays on the pull-request lifecycle.** Queue, review, gates, merge,
attestation. Issue management is a different tool with different mechanics —
no diff, no merge, no gate to hold.
