/**
 * @file Tests for credibility signals, slop detection and primary-source ID.
 *
 * A large share of these tests are FALSE-POSITIVE GUARDS. Wrongly flagging a
 * legitimate publisher is the worst thing this project can do, so the guards are
 * treated as first-class requirements rather than edge cases.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assessCredibility,
  assessPrimary,
  assessSlop,
  hostOf,
} from '../lib/credibility.js'

const longWords = (n, seed = 'analysis of the measured outcome across cohorts') =>
  Array.from({ length: n }, (_, i) => `${seed.split(' ')[i % 7]}${i % 13}`).join(' ')

test('hostOf normalizes and strips www', () => {
  assert.equal(hostOf('https://www.Example.com/x'), 'example.com')
  assert.equal(hostOf('not a url'), '')
})

test('detects DOI as a primary identifier', () => {
  const r = assessPrimary({ url: 'https://example.org/paper', text: 'See doi:10.1038/s41586-024-07421-0 for details.' })
  assert.ok(r.identifiers.includes('doi'))
  assert.equal(r.isPrimary, true)
})

test('detects SEC EDGAR and government hosts as primary/official', () => {
  assert.equal(assessPrimary({ url: 'https://www.sec.gov/Archives/edgar/data/320193/x.htm' }).isPrimary, true)
  assert.equal(assessPrimary({ url: 'https://www.gov.uk/guidance/thing' }).kind, 'official')
})

test('detects RFC and arXiv', () => {
  assert.equal(assessPrimary({ url: 'https://www.rfc-editor.org/rfc/rfc7089' }).isPrimary, true)
  assert.equal(assessPrimary({ url: 'https://arxiv.org/abs/2403.18802' }).kind, 'primary')
})

test('press wires are marked aggregator, never independent origins', () => {
  const r = assessPrimary({ url: 'https://www.prnewswire.com/news-releases/thing.html', text: 'Company announced today.' })
  assert.equal(r.kind, 'aggregator')
  assert.equal(r.isPrimary, false)
  assert.match(r.reasons.join(' '), /not an independent origin/i)
})

test('high attribution density marks a document as secondary news', () => {
  const text =
    'According to officials, the plan changed. As reported by another outlet, costs rose. ' +
    'Sources said the timeline slipped. A spokesperson confirmed the delay. ' + longWords(60)
  const r = assessPrimary({ url: 'https://someoutlet.example/story', text })
  assert.equal(r.kind, 'news')
  assert.equal(r.isPrimary, false)
})

// ---------------------------------------------------------------------------
// FALSE-POSITIVE GUARDS
// ---------------------------------------------------------------------------

test('GUARD: primary sources are exempt from slop scoring', () => {
  const roboticText =
    'In conclusion, the protocol defines the format. In conclusion, it is important to note the field order. ' +
    'Delves into the encoding. A testament to interoperability. ' + longWords(200)
  const primary = assessPrimary({ url: 'https://www.rfc-editor.org/rfc/rfc9110' })
  const slop = assessSlop({ text: roboticText }, primary)
  assert.equal(slop.exempt, true, 'RFCs must never be slop-scored')
  assert.equal(slop.score, 0)
})

test('GUARD: uniform technical prose alone does not reach a high slop score', () => {
  // Deliberately uniform sentences, but with author + date + references present.
  const uniform = Array.from(
    { length: 14 },
    (_, i) => `The parameter number ${i} controls the buffer size in bytes exactly.`,
  ).join(' ')
  const r = assessSlop({
    text: uniform,
    author: 'A. Engineer',
    publishedAt: Date.UTC(2024, 1, 1),
    outboundUrls: ['https://example.org/spec'],
  })
  assert.ok(r.score < 30, `uniform technical prose scored ${r.score}, expected < 30`)
})

test('GUARD: ESL-style transitions alone do not condemn a document', () => {
  const esl =
    'In conclusion, the results are clear. Furthermore, it is important to note the limitations. ' +
    'It is worth noting that further study is needed. ' + longWords(300)
  const r = assessSlop({
    text: esl,
    author: 'Dr. Researcher',
    publishedAt: Date.UTC(2024, 5, 1),
    outboundUrls: ['https://doi.org/10.1000/x', 'https://example.edu/study'],
  })
  assert.ok(r.score < 30, `ESL prose scored ${r.score}; must not be condemned on phrasing alone`)
})

test('GUARD: short documents are not assessed', () => {
  const r = assessSlop({ text: 'Too short to judge fairly.' })
  assert.equal(r.exempt, true)
  assert.equal(r.score, 0)
})

test('GUARD: credibility never hard-blocks — it always returns a usable report', () => {
  const r = assessCredibility({ url: 'https://unknown-site.example/x', text: longWords(300) })
  assert.equal(typeof r.score, 'number')
  assert.ok(r.score >= 0 && r.score <= 100)
  assert.ok(Array.isArray(r.signals) && r.signals.length > 0)
})

test('GUARD: every signal carries a human-readable reason', () => {
  const r = assessCredibility({
    url: 'https://affiliateblog.example/best-things',
    text: 'In conclusion, unlock the potential. ' + longWords(400),
    outboundUrls: ['https://shop.example/p?tag=aff-1', 'https://shop.example/q?tag=aff-2'],
  })
  for (const s of [...r.signals, ...r.slop.signals]) {
    assert.ok(s.reason && s.reason.length > 10, `signal ${s.id} lacks an explanation`)
    assert.ok(s.label && s.label.length > 0)
  }
})

test('GUARD: unranked niche domains are not penalized for absence from Tranco', () => {
  const doc = {
    url: 'https://niche-expert-blog.example/deep-dive',
    text: longWords(400),
    author: 'Expert Person',
    publishedAt: Date.UTC(2024, 3, 3),
    outboundUrls: ['https://example.org/ref'],
  }
  const withRank = assessCredibility(doc, { trancoRank: { 'niche-expert-blog.example': 50_000 } })
  const withoutRank = assessCredibility(doc, {})
  assert.ok(
    withoutRank.score >= withRank.score - 10,
    'absence from Tranco must not be a large penalty',
  )
  assert.ok(!withoutRank.signals.some((s) => s.id === 'tranco' && s.weight < 0))
})

// ---------------------------------------------------------------------------
// TRUE POSITIVES
// ---------------------------------------------------------------------------

test('affiliate-heavy anonymous listicle scores as low quality', () => {
  const r = assessSlop({
    text:
      'In today\u2019s fast-paced world, unlock the potential of these picks. ' +
      'In conclusion, this is a testament to quality. Delves into the details. ' + longWords(400),
    outboundUrls: [
      'https://shop.example/a?tag=aff-1',
      'https://shop.example/b?tag=aff-2',
      'https://shop.example/c?tag=aff-3',
      'https://other.example/plain',
    ],
  })
  assert.ok(r.score >= 30, `expected elevated slop score, got ${r.score}`)
  assert.ok(r.signals.some((s) => s.id === 'affiliate-heavy'))
  assert.ok(r.signals.some((s) => s.id === 'no-author'))
})

test('retracted work is heavily penalized and warned about', () => {
  const r = assessCredibility(
    { url: 'https://doi.org/10.1000/bad', text: longWords(300) },
    { retracted: true },
  )
  assert.ok(r.warnings.some((w) => /RETRACTED/i.test(w)))
  assert.ok(r.signals.some((s) => s.id === 'retracted' && s.weight < 0))
  assert.ok(r.score < 50, `retracted source scored ${r.score}, expected < 50`)
})

test('low-credibility list membership is applied and explained', () => {
  const r = assessCredibility(
    { url: 'https://fakenews.example/story', text: longWords(300) },
    { lowCredibilityHosts: ['fakenews.example'] },
  )
  assert.ok(r.signals.some((s) => s.id === 'low-credibility-list'))
  assert.match(r.signals.find((s) => s.id === 'low-credibility-list').reason, /Iffy/i)
  assert.ok(r.warnings.length > 0)
})

test('peer-reviewed source outscores an anonymous affiliate blog', () => {
  const paper = assessCredibility({
    url: 'https://www.nature.com/articles/s41586-024-07421-0',
    text: 'We report that ... doi:10.1038/s41586-024-07421-0 ' + longWords(400),
    author: 'Farquhar et al.',
    publishedAt: Date.UTC(2024, 5, 19),
  })
  const blog = assessCredibility({
    url: 'https://spam.example/top-10',
    text: 'In conclusion, unlock the potential. A testament to value. Delves into it. ' + longWords(400),
    outboundUrls: ['https://s.example/x?tag=a1', 'https://s.example/y?tag=a2'],
  })
  assert.ok(paper.score > blog.score + 20, `paper ${paper.score} vs blog ${blog.score}`)
  assert.equal(paper.isPrimary, true)
})

test('credibility summary is informative', () => {
  const r = assessCredibility({ url: 'https://arxiv.org/abs/2403.18802', text: longWords(300) })
  assert.match(r.summary, /credibility \d+\/100/)
})

test('wire host produces an independence warning', () => {
  const r = assessCredibility({ url: 'https://www.businesswire.com/news/x', text: longWords(300) })
  assert.ok(r.warnings.some((w) => /independent corroboration/i.test(w)))
})
