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

## M2 — Decoupling and English

- [ ] Remove workplace-specific vocabulary, allowlists and defaults.
- [ ] Translate UI strings and comments to English. The prose documentation is
      already English and carries the design rationale, so this is mechanical
      rather than interpretive.
- [ ] Make the diff reviewer **pluggable** (see below).

## M3 — Installable

- [ ] `npm i -g tuipr`, with `hunkdiff` as a direct dependency so one install
      brings the whole loop. Binary resolution already exists in the code and
      points at a resolved path rather than `PATH`.
- [ ] Pin the diff-reviewer dependency to an **exact** version. It publishes
      very frequently; a caret range would import breaking changes silently.
- [ ] Onboarding docs: authentication, requirements, first run.
- [ ] Single-file binaries + a Homebrew tap, if the M1 spike came back green.

## M4 — Portfolio grade

- [ ] Tests around the provider contract and the review flow.
- [ ] CI.
- [ ] **A recorded demo.** For a terminal application this is worth more than
      any amount of README prose — nobody understands a TUI from a description.
- [ ] Landing page updated with the demo.

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
