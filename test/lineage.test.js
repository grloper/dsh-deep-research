/**
 * @file Tests for the independence / copy-lineage engine (mechanism M2).
 *
 * These tests encode the project's central claim: that a pile of sources which
 * *looks* like strong corroboration can be mechanically collapsed to the small
 * number of origins that actually exist.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  analyzeLineage,
  exactJaccard,
  longestSharedQuote,
  minhashSignature,
  normalizeUrl,
  originTime,
  shingles,
  signatureJaccard,
  stronglyConnectedComponents,
} from '../lib/lineage.js'

const DAY = 86_400_000
const T0 = Date.UTC(2024, 10, 3, 8, 0, 0)

test('shingles produce word k-grams and dedupe', () => {
  const s = shingles('the quick brown fox jumps', 3)
  assert.deepEqual(s, ['the quick brown', 'quick brown fox', 'brown fox jumps'])
  assert.deepEqual(shingles('a b a b a b', 2), ['a b', 'b a'])
})

test('shingles tolerate short and empty input', () => {
  assert.deepEqual(shingles('', 3), [])
  assert.deepEqual(shingles('hello world', 5), ['hello world'])
})

test('minhash signature approximates exact jaccard', () => {
  const a = shingles('the company announced record quarterly revenue of forty two million dollars today', 3)
  const b = shingles('the company announced record quarterly revenue of forty two million dollars yesterday', 3)
  const exact = exactJaccard(a, b)
  const est = signatureJaccard(minhashSignature(a, 256), minhashSignature(b, 256))
  assert.ok(Math.abs(exact - est) < 0.15, `estimate ${est} too far from exact ${exact}`)
})

test('identical documents have jaccard 1', () => {
  const s = shingles('identical text content here for testing purposes', 3)
  assert.equal(exactJaccard(s, s), 1)
})

test('longestSharedQuote finds lifted passages', () => {
  const a = 'Intro words. The chief executive said the merger will close in the third quarter of next year. Outro.'
  const b = 'Different opening entirely. The chief executive said the merger will close in the third quarter of next year. Other analysis.'
  const q = longestSharedQuote(a, b)
  assert.ok(q, 'expected a shared quote')
  assert.ok(q.includes('merger will close in the third quarter'), `unexpected quote: ${q}`)
  assert.ok(q.length >= 50)
})

test('longestSharedQuote returns null for unrelated text', () => {
  const q = longestSharedQuote('apples oranges bananas', 'quantum chromodynamics lattice')
  assert.equal(q, null)
})

test('originTime prefers the earliest defensible timestamp', () => {
  assert.equal(originTime({ id: 'a', text: '', publishedAt: 500, waybackFirstSeen: 200 }), 200)
  assert.equal(originTime({ id: 'b', text: '', publishedAt: 500 }), 500)
  assert.equal(originTime({ id: 'c', text: '' }), Number.POSITIVE_INFINITY)
})

test('stronglyConnectedComponents detects a citation cycle', () => {
  const adj = new Map([
    ['a', ['b']],
    ['b', ['c']],
    ['c', ['a']],
    ['d', []],
  ])
  const comps = stronglyConnectedComponents(['a', 'b', 'c', 'd'], adj)
  assert.equal(comps.length, 1)
  assert.deepEqual([...comps[0]].sort(), ['a', 'b', 'c'])
})

test('normalizeUrl strips tracking, www, protocol and trailing slash', () => {
  assert.equal(
    normalizeUrl('https://www.Example.com/path/?utm_source=x&id=7#frag'),
    'example.com/path?id=7',
  )
  assert.equal(normalizeUrl('http://example.com/path'), normalizeUrl('https://www.example.com/path/'))
})

test('independent documents all count as roots', () => {
  const docs = [
    { id: 'a', text: 'Solar panel efficiency improved through perovskite tandem cell research this year.', publishedAt: T0 },
    { id: 'b', text: 'Wheat harvest yields declined across the northern plains due to unusual drought.', publishedAt: T0 + DAY },
    { id: 'c', text: 'A new deep sea vent ecosystem was catalogued near the mid atlantic ridge.', publishedAt: T0 + 2 * DAY },
  ]
  const r = analyzeLineage(docs)
  assert.equal(r.total, 3)
  assert.equal(r.ics, 3)
  assert.match(r.summary, /all independent/)
})

test('CORE CLAIM: verbatim syndication collapses to a single independent origin', () => {
  const wire =
    'Acme Corporation today announced that its board has approved a definitive agreement ' +
    'to acquire Beta Industries for one point two billion dollars in an all cash transaction ' +
    'expected to close in the third quarter subject to customary regulatory approvals.'

  // One press release, then five outlets republishing it nearly verbatim.
  const docs = [
    { id: 'pr', url: 'https://acme.com/press/merger', text: wire, publishedAt: T0 },
    { id: 'n1', url: 'https://news1.com/a', text: `Breaking. ${wire}`, publishedAt: T0 + 3600_000 },
    { id: 'n2', url: 'https://news2.com/b', text: `${wire} Shares rose.`, publishedAt: T0 + 7200_000 },
    { id: 'n3', url: 'https://news3.com/c', text: `Markets today. ${wire}`, publishedAt: T0 + 10800_000 },
    { id: 'n4', url: 'https://news4.com/d', text: `${wire} Analysts reacted.`, publishedAt: T0 + 14400_000 },
    { id: 'n5', url: 'https://news5.com/e', text: `Report. ${wire}`, publishedAt: T0 + 18000_000 },
  ]

  const r = analyzeLineage(docs)

  assert.equal(r.total, 6, 'six documents were supplied')
  assert.equal(r.ics, 1, `expected 1 independent origin, got ${r.ics}: ${r.summary}`)
  assert.deepEqual(r.roots, ['pr'], 'the press release must be identified as the origin')
  for (const id of ['n1', 'n2', 'n3', 'n4', 'n5']) {
    assert.equal(r.originOf.get(id), 'pr', `${id} should trace back to the press release`)
  }
  assert.ok(r.edges.some((e) => e.kind === 'syndication'), 'expected syndication edges')
})

test('genuinely independent reporting is NOT collapsed', () => {
  const docs = [
    {
      id: 'x',
      text: 'Our correspondent visited the facility and observed three idle production lines, ' +
        'with workers describing a sudden halt in component deliveries from overseas suppliers.',
      publishedAt: T0,
    },
    {
      id: 'y',
      text: 'Regulatory filings reviewed by this publication show the company wrote down ' +
        'inventory by eighty million dollars and disclosed a material weakness in controls.',
      publishedAt: T0 + DAY,
    },
  ]
  const r = analyzeLineage(docs)
  assert.equal(r.ics, 2, 'distinct reporting must remain two independent origins')
})

test('circular reporting between two outlets is detected and collapsed', () => {
  const shared =
    'an unnamed official familiar with the matter stated that the program will be ' +
    'discontinued before the end of the fiscal year according to people briefed on the plan'
  const docs = [
    {
      id: 'p',
      url: 'https://p.com/story',
      text: `Outlet P reports. ${shared}`,
      outboundUrls: ['https://q.com/story'],
      publishedAt: T0,
    },
    {
      id: 'q',
      url: 'https://q.com/story',
      text: `Outlet Q reports. ${shared}`,
      outboundUrls: ['https://p.com/story'],
      publishedAt: T0,
    },
  ]
  const r = analyzeLineage(docs)
  assert.equal(r.circular.length, 1, 'expected one circular-citation component')
  assert.equal(r.ics, 1, 'a citation loop must collapse to one pseudo-origin')
  assert.match(r.summary, /circular-citation loop/)
})

test('undated documents never steal rootship from dated ones', () => {
  const body = 'the agency confirmed that inspections will resume next month across all facilities nationwide'
  const docs = [
    { id: 'dated', text: body, publishedAt: T0 },
    { id: 'undated', text: `${body} Additional commentary follows here.` },
  ]
  const r = analyzeLineage(docs)
  assert.equal(r.originOf.get('undated'), 'dated')
  assert.equal(r.ics, 1)
})

test('empty input is handled without throwing', () => {
  const r = analyzeLineage([])
  assert.equal(r.ics, 0)
  assert.equal(r.total, 0)
  assert.equal(r.edges.length, 0)
})

test('analysis is deterministic across runs', () => {
  const docs = [
    { id: 'a', text: 'repeated content for determinism verification across runs', publishedAt: T0 },
    { id: 'b', text: 'repeated content for determinism verification across runs plus tail', publishedAt: T0 + 1000 },
    { id: 'c', text: 'completely unrelated subject matter about marine biology', publishedAt: T0 + 2000 },
  ]
  const first = analyzeLineage(docs)
  const second = analyzeLineage(docs)
  assert.deepEqual(first.roots, second.roots)
  assert.equal(first.ics, second.ics)
  assert.equal(first.summary, second.summary)
})
