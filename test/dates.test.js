/**
 * @file Tests for adversarial date resolution.
 *
 * Dates decide lineage direction, so these tests focus on the manipulation
 * cases: forged publish dates, SSR render timestamps masquerading as
 * Last-Modified, and permalink migration faking freshness.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dateFromUrl, extractJsonLd, metaContent, parseDate, resolveDate } from '../lib/dates.js'

const NOW = Date.UTC(2025, 0, 15, 12, 0, 0)
const DAY = 86_400_000

test('parseDate rejects pre-web and future timestamps', () => {
  assert.equal(parseDate('1975-01-01', NOW), null, 'pre-web date must be rejected')
  assert.equal(parseDate('2030-01-01', NOW), null, 'future date must be rejected')
  assert.equal(parseDate('not a date', NOW), null)
  assert.equal(parseDate(null, NOW), null)
  assert.ok(typeof parseDate('2024-03-12T10:00:00Z', NOW) === 'number')
})

test('parseDate tolerates a day of clock skew', () => {
  assert.ok(parseDate(new Date(NOW + 3600_000).toISOString(), NOW) !== null)
  assert.equal(parseDate(new Date(NOW + 5 * DAY).toISOString(), NOW), null)
})

test('extractJsonLd handles arrays and @graph', () => {
  const html = `
    <script type="application/ld+json">{"@type":"Article","datePublished":"2024-03-12"}</script>
    <script type="application/ld+json">{"@graph":[{"@type":"WebPage","dateModified":"2024-04-01"}]}</script>`
  const nodes = extractJsonLd(html)
  assert.ok(nodes.some((n) => n.datePublished === '2024-03-12'))
  assert.ok(nodes.some((n) => n.dateModified === '2024-04-01'))
})

test('extractJsonLd survives malformed blocks', () => {
  const html = `<script type="application/ld+json">{ this is broken </script>`
  assert.deepEqual(extractJsonLd(html), [])
})

test('metaContent reads both attribute orderings', () => {
  assert.equal(
    metaContent('<meta property="article:published_time" content="2024-03-12">', 'article:published_time'),
    '2024-03-12',
  )
  assert.equal(
    metaContent('<meta content="2024-03-12" name="article:published_time">', 'article:published_time'),
    '2024-03-12',
  )
})

test('dateFromUrl extracts permalink dates and rejects invalid months', () => {
  assert.equal(dateFromUrl('https://x.example/2024/03/12/story', NOW), Date.UTC(2024, 2, 12))
  assert.equal(dateFromUrl('https://x.example/2024/13/01/story', NOW), null)
  assert.equal(dateFromUrl('https://x.example/no-date-here', NOW), null)
})

test('JSON-LD yields a HIGH confidence publish date', () => {
  const r = resolveDate({
    html: '<script type="application/ld+json">{"datePublished":"2024-03-12T09:00:00Z"}</script>',
    now: NOW,
  })
  assert.equal(r.publishedAt, Date.UTC(2024, 2, 12, 9))
  assert.equal(r.confidence, 'HIGH')
})

test('falls back through meta and Dublin Core', () => {
  const meta = resolveDate({ html: '<meta property="article:published_time" content="2024-05-01">', now: NOW })
  assert.equal(meta.publishedAt, Date.UTC(2024, 4, 1))

  const dc = resolveDate({ html: '<meta name="DC.date.issued" content="2024-06-02">', now: NOW })
  assert.equal(dc.publishedAt, Date.UTC(2024, 5, 2))
})

test('ATTACK: SSR render timestamp is not mistaken for a publication date', () => {
  const stamp = new Date(NOW - 1000).toUTCString()
  const r = resolveDate({ httpLastModified: stamp, httpDate: stamp, now: NOW })
  assert.ok(
    r.warnings.some((w) => /render timestamp/i.test(w)),
    'must warn that Last-Modified is just the render time',
  )
  assert.equal(r.modifiedAt, null, 'render time must not become a modified date')
})

test('legitimate Last-Modified distinct from Date is retained', () => {
  const r = resolveDate({
    httpLastModified: new Date(Date.UTC(2024, 1, 1)).toUTCString(),
    httpDate: new Date(NOW).toUTCString(),
    now: NOW,
  })
  assert.equal(r.modifiedAt, Date.UTC(2024, 1, 1))
})

test('ATTACK: rewritten publish date is caught by the archive lower bound', () => {
  const r = resolveDate({
    html: '<script type="application/ld+json">{"datePublished":"2025-01-10T00:00:00Z"}</script>',
    waybackFirstSeen: Date.UTC(2023, 5, 1),
    now: NOW,
  })
  assert.equal(r.confidence, 'SUSPECT')
  assert.ok(r.warnings.some((w) => /rewritten/i.test(w)))
  assert.equal(r.effective, Date.UTC(2023, 5, 1), 'effective time must use the archive evidence')
})

test('inconsistent modified-before-published metadata is flagged', () => {
  const r = resolveDate({
    html:
      '<script type="application/ld+json">' +
      '{"datePublished":"2024-06-01","dateModified":"2024-01-01"}</script>',
    now: NOW,
  })
  assert.equal(r.confidence, 'SUSPECT')
  assert.ok(r.warnings.some((w) => /inconsistent/i.test(w)))
})

test('URL/metadata disagreement is reported', () => {
  const r = resolveDate({
    html: '<script type="application/ld+json">{"datePublished":"2024-12-01"}</script>',
    url: 'https://x.example/2019/01/05/story',
    now: NOW,
  })
  assert.ok(r.warnings.some((w) => /disagree/i.test(w)))
})

test('effective time is the earliest defensible signal', () => {
  const r = resolveDate({
    html: '<script type="application/ld+json">{"datePublished":"2024-08-01"}</script>',
    url: 'https://x.example/2024/07/15/story',
    now: NOW,
  })
  assert.equal(r.effective, Date.UTC(2024, 6, 15), 'the earlier URL date should win')
})

test('no signals at all yields LOW confidence and nulls', () => {
  const r = resolveDate({ html: '<p>no dates anywhere</p>', now: NOW })
  assert.equal(r.publishedAt, null)
  assert.equal(r.effective, null)
  assert.equal(r.confidence, 'LOW')
})

test('every warning is human-readable', () => {
  const r = resolveDate({
    html: '<script type="application/ld+json">{"datePublished":"2025-01-10","dateModified":"2020-01-01"}</script>',
    waybackFirstSeen: Date.UTC(2019, 0, 1),
    now: NOW,
  })
  for (const w of r.warnings) assert.ok(w.length > 20, `warning too terse: ${w}`)
})

test('evidence list records which tier produced each value', () => {
  const r = resolveDate({
    html: '<script type="application/ld+json">{"datePublished":"2024-03-12"}</script>',
    url: 'https://x.example/2024/03/12/story',
    waybackFirstSeen: Date.UTC(2024, 2, 13),
    now: NOW,
  })
  const tiers = new Set(r.evidence.map((e) => e.tier))
  assert.ok(tiers.has('json-ld'))
  assert.ok(tiers.has('url'))
  assert.ok(tiers.has('wayback'))
})
