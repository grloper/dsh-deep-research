/**
 * @file Tests for graph recall wired into the research loop.
 *
 * The claim being tested is the moat: a second run over related ground must
 * reuse prior verified work instead of starting from zero, and must refuse to
 * reuse it once it has gone stale.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { research } from '../lib/research.js'
import { KnowledgeGraph } from '../lib/graph.js'
import { EvidenceStore } from '../lib/store.js'
import { Verdict } from '../lib/anchor.js'

const T0 = Date.UTC(2024, 2, 1)
const HOUR = 3600_000

const DISTINCT = [
  'Regulatory filings show an inventory writedown of eighty million dollars last quarter.',
  'A correspondent visited three plants and observed idle assembly lines all week.',
  'Customs record modelling indicates shipping volumes fell sharply during spring.',
]

/** Tribunal deps that count how many searches were performed. */
function countingDeps(counter) {
  return {
    gather: async (q) => {
      counter.searches++
      return /debunk|false|retract|replicate|criticism|against/i.test(q)
        ? []
        : DISTINCT.map((text, i) => ({
            id: `s${i}`,
            url: `https://s${i}.example`,
            text,
            publishedAt: T0 + i * 1000,
          }))
    },
    judge: async (_c, doc) => ({ verdict: Verdict.SUPPORTED, quote: doc.text.slice(0, 50), score: 0.9 }),
    anchor: (quote, text) => ({ ok: text.includes(quote), matchedText: quote }),
    credibility: () => ({ score: 80, isPrimary: false }),
  }
}

test('research runs without a graph (graph is optional)', async () => {
  const counter = { searches: 0 }
  const r = await research('A question about something', { tribunal: countingDeps(counter) }, { mode: 'quick' })
  assert.equal(r.recalled, 0)
  assert.ok(counter.searches > 0)
})

test('CORE: verified findings are written back into the graph', async () => {
  const graph = new KnowledgeGraph()
  const counter = { searches: 0 }
  await research(
    'Did Acme Corporation write down inventory in 2024',
    { tribunal: countingDeps(counter), graph },
    { mode: 'quick' },
  )
  assert.ok(graph.stats().claims > 0, 'the run must contribute to the evidence graph')
})

test('CORE: a later run reuses prior verified work', async () => {
  const graph = new KnowledgeGraph()
  const question = 'Did Acme Corporation write down inventory in 2024'

  const first = { searches: 0 }
  const r1 = await research(question, { tribunal: countingDeps(first), graph }, { mode: 'quick' })
  assert.equal(r1.recalled, 0, 'nothing to recall on a cold graph')
  assert.ok(graph.stats().claims > 0)

  const second = { searches: 0 }
  const r2 = await research(question, { tribunal: countingDeps(second), graph }, { mode: 'quick' })
  assert.ok(r2.recalled > 0, 'the second run must recall prior work')
  assert.match(r2.summary, /reused from evidence graph/)
  assert.ok(
    r2.timeline.some((t) => /reusing a prior verification/i.test(t)),
    'reuse must be visible in the audit trail',
  )
})

test('CORE: stale prior work is NOT reused', async () => {
  const graph = new KnowledgeGraph()
  // A fast-volatility claim verified 40 hours ago is past its 24h horizon.
  graph.addClaim(
    {
      id: 'old',
      text: 'The current stock price of Acme Corporation is 42 dollars.',
      verdict: 'SUPPORTED',
      confidence: 0.95,
      last_verified: Date.now() - 40 * HOUR,
      volatility: 'fast',
    },
    false,
  )
  const counter = { searches: 0 }
  const r = await research(
    'The current stock price of Acme Corporation is 42 dollars.',
    { tribunal: countingDeps(counter), graph },
    { mode: 'quick' },
  )
  assert.equal(r.recalled, 0, 'stale fast-changing facts must be re-verified, not reused')
  assert.ok(counter.searches > 0, 'a stale recall must still trigger real searching')
})

test('low-confidence prior work is not reused as if settled', async () => {
  const graph = new KnowledgeGraph()
  graph.addClaim(
    {
      id: 'weak',
      text: 'Acme Corporation opened a facility in Denver.',
      verdict: 'PARTIAL',
      confidence: 0.2,
      last_verified: Date.now(),
      volatility: 'slow',
    },
    false,
  )
  const r = await research(
    'Acme Corporation opened a facility in Denver.',
    { tribunal: countingDeps({ searches: 0 }), graph },
    { mode: 'quick' },
  )
  assert.equal(r.recalled, 0, 'weak prior findings must not short-circuit research')
})

test('a throwing graph never breaks a research run', async () => {
  const hostile = {
    recall: () => {
      throw new Error('graph exploded')
    },
    addClaim: () => {
      throw new Error('write failed')
    },
  }
  const r = await research(
    'A resilient question about a subject',
    { tribunal: countingDeps({ searches: 0 }), graph: hostile },
    { mode: 'quick' },
  )
  assert.ok(r.subQuestions.length >= 1, 'the run must complete despite a broken graph')
})

test('recall survives a real store round-trip', async () => {
  const store = new EvidenceStore(':memory:')
  const graph = new KnowledgeGraph(store)
  const question = 'Did customs data show shipping volumes fall'

  await research(question, { tribunal: countingDeps({ searches: 0 }), graph }, { mode: 'quick' })

  // Rebuild the graph purely from persisted state, as a fresh process would.
  const reloaded = new KnowledgeGraph(store)
  assert.ok(reloaded.stats().claims > 0, 'claims must be durable')

  const r2 = await research(question, { tribunal: countingDeps({ searches: 0 }), graph: reloaded }, { mode: 'quick' })
  assert.ok(r2.recalled > 0, 'a fresh process must be able to reuse earlier findings')
  store.close()
})
