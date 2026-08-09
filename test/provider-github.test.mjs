// A gh/git provider szerződés-tesztjei.
//
// AMIT EZEK VÉDENEK: a provider a queue-modell EGYIK implementációja, és a
// fölötte lévő réteg a besorolást SOSEM számolja újra — csak megjeleníti.
// Vagyis egy elrontott besorolás itt csendben hazug UI-t eredményez, amit
// semmilyen render-teszt nem fog meg. Ezért a besorolás minden ága kap egy
// esetet, a MÉRT valóságból vett bemenettel.
//
// MIÉRT NEM HÍVUNK `gh`-t: a teszt a LEKÉPZÉST hitelesíti, nem a GitHubot. A
// hálózat bevonása lassú, hitelesítés-függő és flaky lenne — a szerződés
// viszont tisztán tesztelhető, mert a leképzés tiszta függvény.

import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyPr, canApprovePr, toQueueRow } from '../src/lib/providers/github.mjs'

/** Egy minimális, MERGEABLE/CLEAN nyers PR — az esetek ebből térnek el. */
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

test('a draft minden mást felülír', () => {
  // A draft ELŐBB dől el, mint a konfliktus: egy konfliktusos draftot
  // draftként kell jelenteni, mert a felhasználó számára az a művelet-releváns
  // tény (nem lehet vele mit kezdeni, amíg draft).
  assert.equal(classifyPr({ ...base, isDraft: true, mergeable: 'CONFLICTING' }), 'draft')
})

test('a konfliktus mindkét jelzésből felismerhető', () => {
  assert.equal(classifyPr({ ...base, mergeable: 'CONFLICTING' }), 'conflict')
  assert.equal(classifyPr({ ...base, mergeStateStatus: 'DIRTY' }), 'conflict')
})

test('a BLOCKED merge-state ÖNMAGÁBAN nem blokkolt PR', () => {
  // MÉRT LELET (cli/cli, 2026-08): kötelező review-t előíró repóban MINDEN
  // nyitott PR `BLOCKED`, mert a review még nem történt meg. Ez a normális,
  // review-ra váró állapot — ha blokkoltnak jelentenénk, az egész lista ⛔
  // lenne, és a jelzés nem különböztetne meg semmit.
  assert.equal(classifyPr({ ...base, mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }), 'queue')
})

test('blokkolt az, amit EMBER állított meg', () => {
  assert.equal(classifyPr({ ...base, mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED' }), 'blocked')
})

test('a kettős UNKNOWN a "nem tudjuk" állapot, nem a "rendben"', () => {
  // A GitHub a mergeability-t aszinkron számolja. Amíg nincs válasz, a
  // hallgatás NEM jelentheti azt, hogy nincs baj.
  assert.equal(classifyPr({ ...base, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }), 'missing')
})

test('a saját PR-t nem ajánljuk approve-ra', () => {
  // Fail-closed: a GitHub sem engedné, tehát ne kínáljunk olyan műveletet,
  // ami garantáltan elbukik.
  assert.equal(canApprovePr({ ...base, author: { login: 'me' } }, 'me'), false)
  assert.equal(canApprovePr({ ...base, author: { login: 'other' } }, 'me'), true)
})

test('a már eldöntött review nem kap újabb approve-ajánlatot', () => {
  assert.equal(canApprovePr({ ...base, reviewDecision: 'APPROVED' }, 'me'), false)
  assert.equal(canApprovePr({ ...base, reviewDecision: 'CHANGES_REQUESTED' }, 'me'), false)
})

test('a draftot nem ajánljuk approve-ra', () => {
  assert.equal(canApprovePr({ ...base, isDraft: true }, 'me'), false)
})

test('a sor NEM tartalmaz mérésből származó mezőket', () => {
  // EZ A LEGFONTOSABB ESET. A stackelés és a conflict-diagnózis MÉRÉSBŐL jön,
  // amit ez a provider nem végez. Ha ide `null` helyett `0`-t vagy `false`-ot
  // írnánk, a nézet azt "megmértük, és nincs"-ként olvasná — a fogyasztó nem
  // tudja megkülönböztetni a hiányzó mérést a negatív eredménytől.
  const row = toQueueRow(base, { viewer: 'me', mergeMethod: 'squash' })
  assert.equal(row.classification, undefined)
  assert.equal(row.stackedOn, undefined)
  assert.equal(row.dep, undefined)
})

test('a sor a megjelenítéshez szükséges mezőket viszont megadja', () => {
  const row = toQueueRow(base, { viewer: 'me', mergeMethod: 'squash' })
  assert.equal(row.number, 1)
  assert.equal(row.title, 'Title')
  assert.equal(row.state, 'queue')
  assert.equal(row.isDraft, false)
  assert.equal(row.headRefName, 'feature')
  assert.equal(row.mergeMethod, 'squash')
  assert.equal(row.canApprove, true)
})
