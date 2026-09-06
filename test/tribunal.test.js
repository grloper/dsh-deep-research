/**
 * @file Tests for the adversarial Tribunal (mechanism M3).
 *
 * The behaviour under test is the one that separates this from every other
 * research agent: a popular-but-wrong claim must NOT sail through, and a claim
 * supported only by syndicated copies must never be reported as settled.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { adjudicate, buildQueries, REFUTATION_TEMPLATES, renderVerdict, tryClaim } from '../lib/tribunal.js'
import { Verdict } from '../lib/anchor.js'

const T0 = Date.UTC(2024, 3, 1)

/** @param {Partial<any>} o */
const ev = (o) => ({
  docId: o.docId ?? 'd',
  url: o.url,
  quote: o.quote ?? 'a sufficiently long verbatim quote for the record',
  credibility: o.credibility ?? 60,
  isPrimary: o.isPrimary ?? false,
  publishedAt: o.publishedAt,
  text: o.text ?? 'unique body text about a distinct subject matter for lineage purposes',
})

test('buildQueries always produces refutation queries', () => {
  const q = buildQueries('the vaccine reduces transmission')
  assert.ok(q.support.length > 0)
  assert.ok(q.refute.length > 0)
  assert.ok(q.refute.some((s) => /debunk|false|retract|replicate|criticism|against/i.test(s)))
})

test('buildQueries handles empty input', () => {
  const q = buildQueries('   ')
  assert.deepEqual(q.support, [])
  assert.deepEqual(q.refute, [])
})

test('refutation templates are adversarial by construction', () => {
  for (const t of REFUTATION_TEMPLATES) {
    const s = t('X')
    assert.notEqual(s, 'X', 'a refutation template must alter the query')
  }
})

test('no evidence yields UNVERIFIED', () => {
  const v = adjudicate({ claim: 'c', support: [], refute: [] })
  assert.equal(v.verdict, Verdict.UNVERIFIED)
  assert.match(v.reasoning.join(' '), /No admissible evidence/i)
})

test('CORE: uncontested multi-origin support is SUPPORTED', () => {
  const v = adjudicate({
    claim: 'c',
    support: [
      ev({ docId: 'a', text: 'first entirely distinct account of the underlying event here', publishedAt: T0 }),
      ev({ docId: 'b', text: 'second completely different analysis from another organisation', publishedAt: T0 + 1000 }),
    ],
    refute: [],
  })
  assert.equal(v.verdict, Verdict.SUPPORTED)
  assert.equal(v.supportIcs, 2)
  assert.match(v.reasoning.join(' '), /search for disconfirming evidence found none/i)
})

test('CORE: single-origin support is downgraded to PARTIAL, never settled', () => {
  const v = adjudicate({
    claim: 'c',
    support: [ev({ docId: 'only', text: 'a single solitary account of the matter at hand', publishedAt: T0 })],
    refute: [],
  })
  assert.equal(v.verdict, Verdict.PARTIAL)
  assert.match(v.reasoning.join(' '), /single independent origin cannot corroborate itself/i)
})

test('CORE: syndicated copies do not manufacture a SUPPORTED verdict', () => {
  const wire = 'the ministry confirmed that the measure takes effect on the first of January without exception'
  const v = adjudicate({
    claim: 'c',
    support: [
      ev({ docId: 'pr', text: wire, publishedAt: T0 }),
      ev({ docId: 'n1', text: `Report: ${wire}`, publishedAt: T0 + 1000 }),
      ev({ docId: 'n2', text: `${wire} Analysts noted.`, publishedAt: T0 + 2000 }),
      ev({ docId: 'n3', text: `Breaking. ${wire}`, publishedAt: T0 + 3000 }),
    ],
    refute: [],
  })
  assert.equal(v.supportIcs, 1, 'four syndicated docs are one origin')
  assert.equal(v.verdict, Verdict.PARTIAL, 'must not be reported as settled')
})

test('CORE: credible refutation prevents a settled verdict and records dissent', () => {
  const v = adjudicate({
    claim: 'c',
    support: [
      ev({ docId: 'a', text: 'independent account number one of the underlying event', publishedAt: T0 }),
      ev({ docId: 'b', text: 'independent account number two from a separate organisation', publishedAt: T0 + 1 }),
      ev({ docId: 'c2', text: 'independent account number three via different methodology', publishedAt: T0 + 2 }),
    ],
    refute: [
      ev({
        docId: 'r',
        url: 'https://replication.example/x',
        quote: 'the effect did not survive replication in a larger cohort',
        credibility: 85,
        text: 'a rigorous replication attempt failed to reproduce the reported effect size',
        publishedAt: T0 + 10,
      }),
    ],
  })
  assert.notEqual(v.verdict, Verdict.SUPPORTED, 'credible dissent must block a settled verdict')
  assert.equal(v.contested, true)
  assert.ok(v.dissent.length > 0, 'dissent must be recorded, not discarded')
  assert.match(v.dissent.join(' '), /did not survive replication/)
})

test('decisive refutation yields CONTRADICTED but keeps the minority view', () => {
  const v = adjudicate({
    claim: 'c',
    support: [ev({ docId: 's', credibility: 30, text: 'a lone low quality assertion of the claim' })],
    refute: [
      ev({ docId: 'r1', credibility: 90, isPrimary: true, text: 'authoritative primary refutation document one', publishedAt: T0 }),
      ev({ docId: 'r2', credibility: 88, text: 'a separate independent refutation from another body', publishedAt: T0 + 1 }),
    ],
  })
  assert.equal(v.verdict, Verdict.CONTRADICTED)
  assert.equal(v.contested, true)
  assert.ok(v.dissent.some((d) => /Supporting view retained/i.test(d)))
})

test('only refuting evidence yields CONTRADICTED', () => {
  const v = adjudicate({
    claim: 'c',
    support: [],
    refute: [ev({ docId: 'r', text: 'the sole refuting document describing contrary findings' })],
  })
  assert.equal(v.verdict, Verdict.CONTRADICTED)
})

test('a primary source outweighs a pile of low-credibility blogs', () => {
  const v = adjudicate({
    claim: 'c',
    support: Array.from({ length: 4 }, (_, i) =>
      ev({ docId: `b${i}`, credibility: 25, text: `low quality blog take number ${i} about the topic`, publishedAt: T0 + i }),
    ),
    refute: [
      ev({
        docId: 'gov',
        credibility: 92,
        isPrimary: true,
        text: 'the official regulatory filing stating the contrary position in detail',
        publishedAt: T0,
      }),
    ],
  })
  assert.ok(
    v.verdict === Verdict.CONTRADICTED || v.verdict === Verdict.PARTIAL,
    `expected refutation to carry weight, got ${v.verdict}`,
  )
})

test('every verdict carries auditable reasoning', () => {
  const v = adjudicate({ claim: 'c', support: [ev({ docId: 'a' })], refute: [] })
  assert.ok(v.reasoning.length > 0)
  for (const r of v.reasoning) assert.ok(r.length > 15, `reasoning too terse: ${r}`)
})

test('confidence never exceeds bounds', () => {
  const v = adjudicate({
    claim: 'c',
    support: Array.from({ length: 10 }, (_, i) =>
      ev({ docId: `s${i}`, credibility: 100, text: `wholly distinct supporting document number ${i} here`, publishedAt: T0 + i }),
    ),
    refute: [],
  })
  assert.ok(v.confidence >= 0 && v.confidence <= 1)
})

test('tryClaim gathers both sides and blocks unanchored evidence', async () => {
  const supportDoc = { id: 's1', url: 'https://s.example', text: 'The report states the figure was forty two percent overall.', publishedAt: T0 }
  const refuteDoc = { id: 'r1', url: 'https://r.example', text: 'A later audit concluded the figure was materially overstated.', publishedAt: T0 + 5 }

  const v = await tryClaim('the figure was forty two percent', {
    gather: async (q) => (/debunk|false|retract|replicate|criticism|against/i.test(q) ? [refuteDoc] : [supportDoc]),
    judge: async (_c, doc) =>
      doc.id === 's1'
        ? { verdict: Verdict.SUPPORTED, quote: 'the figure was forty two percent overall', score: 0.9 }
        : { verdict: Verdict.CONTRADICTED, quote: 'the figure was materially overstated', score: 0.9 },
    anchor: (quote, text) => {
      const ok = text.toLowerCase().includes(String(quote).toLowerCase())
      return { ok, matchedText: ok ? quote : undefined }
    },
    credibility: () => ({ score: 70, isPrimary: false }),
  })

  assert.equal(v.support.length, 1)
  assert.equal(v.refute.length, 1)
  assert.equal(v.contested, true)
  assert.ok(v.dissent.length > 0)
})

test('tryClaim discards evidence whose quote fails to anchor', async () => {
  const doc = { id: 'd1', url: 'https://x.example', text: 'Genuine document text about an unrelated matter entirely.' }
  const v = await tryClaim('some claim', {
    gather: async () => [doc],
    judge: async () => ({ verdict: Verdict.SUPPORTED, quote: 'a quote that is nowhere in the document', score: 1 }),
    anchor: (quote, text) => ({ ok: text.includes(quote) }),
    credibility: () => ({ score: 80, isPrimary: false }),
  })
  assert.equal(v.support.length, 0, 'unanchored evidence must never influence a verdict')
  assert.equal(v.verdict, Verdict.UNVERIFIED)
})

test('tryClaim survives a failing gatherer and judge', async () => {
  const v = await tryClaim('claim', {
    gather: async () => {
      throw new Error('search down')
    },
    judge: async () => {
      throw new Error('llm down')
    },
    anchor: () => ({ ok: false }),
    credibility: () => ({ score: 50, isPrimary: false }),
  })
  assert.equal(v.verdict, Verdict.UNVERIFIED)
})

test('renderVerdict outputs dissent and reasoning', () => {
  const v = adjudicate({
    claim: 'a test claim',
    support: [ev({ docId: 'a', url: 'https://a.example', text: 'distinct supporting text one', publishedAt: T0 })],
    refute: [ev({ docId: 'r', url: 'https://r.example', quote: 'contrary finding recorded here', text: 'distinct refuting text', publishedAt: T0 + 1 })],
  })
  const md = renderVerdict(v)
  assert.match(md, /Independent origins/)
  assert.match(md, /Recorded dissent/)
  assert.match(md, /Adjudication/)
  assert.ok(md.includes('a test claim'))
})
