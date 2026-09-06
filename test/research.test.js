/**
 * @file Tests for the adaptive multi-round research loop.
 *
 * The property under test is adaptivity: follow-up rounds must ask DIFFERENT,
 * gap-targeted questions, must stop early when nothing new is found, and must
 * never report a contested or single-origin finding as settled.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assessCoverage,
  gapQuery,
  heuristicDecompose,
  mergeVerdicts,
  MODES,
  renderResearch,
  research,
} from '../lib/research.js'
import { adjudicate, renderVerdict } from '../lib/tribunal.js'
import { Verdict } from '../lib/anchor.js'

const T0 = Date.UTC(2024, 2, 1)
const ev = (o) => ({
  docId: o.docId,
  url: o.url ?? `https://${o.docId}.example`,
  quote: o.quote ?? 'a sufficiently long verbatim quote used for the record here',
  credibility: o.credibility ?? 70,
  isPrimary: o.isPrimary ?? false,
  publishedAt: o.publishedAt ?? T0,
  text: o.text ?? `wholly distinct body text for ${o.docId} discussing separate material`,
})

/**
 * Genuinely distinct document bodies. They must share almost no vocabulary,
 * otherwise the lineage engine will (correctly) collapse them into one origin
 * and the fixture would be testing the wrong thing.
 */
const DISTINCT_BODIES = [
  'Regulatory filings reviewed by our staff show an inventory writedown of eighty million dollars last quarter.',
  'A field correspondent visited three manufacturing plants and observed idle assembly lines throughout the week.',
  'Statistical modelling of customs records indicates shipping volumes fell sharply between March and June.',
  'Interviews with four former engineers describe repeated delays in component certification during testing.',
  'Satellite imagery analysis reveals substantial new construction at the northern industrial site since spring.',
]

/** Minimal always-succeeding tribunal deps producing N independent supporters. */
const supportingDeps = (n, tag = 's') => ({
  gather: async (q) =>
    /debunk|false|retract|replicate|criticism|against/i.test(q)
      ? []
      : Array.from({ length: n }, (_, i) => ({
          id: `${tag}${i}`,
          url: `https://${tag}${i}.example`,
          text: DISTINCT_BODIES[i % DISTINCT_BODIES.length],
          publishedAt: T0 + i * 1000,
        })),
  judge: async (_c, doc) => ({ verdict: Verdict.SUPPORTED, quote: doc.text.slice(0, 60), score: 0.9 }),
  anchor: (quote, text) => ({ ok: text.includes(quote), matchedText: quote }),
  credibility: () => ({ score: 75, isPrimary: false }),
})

test('modes are ordered by increasing rigour', () => {
  assert.ok(MODES.quick.rounds < MODES.standard.rounds)
  assert.ok(MODES.standard.rounds < MODES.deep.rounds)
  assert.ok(MODES.deep.rounds < MODES.forensic.rounds)
  assert.ok(MODES.quick.minConfidence < MODES.forensic.minConfidence)
})

test('heuristicDecompose splits compound questions', () => {
  const parts = heuristicDecompose('Is solar cheaper than coal and does it create more jobs?')
  assert.ok(parts.length >= 2, `expected a split, got ${JSON.stringify(parts)}`)
})

test('heuristicDecompose returns the whole question when atomic', () => {
  const parts = heuristicDecompose('What is the capital of France')
  assert.equal(parts.length, 1)
})

test('assessCoverage flags missing evidence as a broaden gap', () => {
  const { gaps, coverage } = assessCoverage(
    [{ id: 'q1', text: 't', status: 'open', verdict: null, attempts: 0 }],
    { minIcs: 2, minConfidence: 0.65 },
  )
  assert.equal(coverage, 0)
  assert.equal(gaps[0].strategy, 'broaden')
})

test('assessCoverage flags insufficient independence', () => {
  const verdict = adjudicate({ claim: 't', support: [ev({ docId: 'a' })], refute: [] })
  const { gaps } = assessCoverage(
    [{ id: 'q1', text: 't', status: 'open', verdict, attempts: 1 }],
    { minIcs: 2, minConfidence: 0.5 },
  )
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].strategy, 'seek-independent')
  assert.match(gaps[0].reason, /independent origin/i)
})

test('assessCoverage flags an unresolved contradiction', () => {
  const verdict = adjudicate({
    claim: 't',
    support: [ev({ docId: 'a' }), ev({ docId: 'b' })],
    refute: [ev({ docId: 'r', quote: 'a credible contrary finding recorded here' })],
  })
  const { gaps } = assessCoverage(
    [{ id: 'q1', text: 't', status: 'open', verdict, attempts: 1 }],
    { minIcs: 2, minConfidence: 0.5 },
  )
  assert.equal(gaps[0].strategy, 'adjudicate-conflict')
})

test('a well-evidenced refutation counts as resolved, not a gap', () => {
  const verdict = adjudicate({
    claim: 't',
    support: [],
    refute: [ev({ docId: 'r1' }), ev({ docId: 'r2' })],
  })
  const { gaps, resolved } = assessCoverage(
    [{ id: 'q1', text: 't', status: 'open', verdict, attempts: 1 }],
    { minIcs: 2, minConfidence: 0.5 },
  )
  assert.equal(resolved, 1, 'proving something false IS an answer')
  assert.equal(gaps.length, 0)
})

test('CORE: gap strategies produce DIFFERENT follow-up queries', () => {
  const base = 'the policy reduced emissions'
  const queries = new Set(
    ['broaden', 'seek-independent', 'adjudicate-conflict', 'corroborate-refutation', 'strengthen'].map(
      (strategy) => gapQuery({ text: base, strategy }),
    ),
  )
  assert.equal(queries.size, 5, 'each strategy must yield a distinct probe')
  assert.match(gapQuery({ text: base, strategy: 'seek-independent' }), /primary source/i)
  assert.match(gapQuery({ text: base, strategy: 'adjudicate-conflict' }), /meta-analysis|systematic/i)
})

test('mergeVerdicts unions evidence and re-adjudicates', () => {
  const a = adjudicate({ claim: 'c', support: [ev({ docId: 'a' })], refute: [] })
  const b = adjudicate({ claim: 'c', support: [ev({ docId: 'b' })], refute: [] })
  const merged = mergeVerdicts(a, b, 'c')
  assert.equal(merged.support.length, 2)
  assert.equal(merged.supportIcs, 2, 'union of two origins must be two')
})

test('mergeVerdicts deduplicates identical evidence', () => {
  const a = adjudicate({ claim: 'c', support: [ev({ docId: 'a' })], refute: [] })
  const merged = mergeVerdicts(a, a, 'c')
  assert.equal(merged.support.length, 1)
})

test('mergeVerdicts lets a later round overturn an earlier verdict', () => {
  const supported = adjudicate({ claim: 'c', support: [ev({ docId: 'a' }), ev({ docId: 'b' })], refute: [] })
  assert.equal(supported.verdict, Verdict.SUPPORTED)

  const refuted = adjudicate({
    claim: 'c',
    support: [],
    refute: [
      ev({ docId: 'r1', credibility: 95, isPrimary: true }),
      ev({ docId: 'r2', credibility: 92 }),
      ev({ docId: 'r3', credibility: 90 }),
    ],
  })
  const merged = mergeVerdicts(supported, refuted, 'c')
  assert.notEqual(merged.verdict, Verdict.SUPPORTED, 'new refutation must be able to change the outcome')
  assert.ok(merged.refute.length >= 3)
})

test('research resolves a well-supported question and stops early', async () => {
  const r = await research('Did the agency publish updated guidance', { tribunal: supportingDeps(3) }, { mode: 'standard' })
  assert.equal(r.stopReason, 'resolved')
  assert.ok(r.rounds < MODES.standard.rounds, `should stop before exhausting rounds, used ${r.rounds}`)
  assert.equal(r.coverage, 1)
  assert.equal(r.subQuestions[0].status, 'resolved')
})

test('CORE: research stops early when a round adds nothing new', async () => {
  // Always returns the SAME single document, so no round can add new evidence.
  const stagnant = {
    gather: async (q) =>
      /debunk|false|retract|replicate|criticism|against/i.test(q)
        ? []
        : [{ id: 'only', url: 'https://only.example', text: 'the one and only document available anywhere', publishedAt: T0 }],
    judge: async (_c, doc) => ({ verdict: Verdict.SUPPORTED, quote: doc.text.slice(0, 40), score: 0.8 }),
    anchor: (quote, text) => ({ ok: text.includes(quote), matchedText: quote }),
    credibility: () => ({ score: 60, isPrimary: false }),
  }
  const r = await research('An unanswerable question about something', { tribunal: stagnant }, { mode: 'deep' })
  assert.equal(r.stopReason, 'no-progress')
  assert.ok(r.rounds < MODES.deep.rounds, 'must not burn the full budget when stuck')
})

test('research reports unresolved questions honestly rather than inventing answers', async () => {
  const empty = {
    gather: async () => [],
    judge: async () => ({ verdict: Verdict.NEUTRAL, quote: '', score: 0 }),
    anchor: () => ({ ok: false }),
    credibility: () => ({ score: 50, isPrimary: false }),
  }
  const r = await research('Something with no evidence at all', { tribunal: empty }, { mode: 'quick' })
  assert.equal(r.subQuestions[0].status, 'exhausted')
  assert.equal(r.coverage, 0)
  assert.match(r.summary, /unresolved/)
})

test('quick mode uses exactly one round', async () => {
  const r = await research('A question', { tribunal: supportingDeps(1) }, { mode: 'quick' })
  assert.equal(r.rounds, 1)
})

test('an invalid mode falls back to standard', async () => {
  const r = await research('A question', { tribunal: supportingDeps(2) }, { mode: 'nonsense' })
  assert.equal(r.mode, 'standard')
})

test('a failing decomposer does not break the run', async () => {
  const r = await research(
    'A resilient question about a subject',
    {
      decompose: async () => {
        throw new Error('planner down')
      },
      tribunal: supportingDeps(2),
    },
    { mode: 'quick' },
  )
  assert.ok(r.subQuestions.length >= 1)
})

test('contested findings are surfaced, never smoothed away', async () => {
  const conflicted = {
    gather: async (q) =>
      /debunk|false|retract|replicate|criticism|against/i.test(q)
        ? [{ id: 'r1', url: 'https://r1.example', text: 'a rigorous rebuttal document with entirely separate wording', publishedAt: T0 + 10 }]
        : [
            { id: 's1', url: 'https://s1.example', text: 'first supporting account with unique phrasing alpha', publishedAt: T0 },
            { id: 's2', url: 'https://s2.example', text: 'second supporting account with unique phrasing beta', publishedAt: T0 + 1 },
          ],
    judge: async (_c, doc) => ({
      verdict: doc.id.startsWith('r') ? Verdict.CONTRADICTED : Verdict.SUPPORTED,
      quote: doc.text.slice(0, 45),
      score: 0.85,
    }),
    anchor: (quote, text) => ({ ok: text.includes(quote), matchedText: quote }),
    credibility: () => ({ score: 80, isPrimary: false }),
  }
  const r = await research('A disputed question', { tribunal: conflicted }, { mode: 'quick' })
  assert.equal(r.subQuestions[0].status, 'contested')
  const md = renderResearch(r, renderVerdict)
  assert.match(md, /Contested points/)
})

test('renderResearch includes the audit trail', async () => {
  const r = await research('A traceable question', { tribunal: supportingDeps(2) }, { mode: 'quick' })
  const md = renderResearch(r, renderVerdict)
  assert.match(md, /# A traceable question/)
  assert.match(md, /Research trace/)
  assert.match(md, /Decomposed into/)
})

test('timeline records every round', async () => {
  const r = await research('A logged question', { tribunal: supportingDeps(2) }, { mode: 'standard' })
  assert.ok(r.timeline.length >= 2)
  assert.ok(r.timeline.some((t) => /Round 1/.test(t)))
})
