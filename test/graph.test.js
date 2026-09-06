/**
 * @file Tests for the evidence knowledge graph and recall.
 *
 * The property that matters: prior verified work must be reusable, stale work
 * must not be, and multi-hop connections must be findable when two concepts
 * share no vocabulary.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Bm25Index, extractEntities, KnowledgeGraph, rrf, tokenize } from '../lib/graph.js'
import { EvidenceStore } from '../lib/store.js'

const HOUR = 3600_000
const DAY = 24 * HOUR

test('tokenize drops stopwords and short tokens', () => {
  const t = tokenize('The quick brown fox is on a mat')
  assert.ok(!t.includes('the'))
  assert.ok(!t.includes('is'))
  assert.ok(t.includes('quick'))
  assert.ok(t.includes('brown'))
})

test('extractEntities finds names, acronyms, quantities and years', () => {
  const e = extractEntities('Acme Corporation reported that NASA spent 42 percent more in 2024.')
  const lower = e.map((x) => x.toLowerCase())
  assert.ok(lower.some((x) => x.includes('acme')), `missing org: ${JSON.stringify(e)}`)
  assert.ok(e.includes('NASA'))
  assert.ok(e.includes('2024'))
  assert.ok(e.some((x) => /42\s?percent/i.test(x)))
})

test('extractEntities skips sentence-initial single words', () => {
  const e = extractEntities('However the result held.')
  assert.ok(!e.includes('However'), 'grammar capitalization is not an entity')
})

test('extractEntities returns empty for entity-free text', () => {
  assert.deepEqual(extractEntities('the result held steady over time'), [])
})

test('BM25 ranks a matching document above a non-matching one', () => {
  const idx = new Bm25Index()
    .add('a', 'solar panel efficiency improved with perovskite tandem cells')
    .add('b', 'wheat harvest yields declined across the northern plains')
  const hits = idx.search('perovskite solar efficiency')
  assert.equal(hits[0].id, 'a')
  assert.ok(hits[0].score > 0)
})

test('BM25 returns nothing for an unmatched query', () => {
  const idx = new Bm25Index().add('a', 'solar panel efficiency research')
  assert.deepEqual(idx.search('quantum chromodynamics lattice'), [])
})

test('BM25 handles an empty index and empty query', () => {
  assert.deepEqual(new Bm25Index().search('anything'), [])
  assert.deepEqual(new Bm25Index().add('a', 'text here').search(''), [])
})

test('BM25 scores are non-negative even for very common terms', () => {
  const idx = new Bm25Index()
  for (let i = 0; i < 10; i++) idx.add(`d${i}`, 'common term appears everywhere in this corpus')
  for (const h of idx.search('common term')) assert.ok(h.score >= 0, `negative score ${h.score}`)
})

test('rrf fuses rankings without score normalization', () => {
  const fused = rrf([
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    [{ id: 'c' }, { id: 'a' }, { id: 'z' }],
  ])
  const ids = fused.map((f) => f.id)
  assert.ok(ids.includes('a') && ids.includes('c'))
  // 'a' ranks 1st and 2nd; 'z' only appears once at rank 3 — 'a' must win.
  assert.ok(ids.indexOf('a') < ids.indexOf('z'))
})

test('graph indexes claims and reports stats', () => {
  const g = new KnowledgeGraph()
  g.addClaim({ id: 'c1', text: 'Acme Corporation acquired Beta Industries in 2024.', verdict: 'SUPPORTED' }, false)
  const s = g.stats()
  assert.equal(s.claims, 1)
  assert.ok(s.entities > 0)
})

test('CORE: recall returns a fresh prior verification', () => {
  const g = new KnowledgeGraph()
  g.addClaim(
    {
      id: 'c1',
      text: 'Acme Corporation acquired Beta Industries in 2024.',
      verdict: 'SUPPORTED',
      confidence: 0.9,
      last_verified: Date.now(),
      volatility: 'slow',
    },
    false,
  )
  const hits = g.recall('Did Acme Corporation acquire Beta Industries?')
  assert.ok(hits.length > 0, 'prior work must be recalled')
  assert.equal(hits[0].verdict, 'SUPPORTED')
  assert.equal(hits[0].fresh, true)
})

test('CORE: stale claims are excluded from recall by default', () => {
  const g = new KnowledgeGraph()
  g.addClaim(
    {
      id: 'c1',
      text: 'The current stock price of Acme Corporation is 42 dollars.',
      verdict: 'SUPPORTED',
      confidence: 0.9,
      last_verified: Date.now() - 40 * HOUR,
      volatility: 'fast',
    },
    false,
  )
  assert.equal(g.recall('Acme Corporation stock price').length, 0, 'stale fast-volatility claim must not be reused')
  assert.ok(g.recall('Acme Corporation stock price', { freshOnly: false }).length > 0, 'but is retrievable on request')
})

test('immutable claims stay fresh for years', () => {
  const g = new KnowledgeGraph()
  g.addClaim(
    {
      id: 'c1',
      text: 'Leonhard Euler was born in 1707.',
      verdict: 'SUPPORTED',
      last_verified: Date.now() - 400 * DAY,
      volatility: 'immutable',
    },
    false,
  )
  assert.ok(g.recall('When was Leonhard Euler born').length > 0)
})

test('CORE: multi-hop connect links concepts sharing no vocabulary', () => {
  const g = new KnowledgeGraph()
  // Alpha ↔ Bridge, Bridge ↔ Omega. Alpha and Omega share nothing directly.
  g.addClaim({ id: 'c1', text: 'Alpha Systems supplies components to Bridge Motors.' }, false)
  g.addClaim({ id: 'c2', text: 'Bridge Motors operates a plant with Omega Holdings.' }, false)
  const path = g.connect('Alpha Systems', 'Omega Holdings', 3)
  assert.ok(path.length >= 2, `expected a multi-hop path, got ${JSON.stringify(path)}`)
  assert.ok(path.includes('c1') && path.includes('c2'))
})

test('connect returns empty when no path exists', () => {
  const g = new KnowledgeGraph()
  g.addClaim({ id: 'c1', text: 'Alpha Systems builds widgets.' }, false)
  g.addClaim({ id: 'c2', text: 'Unrelated Corporation sells produce.' }, false)
  assert.deepEqual(g.connect('Alpha Systems', 'Nonexistent Entity'), [])
})

test('connect finds a direct hit immediately', () => {
  const g = new KnowledgeGraph()
  g.addClaim({ id: 'c1', text: 'Alpha Systems partnered with Omega Holdings directly.' }, false)
  const path = g.connect('Alpha Systems', 'Omega Holdings')
  assert.deepEqual(path, ['c1'])
})

test('neighbors returns claims sharing an entity', () => {
  const g = new KnowledgeGraph()
  g.addClaim({ id: 'c1', text: 'Acme Corporation reported growth.' }, false)
  g.addClaim({ id: 'c2', text: 'Acme Corporation opened a facility.' }, false)
  g.addClaim({ id: 'c3', text: 'Unrelated Business closed down.' }, false)
  const n = g.neighbors('c1')
  assert.ok(n.includes('c2'))
  assert.ok(!n.includes('c3'))
})

test('graph persists through the store and reloads', () => {
  const store = new EvidenceStore(':memory:')
  const g = new KnowledgeGraph(store)
  g.addClaim({ id: 'c1', text: 'Acme Corporation acquired Beta Industries in 2024.', verdict: 'SUPPORTED', confidence: 0.9 })

  const g2 = new KnowledgeGraph(store)
  assert.equal(g2.stats().claims, 1, 'claims must survive a reload from the store')
  assert.ok(g2.recall('Acme Corporation Beta Industries').length > 0)
  store.close()
})

test('Obsidian export produces claim notes, entity notes and an index', () => {
  const g = new KnowledgeGraph()
  g.addClaim(
    { id: 'c1', text: 'Acme Corporation acquired Beta Industries in 2024.', verdict: 'SUPPORTED', confidence: 0.88, ics: 3 },
    false,
  )
  const files = g.toObsidian()
  const paths = files.map((f) => f.path)
  assert.ok(paths.includes('INDEX.md'))
  assert.ok(paths.some((p) => p.startsWith('claims/')))
  assert.ok(paths.some((p) => p.startsWith('entities/')))

  const claimNote = files.find((f) => f.path.startsWith('claims/'))
  assert.match(claimNote.content, /verdict: SUPPORTED/)
  assert.match(claimNote.content, /independent_origins: 3/)
  assert.match(claimNote.content, /\[\[/, 'must contain wiki-links')
})

test('Obsidian export sanitizes unsafe filename characters', () => {
  const g = new KnowledgeGraph()
  g.addClaim({ id: 'a/b:c*d', text: 'Some Entity did a thing in 2024.' }, false)
  for (const f of g.toObsidian()) {
    assert.ok(!/[\\:*?"<>|]/.test(f.path.replace(/^[a-z]+\//, '')), `unsafe path: ${f.path}`)
  }
})

test('malformed claims are ignored rather than crashing the graph', () => {
  const g = new KnowledgeGraph()
  g.addClaim(null, false)
  g.addClaim({ id: 'x' }, false)
  g.addClaim({ text: 'no id' }, false)
  assert.equal(g.stats().claims, 0)
})
