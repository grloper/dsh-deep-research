/**
 * @file End-to-end tests for the verify_text pipeline.
 *
 * All external capabilities are injected, so these run fully offline and assert
 * the behaviour that actually matters: a lying model cannot get a fabricated
 * citation past the pipeline, and syndicated agreement does not inflate
 * confidence.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  heuristicAtomize,
  isCheckworthy,
  renderReport,
  scoreConfidence,
  Verdict,
  verifyText,
} from '../lib/verify.js'

const T0 = Date.UTC(2024, 5, 1)
const HOUR = 3600_000

const REAL_DOC = {
  id: 'd1',
  url: 'https://journal.example/study',
  text:
    'In a randomized trial of 4,200 participants, the vaccine reduced symptomatic infection ' +
    'by 71 percent over the twelve month follow up period. Adverse events were rare and mild.',
  author: 'Dr. Real Researcher',
  publishedAt: T0,
}

test('isCheckworthy filters opinions, questions and fragments', () => {
  assert.equal(isCheckworthy('The vaccine reduced infection by 71 percent in the trial.'), true)
  assert.equal(isCheckworthy('What should we do about it?'), false)
  assert.equal(isCheckworthy('I think this is probably a good idea overall.'), false)
  assert.equal(isCheckworthy('Nice.'), false)
})

test('heuristicAtomize returns only check-worthy sentences', () => {
  const claims = heuristicAtomize(
    'The study enrolled 4,200 participants in 2023. I think that is impressive. Is it enough?',
  )
  assert.equal(claims.length, 1)
  assert.match(claims[0].text, /4,200 participants/)
})

test('scoreConfidence rewards independence with diminishing returns', () => {
  const one = scoreConfidence({ verdict: Verdict.SUPPORTED, ics: 1, meanCredibility: 70, contradicted: false })
  const two = scoreConfidence({ verdict: Verdict.SUPPORTED, ics: 2, meanCredibility: 70, contradicted: false })
  const six = scoreConfidence({ verdict: Verdict.SUPPORTED, ics: 6, meanCredibility: 70, contradicted: false })
  assert.ok(two > one, 'more independent origins must raise confidence')
  assert.ok(six - two < two - one, 'gains must diminish')
  assert.ok(six <= 1)
})

test('scoreConfidence caps hard on contradiction', () => {
  const c = scoreConfidence({ verdict: Verdict.SUPPORTED, ics: 8, meanCredibility: 95, contradicted: true })
  assert.ok(c <= 0.4, `contradicted claim scored ${c}, must be capped`)
})

test('empty input yields an empty, non-crashing report', async () => {
  const r = await verifyText('')
  assert.equal(r.claims.length, 0)
  assert.match(r.summary, /No check-worthy/i)
})

test('missing judge is reported as a warning rather than a crash', async () => {
  const r = await verifyText('The trial enrolled 4,200 participants in 2023.')
  assert.ok(r.warnings.some((w) => /entailment judge/i.test(w)))
})

test('CORE GUARANTEE: a fabricated quote never becomes a citation', async () => {
  const r = await verifyText('The vaccine reduced infection by 99 percent.', {
    atomize: async () => [{ id: 'c1', text: 'The vaccine reduced infection by 99 percent.' }],
    gather: async () => [REAL_DOC],
    // A lying judge: claims support, and invents a quote that is not in the document.
    judge: async () => ({
      verdict: Verdict.SUPPORTED,
      quote: 'the vaccine reduced symptomatic infection by 99 percent in all groups',
      score: 0.99,
    }),
  })

  const j = r.claims[0]
  assert.equal(j.citations.length, 0, 'no citation may be admitted for a fabricated quote')
  assert.equal(j.verdict, Verdict.UNVERIFIED, 'claim must fall back to UNVERIFIED')
  assert.ok(r.phantomCitationRate > 0, 'phantom citation must be counted')
  assert.ok(j.notes.some((n) => /Rejected citation/i.test(n)))
})

test('a truthful citation is admitted with exact offsets', async () => {
  const quote = 'the vaccine reduced symptomatic infection by 71 percent'
  const r = await verifyText('x', {
    atomize: async () => [{ id: 'c1', text: 'The vaccine reduced symptomatic infection by 71 percent.' }],
    gather: async () => [REAL_DOC],
    judge: async () => ({ verdict: Verdict.SUPPORTED, quote, score: 0.9 }),
  })
  const j = r.claims[0]
  assert.equal(j.verdict, Verdict.SUPPORTED)
  assert.equal(j.citations.length, 1)
  const c = j.citations[0]
  assert.equal(REAL_DOC.text.slice(c.charStart, c.charEnd), quote)
  assert.equal(r.phantomCitationRate, 0)
})

test('CORE GUARANTEE: syndicated agreement does not inflate independence', async () => {
  const wire =
    'The ministry confirmed that the new policy will take effect on the first of January ' +
    'and will apply to all registered operators without exception across the territory.'
  const docs = [
    { id: 'origin', url: 'https://gov.example/release', text: wire, publishedAt: T0 },
    { id: 'n1', url: 'https://n1.example/a', text: `Report: ${wire}`, publishedAt: T0 + HOUR },
    { id: 'n2', url: 'https://n2.example/b', text: `${wire} Analysts commented.`, publishedAt: T0 + 2 * HOUR },
    { id: 'n3', url: 'https://n3.example/c', text: `Breaking. ${wire}`, publishedAt: T0 + 3 * HOUR },
  ]

  const r = await verifyText('x', {
    atomize: async () => [{ id: 'c1', text: 'The policy takes effect on 1 January.' }],
    gather: async () => docs,
    judge: async (_claim, doc) => ({
      verdict: Verdict.SUPPORTED,
      quote: doc.text.includes('the new policy will take effect on the first of January')
        ? 'the new policy will take effect on the first of January'
        : '',
      score: 0.9,
    }),
  })

  const j = r.claims[0]
  assert.equal(j.sourceCount, 4, 'four documents supported the claim')
  assert.equal(j.ics, 1, `expected 1 independent origin, got ${j.ics}`)
  assert.ok(
    j.notes.some((n) => /independent origin/i.test(n)),
    'the collapse must be explained to the user',
  )

  const inflated = scoreConfidence({
    verdict: Verdict.SUPPORTED, ics: 4, meanCredibility: 60, contradicted: false,
  })
  assert.ok(j.confidence < inflated, 'confidence must reflect origins, not raw source count')
})

test('contradiction is surfaced and caps confidence', async () => {
  const against = {
    id: 'd2',
    url: 'https://other.example/rebuttal',
    text: 'A subsequent replication found no statistically significant reduction in infection rates.',
    publishedAt: T0 + 1000,
  }
  const r = await verifyText('x', {
    atomize: async () => [{ id: 'c1', text: 'The vaccine reduced infection.' }],
    gather: async () => [against],
    judge: async () => ({
      verdict: Verdict.CONTRADICTED,
      quote: 'found no statistically significant reduction in infection rates',
      score: 0.85,
    }),
  })
  const j = r.claims[0]
  assert.equal(j.verdict, Verdict.CONTRADICTED)
  assert.ok(j.confidence <= 0.4)
  assert.ok(j.notes.some((n) => /Contradicted by/i.test(n)))
})

test('a throwing judge degrades gracefully', async () => {
  const r = await verifyText('x', {
    atomize: async () => [{ id: 'c1', text: 'Some checkable claim about the world.' }],
    gather: async () => [REAL_DOC],
    judge: async () => {
      throw new Error('model timeout')
    },
  })
  assert.equal(r.claims[0].verdict, Verdict.UNVERIFIED)
  assert.ok(r.claims[0].notes.some((n) => /model timeout/i.test(n)))
})

test('claims with no evidence are UNVERIFIED, never SUPPORTED', async () => {
  const r = await verifyText('x', {
    atomize: async () => [{ id: 'c1', text: 'An obscure claim nobody has written about.' }],
    gather: async () => [],
    judge: async () => ({ verdict: Verdict.SUPPORTED, quote: 'anything', score: 1 }),
  })
  assert.equal(r.claims[0].verdict, Verdict.UNVERIFIED)
  assert.equal(r.claims[0].citations.length, 0)
})

test('renderReport produces readable markdown with quotes', async () => {
  const quote = 'the vaccine reduced symptomatic infection by 71 percent'
  const r = await verifyText('x', {
    atomize: async () => [{ id: 'c1', text: 'The vaccine reduced infection by 71 percent.' }],
    gather: async () => [REAL_DOC],
    judge: async () => ({ verdict: Verdict.SUPPORTED, quote, score: 0.9 }),
  })
  const md = renderReport(r)
  assert.match(md, /# Verification report/)
  assert.match(md, /SUPPORTED/)
  assert.ok(md.includes(quote))
  assert.match(md, /independent origin/)
})

test('totals are internally consistent', async () => {
  const r = await verifyText('x', {
    atomize: async () => [
      { id: 'c1', text: 'First checkable claim about the subject.' },
      { id: 'c2', text: 'Second checkable claim about the subject.' },
    ],
    gather: async () => [REAL_DOC],
    judge: async (claim) =>
      claim.id === 'c1'
        ? { verdict: Verdict.SUPPORTED, quote: 'Adverse events were rare and mild', score: 0.9 }
        : { verdict: Verdict.CONTRADICTED, quote: 'Adverse events were rare and mild', score: 0.8 },
  })
  assert.equal(r.totals.total, 2)
  assert.equal(r.totals.supported + r.totals.contradicted + r.totals.unverified <= 2, true)
})
