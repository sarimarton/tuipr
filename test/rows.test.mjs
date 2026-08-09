// Contract tests for the queue model → display rows step.
//
// WHAT THESE PROTECT: this is the other half of the contract the provider
// tests cover. The provider decides WHAT is true about a PR; this decides what
// the user SEES about it. A mistake here is invisible to the provider tests and
// produces a list that quietly disagrees with reality — the same lying-status
// class, one layer up.
//
// The cases below are the ones where the rules are not obvious from the code's
// shape: precedence between an optimistic state and the measured one, what a
// stacked row is allowed to do, and the deliberate fallbacks when a provider
// omits fields it did not measure.

import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRows } from '../src/lib/rows.mjs'

/** A plain, actionable row — the cases deviate from this. */
const pr = (over = {}) => ({
  number: 10,
  title: 'Title',
  state: 'queue',
  isDraft: false,
  reviewDecision: null,
  canApprove: true,
  headRefName: 'feature',
  ...over,
})

test('a flat list survives a provider that measures no stacking', () => {
  // The gh/git provider deliberately omits stackDepth/stackRoot/stackedOn,
  // because it does not measure them. The view must degrade to a flat list
  // rather than break — an exception here would take down the whole TUI.
  const rows = buildRows([pr({ number: 2 }), pr({ number: 1 })])
  assert.deepEqual(rows.map((r) => r.number), [1, 2])
  assert.equal(rows.every((r) => r.selectable), true)
  assert.equal(rows.every((r) => r.indentDepth === 0), true)
})

test('a stacked row cannot be acted on, and says so by being indented', () => {
  // Its fate is decided by its base, so offering actions on it would offer
  // something that cannot be honoured.
  const rows = buildRows([pr({ number: 1 }), pr({ number: 2, stackedOn: 1 })])
  const stacked = rows.find((r) => r.number === 2)
  assert.equal(stacked.selectable, false)
  assert.equal(stacked.indent, true)
  assert.equal(stacked.indentDepth, 1)
})

test('a stacked row shows as in-queue, not as its own state', () => {
  // The queue contains it THROUGH its base, so that is the honest mark. The
  // stacked-ness is stated by the row-end flag instead of being duplicated.
  const rows = buildRows([pr({ number: 1 }), pr({ number: 2, stackedOn: 1, state: 'blocked' })])
  assert.equal(rows.find((r) => r.number === 2).mark.label, '● in queue')
})

test('a chain groups under its root rather than its immediate base', () => {
  // Grouping by the immediate base splits an A→B→C chain apart, and an
  // unrelated PR whose number falls between them can wedge into the middle.
  const rows = buildRows([
    pr({ number: 1 }),
    pr({ number: 2, stackedOn: 1, stackRoot: 1, stackDepth: 1 }),
    pr({ number: 3, stackedOn: 2, stackRoot: 1, stackDepth: 2 }),
    pr({ number: 4 }),
  ])
  assert.deepEqual(rows.map((r) => r.number), [1, 2, 3, 4])
  assert.equal(rows.find((r) => r.number === 3).indentDepth, 2)
})

test('an optimistic merge overrides the model, because it is newer', () => {
  // GitHub's index updates asynchronously, so for seconds after a merge the
  // API still reports the PR as open. Our own action's result is a fact we
  // already know — asking the API that is lagging would report a merged PR as
  // still queued.
  const rows = buildRows([pr()], { optimistic: { 10: 'merged' } })
  assert.equal(rows[0].mark.label, '✔ merged')
  assert.equal(rows[0].settled, true)
})

test('an optimistic approval changes the review column only', () => {
  // Approving does not decide the PR's fate; merging does. So it must not
  // touch the mark that states that fate.
  const rows = buildRows([pr()], { optimistic: { 10: 'approved' } })
  assert.equal(rows[0].rmark.label, '✔ approved')
  assert.equal(rows[0].mark.label, '● in queue')
  assert.equal(rows[0].settled, false)
})

test('a draft is offered no approval column at all', () => {
  const rows = buildRows([pr({ isDraft: true, state: 'draft' })])
  assert.equal(rows[0].rmark, null)
})

test('an unknown state falls back to the missing mark, not to silence', () => {
  // A state the view does not recognise means the contract drifted. Rendering
  // nothing would read as "fine"; the missing mark says we do not know.
  const rows = buildRows([pr({ state: 'something-new' })])
  assert.equal(rows[0].mark.label, '❓ missing')
})
