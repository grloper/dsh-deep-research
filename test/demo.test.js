/**
 * @file Guards the README's headline numbers.
 *
 * The demo is the project's public proof, and a README that quotes figures the
 * code no longer produces is exactly the kind of unverified claim this engine
 * rejects elsewhere. These tests re-derive the demo's assertions from the real
 * pipeline so the documented numbers cannot drift away from the implementation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { anchorQuote } from '../lib/anchor.js'
import { analyzeLineage } from '../lib/lineage.js'

const ORIGIN_TEXT =
  'Northwind Robotics announced today that its Q3 revenue reached 42 million dollars, ' +
  'an increase of 18 percent year over year. Chief executive Dana Reyes said the growth ' +
  'was driven primarily by demand for warehouse automation systems in the European market.'

test('the demo\'s genuine quote anchors exactly and the fabricated one is rejected', () => {
  const genuine = anchorQuote('its Q3 revenue reached 42 million dollars', ORIGIN_TEXT, { minChars: 20 })
  assert.equal(genuine.ok, true)
  assert.equal(genuine.kind, 'EXACT')

  // Differs from the source by a single number — the hardest case for a
  // similarity-based check, and the one that matters most.
  const fabricated = anchorQuote('its Q3 revenue reached 91 million dollars', ORIGIN_TEXT, { minChars: 20 })
  assert.equal(fabricated.ok, false, 'a one-token numeric fabrication must not pass')
  assert.equal(fabricated.kind, 'FAILED')
})

test('the demo corpus collapses 13 sources to 3 independent origins', () => {
  const syndicated = Array.from({ length: 6 }, (_, i) => ({
    id: `syn${i + 1}`,
    url: `https://news-outlet-${i + 1}.example.com/northwind-q3`,
    text: ORIGIN_TEXT,
    publishedAt: Date.parse('2026-01-15T12:00:00Z') + i * 3600_000,
  }))
  const rewrites = Array.from({ length: 4 }, (_, i) => ({
    id: `rew${i + 1}`,
    url: `https://aggregator-${i + 1}.example.com/northwind`,
    text:
      'Warehouse automation demand in Europe drove growth at Northwind Robotics, ' +
      'which reported Q3 revenue of 42 million dollars, up 18 percent year over year. ' +
      'Chief executive Dana Reyes attributed the increase to European automation systems demand.',
    publishedAt: Date.parse('2026-01-16T09:00:00Z') + i * 3600_000,
  }))
  const corpus = [
    { id: 'origin', url: 'https://newswire.example.com/northwind-q3-release', text: ORIGIN_TEXT, publishedAt: Date.parse('2026-01-15T09:00:00Z') },
    ...syndicated,
    ...rewrites,
    {
      id: 'audit1',
      url: 'https://sec.example.gov/filings/northwind-10q',
      text:
        'In its quarterly filing, Northwind Robotics reported total revenue of 42 million dollars ' +
        'for the three months ended September 30. The filing notes that 6 million dollars of that ' +
        'figure was attributable to a one-time licensing settlement rather than recurring product sales.',
      publishedAt: Date.parse('2026-01-20T09:00:00Z'),
    },
    {
      id: 'corr1',
      url: 'https://trade-journal.example.org/northwind-correction',
      text:
        'Correction: Northwind Robotics did not grow 18 percent year over year. ' +
        'After restating prior-period figures, the company disclosed that year-over-year growth ' +
        'was 11 percent, and the originally reported 18 percent figure was retracted.',
      publishedAt: Date.parse('2026-01-22T09:00:00Z'),
    },
  ]

  const lineage = analyzeLineage(corpus)
  assert.equal(lineage.total, 13, 'README quotes 13 raw sources')
  assert.equal(lineage.ics, 3, 'README quotes 3 independent origins')
  assert.ok(lineage.ics < lineage.total, 'syndication must actually collapse')
})

test('the fuzzy anchor tier stays linear enough for large documents', () => {
  // Regression guard for the O(doc × quote) hot spot fixed in v0.2. A 40k-token
  // document previously took ~290ms for a single quote; the incremental window
  // brought that to ~45ms. The generous bound here catches a return to
  // quadratic behaviour without being flaky on a loaded CI machine.
  const word = (i) => `w${i % 977}x`
  const doc = Array.from({ length: 40_000 }, (_, i) => word(i)).join(' ')
  const quote = Array.from({ length: 40 }, (_, i) => `zz${i}qq`).join(' ')

  const started = performance.now()
  const result = anchorQuote(quote, doc)
  const elapsed = performance.now() - started

  assert.equal(result.ok, false, 'random text must not anchor')
  assert.ok(elapsed < 1500, `fuzzy anchoring took ${elapsed.toFixed(0)}ms, expected well under 1500ms`)
})
