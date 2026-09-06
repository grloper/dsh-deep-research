/**
 * @file Regression tests for citation/stance integrity in the verify pipeline.
 *
 * Found during the production audit: a document the judge graded NEUTRAL was
 * still pushed into the claim's citation list. The rendered report therefore
 * showed a source underneath a claim that source did not support — the exact
 * "citation ≠ support" failure this engine exists to eliminate, reproduced
 * inside the engine itself.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderReport, verifyText, Verdict } from '../lib/verify.js'

const CLAIM = 'The agency reported that inspections resumed in March 2024.'

/** @param {string} verdict @param {string} quote */
const judgeReturning = (verdict, quote) => async () => ({ verdict, quote, score: 0.9 })

test('a NEUTRAL document never becomes a citation', async () => {
  const report = await verifyText('x', {
    atomize: async () => [{ id: 'c1', text: CLAIM }],
    gather: async () => [
      {
        id: 'd1',
        url: 'https://unrelated.example.com',
        text: 'Completely unrelated commentary about weather patterns in northern regions.',
      },
    ],
    judge: judgeReturning(Verdict.NEUTRAL, 'Completely unrelated commentary about weather patterns'),
  })

  const claim = report.claims[0]
  assert.equal(claim.citations.length, 0, 'a non-probative source must not be cited')
  assert.equal(claim.sourceCount, 0)
  assert.equal(claim.verdict, Verdict.UNVERIFIED)
  assert.ok(
    claim.notes.some((n) => /does not address the claim/.test(n)),
    'the reader must be told why the source was set aside',
  )
})

test('a CONTRADICTING document is cited and tagged with its stance', async () => {
  const text = 'The agency confirmed that inspections did not resume in March 2024 as scheduled.'
  const report = await verifyText('x', {
    atomize: async () => [{ id: 'c1', text: CLAIM }],
    gather: async () => [{ id: 'd1', url: 'https://primary.example.gov', text }],
    judge: judgeReturning(Verdict.CONTRADICTED, 'inspections did not resume in March 2024 as scheduled'),
  })

  const claim = report.claims[0]
  assert.equal(claim.verdict, Verdict.CONTRADICTED)
  assert.equal(claim.citations.length, 1)
  assert.equal(claim.citations[0].stance, Verdict.CONTRADICTED)

  // The rendered output must not present a refuting source like a supporting one.
  const md = renderReport(report)
  assert.match(md, /CONTRADICTED\]/, 'stance must be visible in the rendered citation line')
})

test('a SUPPORTED citation renders without a stance suffix', async () => {
  const text = 'The agency reported that inspections resumed in March 2024 across all facilities.'
  const report = await verifyText('x', {
    atomize: async () => [{ id: 'c1', text: CLAIM }],
    gather: async () => [{ id: 'd1', url: 'https://primary.example.gov', text }],
    judge: judgeReturning(Verdict.SUPPORTED, 'inspections resumed in March 2024 across all facilities'),
  })

  const claim = report.claims[0]
  assert.equal(claim.verdict, Verdict.SUPPORTED)
  assert.equal(claim.citations[0].stance, Verdict.SUPPORTED)
  assert.doesNotMatch(renderReport(report), /— SUPPORTED\]/)
})

test('a fabricated quote is rejected even when the judge claims SUPPORTED', async () => {
  const report = await verifyText('x', {
    atomize: async () => [{ id: 'c1', text: CLAIM }],
    gather: async () => [
      { id: 'd1', url: 'https://primary.example.gov', text: 'The agency published its annual maintenance schedule.' },
    ],
    // A dishonest judge asserting support with a quote that is not in the source.
    judge: judgeReturning(Verdict.SUPPORTED, 'inspections resumed in March 2024 across all facilities'),
  })

  const claim = report.claims[0]
  assert.equal(claim.citations.length, 0, 'an unanchorable quote must never be cited')
  assert.equal(claim.verdict, Verdict.UNVERIFIED, 'unsupported claims must not inherit the judge verdict')
  assert.ok(report.phantomCitationRate > 0, 'the fabrication must be counted')
  assert.ok(claim.notes.some((n) => /Rejected citation/.test(n)))
})
