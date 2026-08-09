// Contract tests for the gh/git provider.
//
// WHAT THESE PROTECT: the provider is ONE implementation of the queue model,
// and the layer above it NEVER recomputes the classification — it only
// displays it. So a broken classification silently produces a lying UI here,
// which no render test would catch. That's why every branch of the
// classification gets a case, with input taken from MEASURED reality.
//
// WHY WE DON'T CALL `gh`: the test certifies the MAPPING, not GitHub. Bringing
// in the network would be slow, auth-dependent, and flaky — whereas the
// contract is cleanly testable, because the mapping is a pure function.

import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyPr, canApprovePr, toQueueRow } from '../src/lib/providers/github.mjs'

/** A minimal, MERGEABLE/CLEAN raw PR — the cases deviate from this. */
const base = {
  number: 1,
  title: 'Title',
  isDraft: false,
  headRefName: 'feature',
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: null,
  author: { login: 'someone' },
}

test('draft overrides everything else', () => {
  // Draft is decided FIRST, before conflict: a conflicting draft must be
  // reported as draft, because that's the action-relevant fact for the user
  // (there's nothing to do with it while it's a draft).
  assert.equal(classifyPr({ ...base, isDraft: true, mergeable: 'CONFLICTING' }), 'draft')
})

test('a conflict is recognizable from either signal', () => {
  assert.equal(classifyPr({ ...base, mergeable: 'CONFLICTING' }), 'conflict')
  assert.equal(classifyPr({ ...base, mergeStateStatus: 'DIRTY' }), 'conflict')
})

test('a BLOCKED merge-state ALONE is not a blocked PR', () => {
  // MEASURED FINDING (cli/cli, 2026-08): in a repo that mandates review,
  // EVERY open PR is `BLOCKED`, because the review hasn't happened yet. This
  // is the normal, waiting-for-review state — if we reported it as blocked,
  // the whole list would be ⛔, and the signal wouldn't distinguish anything.
  assert.equal(classifyPr({ ...base, mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }), 'queue')
})

test('blocked is what a HUMAN stopped', () => {
  assert.equal(classifyPr({ ...base, mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED' }), 'blocked')
})

test('a double UNKNOWN is the "we don\'t know" state, not "fine"', () => {
  // GitHub computes mergeability asynchronously. Until there's an answer,
  // silence must NOT be read as "no problem".
  assert.equal(classifyPr({ ...base, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }), 'missing')
})

test('your own PR is not offered for approve', () => {
  // Fail-closed: GitHub wouldn't allow it either, so we shouldn't offer an
  // operation that's guaranteed to fail.
  assert.equal(canApprovePr({ ...base, author: { login: 'me' } }, 'me'), false)
  assert.equal(canApprovePr({ ...base, author: { login: 'other' } }, 'me'), true)
})

test('an already-decided review does not get another approve offer', () => {
  assert.equal(canApprovePr({ ...base, reviewDecision: 'APPROVED' }, 'me'), false)
  assert.equal(canApprovePr({ ...base, reviewDecision: 'CHANGES_REQUESTED' }, 'me'), false)
})

test('a draft is not offered for approve', () => {
  assert.equal(canApprovePr({ ...base, isDraft: true }, 'me'), false)
})

test('the row does NOT contain measurement-derived fields', () => {
  // THIS IS THE MOST IMPORTANT CASE. Stacking and conflict diagnosis come
  // from MEASUREMENT, which this provider doesn't perform. If we wrote `0` or
  // `false` here instead of `null`, the view would read it as "we measured
  // it, and there's none" — the consumer can't distinguish a missing
  // measurement from a negative result.
  const row = toQueueRow(base, { viewer: 'me', mergeMethod: 'squash' })
  assert.equal(row.classification, undefined)
  assert.equal(row.stackedOn, undefined)
  assert.equal(row.dep, undefined)
})

test('the row does provide the fields needed for display', () => {
  const row = toQueueRow(base, { viewer: 'me', mergeMethod: 'squash' })
  assert.equal(row.number, 1)
  assert.equal(row.title, 'Title')
  assert.equal(row.state, 'queue')
  assert.equal(row.isDraft, false)
  assert.equal(row.headRefName, 'feature')
  assert.equal(row.mergeMethod, 'squash')
  assert.equal(row.canApprove, true)
})
