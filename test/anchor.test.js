/**
 * @file Tests for mechanical citation anchoring (mechanism M1).
 *
 * The headline guarantee under test: a fabricated quote CANNOT be admitted as a
 * citation, regardless of how plausible it sounds.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  admitCitations,
  anchorQuote,
  contentHash,
  normalizeWithIndex,
  Verdict,
} from '../lib/anchor.js'

const DOC =
  'The committee published its findings on 12 March 2024. ' +
  'Researchers reported that the treatment reduced hospitalization rates by 18 percent ' +
  'across the study population, though the authors cautioned that the sample skewed younger. ' +
  'Funding was provided by the national science foundation.'

test('exact quote anchors with precise offsets', () => {
  const q = 'the treatment reduced hospitalization rates by 18 percent'
  const r = anchorQuote(q, DOC)
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'EXACT')
  assert.equal(DOC.slice(r.charStart, r.charEnd), q)
  assert.equal(r.score, 1)
})

test('offsets returned are usable to re-extract the quote', () => {
  const q = 'the authors cautioned that the sample skewed younger'
  const r = anchorQuote(q, DOC)
  assert.equal(r.ok, true)
  assert.equal(DOC.substring(r.charStart, r.charEnd), q)
})

test('normalized match survives whitespace and punctuation drift', () => {
  const q = 'Researchers  reported   that the treatment  reduced hospitalization rates, by 18 percent'
  const r = anchorQuote(q, DOC)
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'NORMALIZED')
  assert.ok(r.charStart >= 0 && r.charEnd > r.charStart)
})

test('smart quotes and casing do not break anchoring', () => {
  const doc = 'The CEO said, \u201cwe will not be raising prices this year,\u201d during the call.'
  const q = 'We Will Not Be Raising Prices This Year'
  const r = anchorQuote(q, doc)
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'NORMALIZED')
})

test('CORE GUARANTEE: a fabricated quote is rejected', () => {
  const fabricated = 'the treatment eliminated all hospitalizations and cured the disease entirely'
  const r = anchorQuote(fabricated, DOC)
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'FAILED')
  assert.equal(r.charStart, -1)
  assert.match(r.reason, /does not appear/i)
})

test('a plausible-sounding but invented statistic is rejected', () => {
  const r = anchorQuote('the treatment reduced hospitalization rates by 45 percent across the study', DOC)
  assert.equal(r.ok, false, 'a changed number must not be admitted')
})

test('quote from a different document is rejected', () => {
  const r = anchorQuote('quarterly earnings exceeded analyst expectations by a wide margin', DOC)
  assert.equal(r.ok, false)
})

test('too-short quotes are refused rather than coincidentally matched', () => {
  const r = anchorQuote('the', DOC)
  assert.equal(r.ok, false)
  assert.match(r.reason, /too short/i)
})

test('empty quote and empty document are handled', () => {
  assert.equal(anchorQuote('', DOC).ok, false)
  assert.equal(anchorQuote('a reasonably long quote that should not match', '').ok, false)
  assert.match(anchorQuote('a reasonably long quote that should not match', '').reason, /never successfully fetched|empty/i)
})

test('fuzzy tier can be disabled for strict mode', () => {
  const nearly = 'Researchers reported that the treatment reduced hospitalization rates by 18 pct'
  const lenient = anchorQuote(nearly, DOC, { allowFuzzy: true })
  const strict = anchorQuote(nearly, DOC, { allowFuzzy: false })
  assert.equal(strict.ok, false, 'strict mode must not accept approximate quotes')
  // Lenient may or may not accept depending on overlap, but must never claim EXACT.
  assert.notEqual(lenient.kind, 'EXACT')
})

test('normalizeWithIndex keeps a valid offset map', () => {
  const { normalized, indexMap } = normalizeWithIndex('Hello,   World!')
  assert.equal(normalized, 'hello world')
  assert.equal(normalized.length, indexMap.length)
  assert.equal('Hello,   World!'[indexMap[0]], 'H')
})

test('contentHash is stable and change-sensitive', () => {
  assert.equal(contentHash('abc'), contentHash('abc'))
  assert.notEqual(contentHash('abc'), contentHash('abd'))
})

test('admitCitations separates real citations from phantoms', () => {
  const docs = [{ id: 'd1', text: DOC }]
  const candidates = [
    { claimId: 'c1', docId: 'd1', quote: 'reduced hospitalization rates by 18 percent' },
    { claimId: 'c2', docId: 'd1', quote: 'the authors cautioned that the sample skewed younger' },
    { claimId: 'c3', docId: 'd1', quote: 'the treatment was proven to be completely without side effects' },
    { claimId: 'c4', docId: 'missing-doc', quote: 'anything at all that is long enough to try' },
  ]
  const report = admitCitations(candidates, docs)

  assert.equal(report.admitted.length, 2)
  assert.equal(report.rejected.length, 2)
  assert.deepEqual(report.admitted.map((a) => a.claimId).sort(), ['c1', 'c2'])
  assert.ok(report.rejected.some((r) => r.claimId === 'c3'))
  assert.ok(report.rejected.some((r) => r.claimId === 'c4' && /not in the evidence store/i.test(r.anchor.reason)))
  assert.ok(Math.abs(report.phantomRate - 0.5) < 1e-9)
})

test('tampered document text fails the integrity check', () => {
  const original = DOC
  const docs = [{ id: 'd1', text: original + ' TAMPERED', sha256: contentHash(original) }]
  const report = admitCitations(
    [{ claimId: 'c1', docId: 'd1', quote: 'reduced hospitalization rates by 18 percent' }],
    docs,
  )
  assert.equal(report.admitted.length, 0)
  assert.match(report.rejected[0].anchor.reason, /integrity/i)
})

test('every rejection carries an explanatory reason', () => {
  const docs = [{ id: 'd1', text: DOC }]
  const report = admitCitations(
    [{ claimId: 'x', docId: 'd1', quote: 'entirely invented passage that is definitely not present here' }],
    docs,
  )
  for (const r of report.rejected) {
    assert.ok(r.anchor.reason && r.anchor.reason.length > 10, 'reason must be human-readable')
  }
})

test('Verdict enum is frozen and complete', () => {
  assert.ok(Object.isFrozen(Verdict))
  assert.deepEqual(
    Object.keys(Verdict).sort(),
    ['CONTRADICTED', 'NEUTRAL', 'PARTIAL', 'SUPPORTED', 'UNVERIFIED'],
  )
})
