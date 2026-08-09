// tui-core — the BARREL for the review workstation's PURE logic.
//
// THIS FILE NOW ONLY RE-EXPORTS. The actual implementation lives in the
// bin/next/* modules (see the layer order below); this module is the single
// entry surface of the EXTERNAL CONTRACT toward the core.
//
// WHY IT STILL EXISTS, given it implements nothing: consumers address 175
// names THROUGH THIS PATH — test/next.test.ts imports `mergeBlockers` from
// here, test/verify-silent.test.ts loads this file with 16 dynamic
// `import()`s, and the next-tui / next-poll / next-cache tests do too. The
// barrel makes the module split INVISIBLE to consumers.
//
// Why a SEPARATE module from the entry point (tui.mjs) and the React layer
// (tui-app.mjs): the entry point used to hold these functions itself, and
// app.mjs imported them back — that was a CIRCULAR ESM import. Run as the
// entry, the cycle could never close (the module is still being evaluated
// when the app imports back into it), so the dynamic import's top-level
// await never settled: node died with exit 13 and EMPTY output — the TTY
// `queue` was a silent no-op. The dependency direction is therefore now
// STRICTLY one-way:
//
//   tui.mjs (entry) ──> tui-app.mjs (React/Ink) ──┐
//                     └────────────────────────────────────────────> core
//
// The core imports NEITHER of the other two, and never imports back into
// itself. test/next-tui-module.test.ts checks this as a static invariant,
// and the entry point is launched by a smoke test as a real process.
//
// THE BIN/NEXT/* LAYER ORDER (the arrow reads "imports", NEVER the reverse):
//
//   layout, proc, review-store       ← zero project imports (the bottom layer)
//     ├─> cache, rows, merge
//     ├─> poll, queue-fetch, hunk ─> hunk-findings
//     ├─> allowlist, diagnosis
//     │     └─> ai-review-config ─> ai-review-view
//     │           └─> ai-review-run ─> ai-review-agent
//     └─> panel                      ← the top core layer
//
// CIRCULAR IMPORTS ARE FORBIDDEN, and we guard this MECHANICALLY:
// scripts/check-next-modules.mjs builds a static graph and fails on a cycle
// — BEFORE THE MODULE EVEN LOADS, because the cycle itself would hang the
// checker too (MEASURED: a deliberate layout→rows cycle once hung the
// checker for 2 minutes). The same script also catches FREE (unresolved)
// identifiers: ESM resolves those not at load time but at CALL time, so a
// function misplaced into the wrong module PASSES every `import` and only
// throws in production. MEASURED on this exact cut: rows.mjs called a
// `reviewSpinnerFlag` left behind in core — all 9 modules said "loads OK",
// yet 58 tests failed.
//
// The data source is EXCLUSIVELY `tuipr queue --json` (the canonical model
// of package (b)) — classification, landability and approvability are NOT
// recomputed here, only mapped. This is deliberate: a duplicated decision
// chain is exactly what produced the drift that package (b) just eliminated.
//
// The actions (review / findings / approve / merge) call the existing
// NON-INTERACTIVE paths (`tuipr approve --yes`, `gh pr merge`, `gh api`), so
// the TUI is a controller, not a parallel implementation.
//
// The pure functions (buildRows / canApproveRow / canMergeRow / displayWidth
// / titleBudget / reviewBody / reviewCommand / toGithubComments) are under
// unit test in test/next-tui.test.ts. The process launchers (fetchQueue /
// fetchPrRefs / hunkComments / uploadFindings) get manual verification.

export * from './lib/ai-review-config.mjs'
export * from './lib/ai-review-agent.mjs'
export * from './lib/ai-review-run.mjs'
export * from './lib/ai-review-view.mjs'
export * from './lib/allowlist.mjs'
export * from './lib/cache.mjs'
export * from './lib/conflict-resolve.mjs'
export * from './lib/diagnosis.mjs'
export * from './lib/hunk-findings.mjs'
export * from './lib/hunk.mjs'
export * from './lib/layout.mjs'
export * from './lib/merge.mjs'
export * from './lib/panel.mjs'
export * from './lib/term-colors.mjs'
export * from './lib/poll.mjs'
export * from './lib/proc.mjs'
export * from './lib/queue-fetch.mjs'
export * from './lib/review-menu.mjs'
export * from './lib/review-store.mjs'
export * from './lib/rows.mjs'
