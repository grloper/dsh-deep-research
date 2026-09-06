/**
 * @file Tests for the persistent evidence store (mechanism M5).
 *
 * Covers both backends where possible, plus the freshness model that decides
 * when prior work may be reused instead of repeated.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  classifyVolatility,
  EvidenceStore,
  isFresh,
  normalizeClaim,
  TTL_MS,
  Volatility,
} from '../lib/store.js'

const HOUR = 3600_000
const DAY = 24 * HOUR

test('store selects a working backend', () => {
  const s = new EvidenceStore(':memory:')
  assert.ok(['sqlite', 'json'].includes(s.backend))
  s.close()
})

test('normalizeClaim collapses formatting differences', () => {
  assert.equal(
    normalizeClaim('The  Treatment reduced rates by 18%!'),
    normalizeClaim('the treatment reduced rates by 18'),
  )
})

test('classifyVolatility separates fast-changing from immutable facts', () => {
  assert.equal(classifyVolatility('The current stock price of Acme is $42'), Volatility.FAST)
  assert.equal(classifyVolatility('The latest version is 3.2'), Volatility.FAST)
  assert.equal(classifyVolatility('Euler was born in 1707'), Volatility.IMMUTABLE)
  assert.equal(classifyVolatility('RFC 7089 defines the Memento protocol'), Volatility.IMMUTABLE)
  assert.equal(classifyVolatility('The company operates six manufacturing plants'), Volatility.SLOW)
})

test('TTLs are ordered fast < slow < immutable', () => {
  assert.ok(TTL_MS[Volatility.FAST] < TTL_MS[Volatility.SLOW])
  assert.ok(TTL_MS[Volatility.SLOW] < TTL_MS[Volatility.IMMUTABLE])
})

test('isFresh respects the volatility horizon', () => {
  const now = Date.now()
  assert.equal(isFresh({ lastVerified: now - 2 * HOUR, volatility: Volatility.FAST }, now), true)
  assert.equal(isFresh({ lastVerified: now - 30 * HOUR, volatility: Volatility.FAST }, now), false)
  assert.equal(isFresh({ lastVerified: now - 30 * DAY, volatility: Volatility.SLOW }, now), true)
  assert.equal(isFresh({ lastVerified: now - 400 * DAY, volatility: Volatility.SLOW }, now), false)
  assert.equal(isFresh({ volatility: Volatility.SLOW }, now), false, 'never-verified is never fresh')
})

test('put and find round-trip a row', () => {
  const s = new EvidenceStore(':memory:')
  s.put('sources', { id: 's1', url: 'https://example.com/a', domain: 'example.com', credibility: 77 })
  const rows = s.find('sources', { id: 's1' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].url, 'https://example.com/a')
  assert.equal(Number(rows[0].credibility), 77)
  s.close()
})

test('put replaces an existing row rather than duplicating it', () => {
  const s = new EvidenceStore(':memory:')
  s.put('sources', { id: 's1', url: 'https://a.example', credibility: 10 })
  s.put('sources', { id: 's1', url: 'https://a.example', credibility: 90 })
  const rows = s.find('sources', { id: 's1' })
  assert.equal(rows.length, 1)
  assert.equal(Number(rows[0].credibility), 90)
  s.close()
})

test('unknown table is rejected', () => {
  const s = new EvidenceStore(':memory:')
  assert.throws(() => s.put('not_a_table', { id: 'x' }), /Unknown table/)
  assert.throws(() => s.find('not_a_table'), /Unknown table/)
  s.close()
})

test('putClaim stores normalized text and classified volatility', () => {
  const s = new EvidenceStore(':memory:')
  s.putClaim({ id: 'c1', text: 'Euler was born in 1707', verdict: 'SUPPORTED', confidence: 0.95, ics: 3 })
  const c = s.getClaim('euler  was BORN in 1707!')
  assert.ok(c, 'claim should be retrievable by normalized text')
  assert.equal(c.verdict, 'SUPPORTED')
  assert.equal(c.volatility, Volatility.IMMUTABLE)
  assert.equal(Number(c.ics), 3)
  s.close()
})

test('putClaim preserves first_seen across re-verification', () => {
  const s = new EvidenceStore(':memory:')
  const t0 = Date.now() - 10 * DAY
  s.putClaim({ id: 'c1', text: 'A durable fact about something', now: t0 })
  const first = s.getClaim('A durable fact about something').first_seen
  s.putClaim({ id: 'c1', text: 'A durable fact about something', now: Date.now() })
  const after = s.getClaim('A durable fact about something')
  assert.equal(Number(after.first_seen), Number(first), 'first_seen must not move')
  assert.ok(Number(after.last_verified) > Number(first))
  s.close()
})

test('recall reuses a fresh claim', () => {
  const s = new EvidenceStore(':memory:')
  s.putClaim({ id: 'c1', text: 'The company operates six plants', verdict: 'SUPPORTED', confidence: 0.9 })
  const r = s.recall('The company operates six plants')
  assert.equal(r.hit, true)
  assert.match(r.reason, /Reusing verification/i)
  s.close()
})

test('recall refuses a stale fast-volatility claim', () => {
  const s = new EvidenceStore(':memory:')
  const old = Date.now() - 40 * HOUR
  s.putClaim({ id: 'c1', text: 'The current stock price is 42 dollars', now: old })
  const r = s.recall('The current stock price is 42 dollars')
  assert.equal(r.hit, false)
  assert.match(r.reason, /stale/i)
  assert.ok(r.claim, 'the stale claim is still returned for context')
  s.close()
})

test('recall misses cleanly for unknown claims', () => {
  const s = new EvidenceStore(':memory:')
  const r = s.recall('Something never researched before')
  assert.equal(r.hit, false)
  assert.equal(r.claim, null)
  assert.match(r.reason, /No prior verification/i)
  s.close()
})

test('stats reports per-table counts', () => {
  const s = new EvidenceStore(':memory:')
  s.putClaim({ id: 'c1', text: 'first claim about a subject' })
  s.putClaim({ id: 'c2', text: 'second claim about another subject' })
  s.put('sources', { id: 's1', url: 'https://x.example' })
  const st = s.stats()
  assert.equal(st.claims, 2)
  assert.equal(st.sources, 1)
  assert.equal(st.evidence, 0)
  s.close()
})

test('object values are serialized safely', () => {
  const s = new EvidenceStore(':memory:')
  s.put('sources', { id: 's1', url: 'https://x.example', signals_json: { a: 1, b: [2, 3] } })
  const row = s.find('sources', { id: 's1' })[0]
  const parsed = typeof row.signals_json === 'string' ? JSON.parse(row.signals_json) : row.signals_json
  assert.deepEqual(parsed, { a: 1, b: [2, 3] })
  s.close()
})

test('data persists across store instances on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kestrel-store-'))
  const path = join(dir, 'evidence.db')
  try {
    const a = new EvidenceStore(path)
    a.putClaim({ id: 'c1', text: 'A persisted claim about durability', verdict: 'SUPPORTED' })
    a.close()

    const b = new EvidenceStore(path)
    const c = b.getClaim('A persisted claim about durability')
    assert.ok(c, `claim did not survive reopen (backend=${b.backend})`)
    assert.equal(c.verdict, 'SUPPORTED')
    b.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('corrupt store file does not crash construction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kestrel-corrupt-'))
  const path = join(dir, 'broken.json')
  try {
    writeFileSync(path, 'this is not valid json at all', 'utf8')
    const s = new EvidenceStore(path)
    assert.ok(s, 'store must construct even with a corrupt file')
    s.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
