/**
 * @file Kestrel — Zero-LLM lexical entailment judge & capability preflight.
 * @license MIT
 *
 * WHY THIS EXISTS
 * ---------------
 * The engine's adversarial pipeline is gated on mechanical quote anchoring: a
 * document only influences a verdict if a judge returns a VERBATIM span that is
 * then located in the source text. That gate is correct and non-negotiable.
 *
 * The failure was the fallback. When a host provided no `llm` service the judge
 * degraded to `async () => ({ verdict: 'NEUTRAL', quote: '' })`. Tribunal only
 * admits SUPPORTED / PARTIAL / CONTRADICTED evidence, so a NEUTRAL-with-empty-quote
 * judge discards EVERY document unconditionally. The loop then ran its full round
 * budget, found zero evidence by construction, and reported "0 resolved" — which
 * is indistinguishable, to a user, from "nothing happened".
 *
 * A stub that guarantees zero output is not graceful degradation; it is a silent
 * no-op. This module replaces it with a real, deterministic judge that:
 *
 *   1. Selects the sentence in the document with the highest lexical overlap
 *      against the claim (IDF-weighted, so shared stopwords cannot carry a match).
 *   2. Returns that sentence VERBATIM, so the downstream anchoring gate stays
 *      fully mechanical — this judge cannot manufacture support, because its
 *      quote is copied out of the document by construction.
 *   3. Detects explicit negation/refutation cues to distinguish CONTRADICTED
 *      from SUPPORTED, instead of collapsing everything to one stance.
 *
 * It is intentionally weaker than a good LLM judge, and reports itself as such
 * via `judgeKind`, so callers can surface real capability information rather
 * than pretending a degraded run was a full one.
 */

import { Verdict } from './anchor.js'

/** Tokens too common to carry evidential weight. */
const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','been','but','by','can','did','do','does','for','from',
  'had','has','have','how','in','into','is','it','its','of','on','or','что','that','the','their',
  'there','these','they','this','to','was','were','what','when','where','which','who','why','will',
  'with','would','could','should','may','might','must','not','no','than','then','them','we','you',
  'i','he','she','his','her','him','our','us','if','so','such','also','more','most','over','under',
  'about','after','before','between','during','while','because','however','only','very','some','any',
])

/** Cues that a sentence is asserting the NEGATION of a claim. */
export const NEGATION_CUES = Object.freeze([
  'no evidence','not true','is false','was false','debunked','disproven','disproved','refuted',
  'retracted','withdrawn','myth','hoax','misleading','incorrect','inaccurate','unfounded',
  'failed to replicate','does not','did not','do not','never','contrary to','contradicts',
  'contradicted','rebutted','overturned','no link','not associated','found no','rather than',
  'however','despite claims','falsely','baseless','unsubstantiated','wrong',
])

/** Cues that a sentence is affirming with evidential force. */
export const AFFIRMATION_CUES = Object.freeze([
  'found that','showed that','demonstrated','confirmed','according to','reported that',
  'study found','research shows','data show','evidence suggests','concluded that','results show',
  'associated with','linked to','led to','caused','increases','decreases','significantly',
])

/**
 * Split text into sentence-like units suitable for quoting.
 * Windows shorter than the anchoring minimum are merged forward so the judge
 * never returns a span the anchor gate would reject for length alone.
 * @param {string} text
 * @param {number} [minChars=40]
 * @returns {string[]}
 */
export function sentences(text, minChars = 40) {
  const raw = String(text ?? '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z"'\u201c(\d])/)
    .map((s) => s.trim())
    .filter(Boolean)

  /** @type {string[]} */ const out = []
  let buffer = ''
  for (const s of raw) {
    buffer = buffer ? `${buffer} ${s}` : s
    if (buffer.length >= minChars) {
      out.push(buffer)
      buffer = ''
    }
  }
  if (buffer.length >= minChars) out.push(buffer)
  else if (buffer && out.length === 0) out.push(buffer)
  return out
}

/**
 * Content tokens of a string, stopwords removed.
 * @param {string} s
 * @returns {string[]}
 */
export function contentTokens(s) {
  return String(s ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
}

/**
 * Numbers mentioned in a string, NORMALISED for comparison. Matching figures are
 * strong evidence that a sentence addresses the same specific fact as the claim.
 *
 * Normalisation matters: a raw match kept trailing units and separators, so the
 * "8" in a claim never equalled the "8%" in a source sentence and the figure
 * bonus silently never fired. Percent signs, thousands separators and trailing
 * punctuation are stripped so 8, 8%, and 8.0 all compare equal.
 *
 * @param {string} s
 * @returns {string[]}
 */
export function figures(s) {
  const raw = String(s ?? '').match(/\d[\d.,]*/g) ?? []
  /** @type {string[]} */ const out = []
  for (const token of raw) {
    // Drop thousands separators, then trailing zeros/decimal point so that
    // "8", "8.0" and "8.00" collapse to a single comparable form.
    const cleaned = token.replace(/,/g, '').replace(/\.$/, '')
    const num = Number(cleaned)
    if (!Number.isFinite(num)) continue
    out.push(String(num))
  }
  return [...new Set(out)]
}

/**
 * Score how strongly one sentence addresses a claim.
 *
 * IDF weighting is computed across the candidate sentences of the SAME document,
 * so a term that appears in every sentence (usually the page's topic word)
 * contributes little, while a rare, specific term contributes a lot. This is what
 * stops a page that merely mentions the subject from scoring as if it addressed
 * the precise assertion.
 *
 * @param {string[]} claimTokens
 * @param {string} sentence
 * @param {Map<string, number>} idf
 * @param {string[]} claimFigures
 * @returns {number} 0..1
 */
export function scoreSentence(claimTokens, sentence, idf, claimFigures = []) {
  const sentTokens = new Set(contentTokens(sentence))
  if (sentTokens.size === 0 || claimTokens.length === 0) return 0

  let matched = 0
  let total = 0
  for (const t of claimTokens) {
    const w = idf.get(t) ?? 1
    total += w
    if (sentTokens.has(t)) matched += w
  }
  let score = total === 0 ? 0 : matched / total

  // Exact figure agreement is a much sharper signal than word overlap.
  if (claimFigures.length > 0) {
    const sentFigures = new Set(figures(sentence))
    const hits = claimFigures.filter((f) => sentFigures.has(f)).length
    if (hits > 0) score = Math.min(1, score + 0.25 * (hits / claimFigures.length))
  }
  return score
}

/**
 * Detect the stance a sentence takes, given that it is already known to be
 * topically relevant to the claim.
 * @param {string} sentence
 * @returns {'support'|'refute'}
 */
export function stanceOf(sentence) {
  const s = String(sentence ?? '').toLowerCase()
  let neg = 0
  let pos = 0
  for (const cue of NEGATION_CUES) if (s.includes(cue)) neg++
  for (const cue of AFFIRMATION_CUES) if (s.includes(cue)) pos++
  return neg > pos ? 'refute' : 'support'
}

/**
 * Build IDF weights over a document's own sentences.
 * @param {string[]} sents
 * @returns {Map<string, number>}
 */
function buildIdf(sents) {
  /** @type {Map<string, number>} */ const df = new Map()
  for (const s of sents) {
    for (const t of new Set(contentTokens(s))) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const n = Math.max(1, sents.length)
  /** @type {Map<string, number>} */ const idf = new Map()
  for (const [t, d] of df) idf.set(t, Math.log(1 + n / d))
  return idf
}

/**
 * Minimum lexical relevance before a sentence may be quoted as evidence at all.
 * Below this the document genuinely does not address the claim, and the honest
 * answer is NEUTRAL — which the tribunal correctly discards.
 */
export const RELEVANCE_FLOOR = 0.34

/** Relevance at or above which a supporting sentence is treated as full support. */
export const SUPPORT_THRESHOLD = 0.55

/**
 * A deterministic, zero-dependency entailment judge.
 *
 * Contract is identical to the LLM judge: `(claim, doc) => {verdict, quote, score}`
 * where `quote` is verbatim document text. Because the quote is *selected* from
 * the document rather than generated, it always survives the anchoring gate —
 * this judge structurally cannot fabricate a citation.
 *
 * @param {{text:string}} claim
 * @param {{text:string}} doc
 * @returns {{verdict:string, quote:string, score:number}}
 */
export function lexicalJudge(claim, doc) {
  const claimText = String(claim?.text ?? '')
  const docText = String(doc?.text ?? '')
  const sents = sentences(docText)
  if (sents.length === 0 || claimText.length === 0) {
    return { verdict: Verdict.NEUTRAL, quote: '', score: 0 }
  }

  const claimTokens = contentTokens(claimText)
  const claimFigures = figures(claimText)
  const idf = buildIdf(sents)

  let best = ''
  let bestScore = 0
  for (const s of sents) {
    const sc = scoreSentence(claimTokens, s, idf, claimFigures)
    if (sc > bestScore) {
      bestScore = sc
      best = s
    }
  }

  if (bestScore < RELEVANCE_FLOOR) {
    // Honest NEUTRAL: the page does not address this claim.
    return { verdict: Verdict.NEUTRAL, quote: '', score: Number(bestScore.toFixed(3)) }
  }

  const stance = stanceOf(best)
  const verdict =
    stance === 'refute'
      ? Verdict.CONTRADICTED
      : bestScore >= SUPPORT_THRESHOLD
        ? Verdict.SUPPORTED
        : Verdict.PARTIAL

  // Quote is a verbatim slice of the document, capped so a runaway sentence
  // cannot dominate a report.
  return { verdict, quote: best.slice(0, 600), score: Number(bestScore.toFixed(3)) }
}

/**
 * @typedef {object} Capabilities
 * @property {boolean} search      a web-search service is reachable
 * @property {boolean} fetch       page retrieval is possible
 * @property {boolean} llm         a generative model is available for judging/planning
 * @property {'llm'|'lexical'} judgeKind
 * @property {'llm'|'heuristic'} plannerKind
 * @property {boolean} usable      the engine can produce a meaningful result at all
 * @property {string[]} degraded   human-readable list of missing capabilities
 */

/**
 * Report exactly which capabilities are present.
 *
 * Surfacing this is the difference between "the tool is broken" and "the tool
 * told me search is unavailable". A research engine that cannot search must say
 * so loudly instead of returning an empty report.
 *
 * @param {{search:any, llm:any, fetch:any}} probe
 * @returns {Capabilities}
 */
export function describeCapabilities({ search, llm, fetch: canFetch }) {
  const hasSearch = Boolean(search)
  const hasLlm = Boolean(llm)
  const hasFetch = canFetch !== false
  /** @type {string[]} */ const degraded = []
  if (!hasSearch) degraded.push('No web-search service: the engine cannot discover sources.')
  if (!hasLlm) {
    degraded.push(
      'No language model: using the deterministic lexical judge and heuristic planner. ' +
        'Verdicts remain mechanically anchored but decomposition is shallower.',
    )
  }
  if (!hasFetch) degraded.push('No page fetcher: only search snippets can be used as evidence.')
  return {
    search: hasSearch,
    fetch: hasFetch,
    llm: hasLlm,
    judgeKind: hasLlm ? 'llm' : 'lexical',
    plannerKind: hasLlm ? 'llm' : 'heuristic',
    usable: hasSearch,
    degraded,
  }
}
