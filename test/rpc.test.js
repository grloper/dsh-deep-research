/**
 * @file Regression tests for the Client→Host RPC bridge and the v0.2 audit fixes.
 *
 * These lock in the behaviours that the production audit identified as broken:
 * the browser UI previously called a Host method that did not exist and then
 * silently fabricated a verdict when the call failed. The contract asserted here
 * is that the Host really answers, and that it answers with lossless JSON only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, getHarness, hashId, registerHostRpc, fetchDocuments } from '../lib/index.js'

/** Minimal harness double capturing registered RPC handlers. */
function makeHarness() {
  const handlers = new Map()
  return {
    handlers,
    handle: (method, fn) => handlers.set(method, fn),
    call: (method, args) => {
      const fn = handlers.get(method)
      if (!fn) throw new Error(`no handler: ${method}`)
      return fn(args)
    },
  }
}

test('getHarness resolves from ctx and returns null when absent', () => {
  const h = makeHarness()
  assert.equal(getHarness({ harness: h }), h)
  assert.equal(getHarness({}), null)
  assert.equal(getHarness({ harness: {} }), null, 'a harness without handle() is unusable')
})

test('apply registers the verify/stats/recall RPC methods when a harness exists', () => {
  const harness = makeHarness()
  const result = apply(
    { harness, tools: { register: () => {} }, on: () => {} },
    { storePath: ':memory:' },
  )
  assert.deepEqual(result.rpc.sort(), ['recall', 'stats', 'verify'])
})

test('apply reports an empty rpc list when the host has no harness', () => {
  const result = apply({ tools: { register: () => {} }, on: () => {} }, { storePath: ':memory:' })
  assert.deepEqual(result.rpc, [], 'plain npm hosts have no RPC surface and must say so')
})

test('the verify RPC returns a JSON-serializable report, never live objects', async () => {
  const harness = makeHarness()
  apply({ harness, tools: { register: () => {} }, on: () => {} }, { storePath: ':memory:' })

  const out = await harness.call('verify', {
    text: 'The agency reported that inspections resumed in March 2024 across all facilities.',
  })

  assert.equal(out.ok, true)
  assert.ok(Array.isArray(out.claims))
  assert.equal(typeof out.summary, 'string')
  // The whole payload must survive a JSON round-trip unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out)
})

test('the verify RPC rejects empty input instead of inventing claims', async () => {
  const harness = makeHarness()
  apply({ harness, tools: { register: () => {} }, on: () => {} }, { storePath: ':memory:' })
  const out = await harness.call('verify', { text: '   ' })
  assert.equal(out.ok, false)
  assert.equal(out.error, 'empty-text')
  assert.deepEqual(out.claims, [])
})

test('the stats RPC reports real store state rather than marketing numbers', async () => {
  const harness = makeHarness()
  apply({ harness, tools: { register: () => {} }, on: () => {} }, { storePath: ':memory:' })
  const s = await harness.call('stats', {})
  assert.equal(s.ok, true)
  assert.ok(['sqlite', 'json', 'unavailable'].includes(s.backend))
  assert.equal(typeof s.claims, 'number')
  assert.equal(s.persistent, false, ':memory: store must not claim persistence')
})

test('the recall RPC answers honestly on an empty graph', async () => {
  const harness = makeHarness()
  apply({ harness, tools: { register: () => {} }, on: () => {} }, { storePath: ':memory:' })
  const out = await harness.call('recall', { query: 'nothing has been researched yet' })
  assert.equal(out.ok, true)
  assert.deepEqual(out.hits, [])
})

test('a failing RPC registration does not break plugin load', () => {
  const harness = {
    handle: () => {
      throw new Error('host rejected the handler')
    },
  }
  const warnings = []
  const registered = registerHostRpc(
    { harness },
    { deps: {}, store: null, graph: null, log: { info: () => {}, warn: (m) => warnings.push(m) } },
  )
  assert.deepEqual(registered, [])
  assert.ok(warnings.length >= 1, 'the failure must be logged, not swallowed silently')
})

test('tool disposers are retained and invoked on dispose', () => {
  let disposed = 0
  let onDispose = null
  apply(
    {
      tools: { register: () => () => disposed++ },
      on: (evt, fn) => {
        if (evt === 'dispose') onDispose = fn
      },
    },
    { storePath: ':memory:' },
  )
  assert.equal(typeof onDispose, 'function', 'plugin must register a dispose hook')
  onDispose()
  assert.equal(disposed, 5, 'every registered tool disposer must run on teardown')
})

test('hashId is wide enough to avoid collisions across a large corpus', () => {
  const seen = new Map()
  for (let i = 0; i < 200_000; i++) {
    const id = hashId(`https://example.com/article/${i}`)
    const prev = seen.get(id)
    assert.equal(prev, undefined, `collision between item ${prev} and ${i} on id ${id}`)
    seen.set(id, i)
  }
  assert.equal(seen.size, 200_000)
})

test('hashId remains deterministic and url-safe', () => {
  assert.equal(hashId('https://example.com/a'), hashId('https://example.com/a'))
  assert.notEqual(hashId('https://example.com/a'), hashId('https://example.com/b'))
  assert.match(hashId('anything'), /^[0-9a-z]+$/)
})

test('fetchDocuments deduplicates urls and survives individual failures', async () => {
  const calls = []
  const fetchDoc = async (url) => {
    calls.push(url)
    if (url.includes('dead')) return null
    if (url.includes('throws')) throw new Error('network exploded')
    return { text: `content of ${url}`, html: '' }
  }
  const docs = await fetchDocuments(
    ['https://a.example.com', 'https://a.example.com', 'https://dead.example.com', 'https://throws.example.com', 'https://b.example.com'],
    fetchDoc,
  )
  assert.equal(calls.length, 4, 'the duplicate url must be fetched only once')
  assert.deepEqual(docs.map((d) => d.url), ['https://a.example.com', 'https://b.example.com'])
  // Content-addressed ids keep the same page stable across runs.
  assert.equal(docs[0].id, hashId('https://a.example.com'))
})

test('fetchDocuments preserves input order despite concurrency', async () => {
  const fetchDoc = async (url) => {
    const delay = url.endsWith('1') ? 30 : 1
    await new Promise((r) => setTimeout(r, delay))
    return { text: `t ${url}`, html: '' }
  }
  const urls = ['https://x.example.com/1', 'https://x.example.com/2', 'https://x.example.com/3']
  const docs = await fetchDocuments(urls, fetchDoc, { concurrency: 3 })
  assert.deepEqual(docs.map((d) => d.url), urls, 'slow first item must still come first')
})
