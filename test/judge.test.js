/**
 * @file Tests for the zero-LLM lexical entailment judge and capability preflight.
 *
 * These cover the single most impactful defect in the engine: when a host had no
 * `llm` service, the tribunal's judge fell back to a stub returning
 * `{verdict:'NEUTRAL', quote:''}` for every document. Because the tribunal only
 * admits SUPPORTED / PARTIAL / CONTRADICTED evidence, that stub discarded 100% of
 * retrieved documents — so the engine burned its whole round budget and reported
 * "0 resolved" no matter what it found. Users experienced this as activating deep
 * research and having "nothing really happen".
 *
 * The guarantee under test: with NO language model at all, the engine still
 * admits real, mechanically-anchored evidence, and it still cannot fabricate a
 * citation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  contentTokens,
  describeCapabilities,
  figures,
  lexicalJudge,
  RELEVANCE_FLOOR,
  scoreSentence,
  sentences,
  stanceOf,
} from '../lib/judge.js'
import { anchorQuote, Verdict } from '../lib/anchor.js'

const STUDY =
  'Intermittent fasting has attracted considerable research attention in recent years. ' +
  'A 2023 randomized controlled trial found that intermittent fasting reduced body weight ' +
  'by 8% over 12 weeks in 240 adults. The authors reported no significant change in ' +
  'insulin sensitivity across either arm of the study.'

test('CORE: the lexical judge admits real evidence with no LLM present', () => {
  const r = lexicalJudge(
    { text: 'Intermittent fasting reduced body weight by 8% over 12 weeks' },
    { text: STUDY },
  )
  assert.equal(r.verdict, Verdict.SUPPORTED)
  assert.ok(r.score > RELEVANCE_FLOOR)
  assert.ok(r.quote.length >= 24, 'quote must be long enough to anchor')
})

test('CORE: every quote the judge returns survives mechanical anchoring', () => {
  // The judge SELECTS text from the document rather than generating it, so it is
  // structurally incapable of manufacturing a citation.
  const claims = [
    'Intermittent fasting reduced body weight by 8% over 12 weeks',
    'The trial enrolled 240 adults',
    'Insulin sensitivity did not change significantly',
  ]
  for (const text of claims) {
    const r = lexicalJudge({ text }, { text: STUDY })
    if (!r.quote) continue
    const a = anchorQuote(r.quote, STUDY)
    assert.ok(a.ok, `judge produced an unanchorable quote for "${text}": ${a.reason}`)
    assert.equal(a.kind, 'EXACT', 'a selected span should match exactly')
  }
})

test('an off-topic document is honestly NEUTRAL, not forced into a stance', () => {
  const r = lexicalJudge({ text: 'Vaccines cause autism in children' }, { text: STUDY })
  assert.equal(r.verdict, Verdict.NEUTRAL)
  assert.equal(r.quote, '', 'a NEUTRAL judgment must not carry a citation')
})

test('explicit refutation is detected as CONTRADICTED', () => {
  const doc = {
    text:
      'The claim that 5G networks cause illness has been thoroughly debunked. ' +
      'Researchers found no evidence of any link between 5G exposure and human illness.',
  }
  const r = lexicalJudge({ text: '5G networks cause illness' }, doc)
  assert.equal(r.verdict, Verdict.CONTRADICTED)
  assert.ok(r.quote.length > 0)
  assert.ok(anchorQuote(r.quote, doc.text).ok)
})

test('matching figures sharpen relevance scoring', () => {
  // The claim carries terms the sentences only partly cover, so the score sits
  // below saturation and the figure bonus is actually observable.
  const idf = new Map([
    ['weight', 1],
    ['insulin', 1],
    ['cohort', 1],
  ])
  const claim = ['weight', 'insulin', 'cohort']
  // '8' from the claim must match '8%' in the source: figures are normalised on
  // both sides, otherwise the bonus silently never fires.
  const claimFigures = figures('body weight fell 8')
  assert.deepEqual(claimFigures, ['8'])
  const withFigure = scoreSentence(claim, 'body weight fell by 8% in the group', idf, claimFigures)
  const without = scoreSentence(claim, 'body weight fell substantially in the group', idf, claimFigures)
  assert.ok(
    withFigure > without,
    `an exact figure match must score higher (${withFigure} vs ${without})`,
  )
  assert.ok(withFigure <= 1, 'scores stay normalised')
})

test('figures normalise units and separators so equal numbers compare equal', () => {
  assert.deepEqual(figures('reduced by 8% over 12 weeks'), ['8', '12'])
  assert.deepEqual(figures('a cohort of 1,200 adults'), ['1200'])
  assert.deepEqual(figures('exactly 8.0 percent'), ['8'])
  assert.deepEqual(figures('no numbers here'), [])
})

test('a figure the claim does not mention does not inflate the score', () => {
  const idf = new Map([['weight', 1], ['insulin', 1]])
  const base = scoreSentence(['weight', 'insulin'], 'body weight fell overall', idf, [])
  const noisy = scoreSentence(['weight', 'insulin'], 'body weight fell overall in 1997', idf, [])
  assert.equal(base, noisy, 'irrelevant figures must not change relevance')
})

test('stanceOf weighs negation cues against affirmation cues', () => {
  assert.equal(stanceOf('The study found that the drug reduced mortality'), 'support')
  assert.equal(stanceOf('This finding was retracted and failed to replicate'), 'refute')
})

test('sentence splitting never yields spans too short to anchor', () => {
  for (const s of sentences(STUDY)) {
    assert.ok(s.length >= 24, `span too short to anchor: "${s}"`)
  }
})

test('contentTokens drops stopwords and keeps substantive terms', () => {
  const t = contentTokens('The study of the effects on the patients')
  assert.ok(!t.includes('the'))
  assert.ok(t.includes('study'))
  assert.ok(t.includes('patients'))
})

test('empty or missing input degrades to NEUTRAL without throwing', () => {
  assert.equal(lexicalJudge({ text: '' }, { text: STUDY }).verdict, Verdict.NEUTRAL)
  assert.equal(lexicalJudge({ text: 'anything' }, { text: '' }).verdict, Verdict.NEUTRAL)
  assert.doesNotThrow(() => lexicalJudge(undefined, undefined))
})

test('capabilities report names the judge actually in use', () => {
  const withLlm = describeCapabilities({ search: () => {}, llm: () => {}, fetch: true })
  assert.equal(withLlm.judgeKind, 'llm')
  assert.ok(withLlm.usable)
  assert.deepEqual(withLlm.degraded, [])

  const noLlm = describeCapabilities({ search: () => {}, llm: null, fetch: true })
  assert.equal(noLlm.judgeKind, 'lexical')
  assert.ok(noLlm.usable, 'losing the LLM degrades quality but research still runs')
  assert.ok(noLlm.degraded.length > 0, 'degradation must be reported, never silent')
})

test('CORE: no search capability makes the engine unusable and says so', () => {
  const caps = describeCapabilities({ search: null, llm: () => {}, fetch: true })
  assert.equal(caps.usable, false, 'research is impossible without source discovery')
  assert.match(caps.degraded.join(' '), /search/i)
})
