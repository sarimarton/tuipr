# src/ — extracted source

This is the TUI as it was extracted from the codebase where it grew, with
workplace-specific identifiers removed but otherwise unchanged. **It does not
run yet.** Bringing it up is milestone M1 in [../ROADMAP.md](../ROADMAP.md).

Comments and user-facing strings are still in Hungarian; translating them is
M2. They are left in place deliberately — they carry the reasoning behind the
design (why a dependency direction is one-way, why a keystroke is confirmed,
what a measurement showed), and that reasoning is worth translating rather
than discarding.

## Layout

| file | role |
|---|---|
| `tui.mjs` | entry point, deliberately thin — starting the app and re-exporting the core's public surface |
| `tui-core.mjs` | the pure core: no React, no rendering |
| `tui-app.mjs` | the React/Ink component tree |
| `tui-render.mjs` | rendering helpers |
| `lib/` | everything below the UI: data fetching, diagnosis, caching, the diff-viewer integration, AI-review orchestration |

The dependency direction is strictly one-way — the entry and the app both
import from the core, and the core imports from neither. This is not a style
preference: a cycle through the entry point cannot settle when the module is
run as an entry, and the failure mode is a silent exit with empty output.

## The one seam that matters

`lib/queue-fetch.mjs` is 102 lines and is the **entire** coupling to the
original data source. It spawns a shell script and parses its JSON. Everything
above it — classification, landability, approvability — is displayed, never
recomputed.

That makes the JSON a **provider contract** rather than an implementation
detail. M1 writes a second provider against `gh` and `git` alone, and the rest
of the application ports across untouched. The original provider's richer
conflict prediction is additive and can return later behind the same contract.
