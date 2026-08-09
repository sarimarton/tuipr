// Recognising "there is no live diff-viewer session".
//
// WHY THIS DESERVES ITS OWN TEST: the answer decides a BRANCH, not a message.
// A true means "none yet, open one"; a false means "something else is wrong,
// report it". Get it backwards and the very first diff review on a clean
// machine dies instead of opening — which is exactly what happened, because
// the pattern was the exact phrase `no active session` while the tool says
// "No active Hunk sessions are registered with the daemon".
//
// The cases below are that measured wording, the shape it used to be, and —
// just as important — the errors that must NOT be mistaken for it.

import assert from 'node:assert/strict'
import test from 'node:test'
import { isNoActiveSession } from '../src/lib/hunk.mjs'

const failure = (stderr, stdout = '') => ({ status: 1, stderr, stdout })

test('the wording the tool actually uses is recognised', () => {
  // Measured against hunk 0.17.0: a word inserted mid-phrase and a plural.
  assert.equal(
    isNoActiveSession(failure('hunk: No active Hunk sessions are registered with the daemon.')),
    true,
  )
})

test('older and shorter phrasings still count', () => {
  assert.equal(isNoActiveSession(failure('no active session')), true)
  assert.equal(isNoActiveSession(failure('No active sessions')), true)
})

test('a named different error is NOT read as a missing session', () => {
  // Guessing here would send the user hunting for a session while the real
  // fault is an install or a daemon problem. A raw error beats a false
  // diagnosis.
  assert.equal(isNoActiveSession(failure('hunk: daemon crashed')), false)
  assert.equal(isNoActiveSession(failure('permission denied')), false)
  assert.equal(isNoActiveSession(failure('database is locked')), false)
})

test('a silent non-zero exit counts as no session', () => {
  // Nothing on either stream means no readable session state either — the
  // fail-soft direction is "none", because there is nothing to contradict it.
  assert.equal(isNoActiveSession(failure('', '')), true)
})

test('success is never a missing session', () => {
  assert.equal(isNoActiveSession({ status: 0, stderr: '', stdout: 'anything' }), false)
})

test('a missing result object does not throw', () => {
  assert.equal(isNoActiveSession(null), false)
  assert.equal(isNoActiveSession(undefined), false)
})
