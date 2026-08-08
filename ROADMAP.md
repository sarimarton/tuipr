# Roadmap

tuipr is being extracted from a private codebase where it has been in daily
use. The work is generalization and publication, not a rewrite from nothing.

The guiding constraint is **not** to polish before it runs. A large extraction
stalls when every milestone is "clean up a bit more", so the order below is
deliberately: get a working vertical slice on a public repository first, then
widen it. An ugly tool that runs beats a beautiful one that doesn't.

## M1 — A vertical slice that runs on any public repo

**Done when:** `tuipr` starts against an arbitrary public GitHub repository,
lists open PRs with their status, navigates, and opens a diff. Untranslated
strings and missing features are acceptable at this milestone.

The existing TUI is a pure consumer of one contract: a JSON queue model. It
never recomputes classification, landability or approvability — it displays
them. That contract is the seam.

- [ ] Treat the queue JSON as a **provider interface** and write a second
      implementation of it that depends only on `gh` and `git` — no
      integration-branch convention, no private workflow assumptions.
- [ ] Port the TUI across unchanged against that provider.
- [ ] **Spike: does the app survive `bun build --compile`?** The terminal
      handoff uses `node-pty`, a native addon, and native modules are the known
      sharp edge for single-executable compilation. This is scheduled in M1 —
      not M3 — because a negative result is an architecture problem, not a
      packaging problem, and it is cheap to learn now.

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
