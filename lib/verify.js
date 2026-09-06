/**
 * @file VERITAS — Claim verification pipeline (`verify_text`).
 * @license MIT
 *
 * The adoption wedge: paste any AI-generated answer and get every factual claim
 * graded, with receipts, or explicitly marked unverifiable.
 *
 * Composition of the mechanisms built elsewhere in this package:
 *   atomize (LLM)  →  retrieve evidence  →  anchor quotes MECHANICALLY (M1)
 *                  →  entailment verdict →  independence via lineage (M2)
 *                  →  calibrated confidence
 *
 * Every external capability (LLM, search, fetch) is injected, so the pipeline is
 * fully testable offline and the plugin degrades gracefully when a capability is
 * unavailable rather than crashing the host.
 */

import { admitCitations, anchorQuote, contentHash, Verdict } from './anchor.js'
import { assessCredibility } from './credibility.js'
import { analyzeLineage } from './lineage.js'
import { classifyVolatility } from './store.js'

/**
 * @typedef {object} AtomicClaim
 * @property {string} id
 * @property {string} text        self-contained, decontextualized
 * @property {boolean} [checkworthy]
 */

/**
 * @typedef {object} EvidenceDoc
 * @property {string} id
 * @property {string} text
 * @property {string} [url]
 * @property {string} [author]
 * @property {number} [publishedAt]
 * @property {number} [waybackFirstSeen]
 * @property {string[]} [outboundUrls]
 */

/**
 * @typedef {object} ClaimJudgment
 * @property {string} claimId
 * @property {string} claim
 * @property {keyof typeof Verdict} verdict
 * @property {number} confidence            0..1, calibrated (see scoreConfidence)
 * @property {number} ics                   independent corroborating origins
 * @property {number} sourceCount           raw supporting document count
 * @property {Array<{docId:string,url?:string,quote:string,charStart:number,charEnd:number,anchorKind:string,credibility:number}>} citations
 * @property {string[]} notes
 * @property {string} volatility
 */

/** Verdict → base confidence contribution. */
const VERDICT_BASE = {
  [Verdict.SUPPORTED]: 0.72,
  [Verdict.PARTIAL]: 0.45,
  [Verdict.NEUTRAL]: 0.2,
  [Verdict.CONTRADICTED]: 0.08,
  [Verdict.UNVERIFIED]: 0.05,
}

/**
 * Calibrated per-claim confidence.
 *
 * Deliberately NOT the model's self-reported confidence, which research shows is
 * badly miscalibrated and clusters at "very sure". Built instead from signals
 * that empirically track correctness:
 *   - the entailment verdict,
 *   - how many *independent* origins corroborate it (not raw source count),
 *   - the credibility of those sources,
 *   - whether any source contradicts it.
 *
 * @param {object} input
 * @param {keyof typeof Verdict} input.verdict
 * @param {number} input.ics
 * @param {number} input.meanCredibility  0..100
 * @param {boolean} input.contradicted
 * @returns {number} 0..1
 */
export function scoreConfidence({ verdict, ics, meanCredibility, contradicted }) {
  let c = VERDICT_BASE[verdict] ?? 0.05

  // Independent corroboration, with diminishing returns. The jump from 1→2
  // independent origins is worth far more than 5→6.
  if (verdict === Verdict.SUPPORTED || verdict === Verdict.PARTIAL) {
    c += Math.min(0.2, 0.1 * Math.log2(Math.max(1, ics) + 1))
  }

  // Source quality nudges within ±0.1.
  c += ((Math.max(0, Math.min(100, meanCredibility)) - 50) / 50) * 0.1

  // An active contradiction caps confidence hard, regardless of support volume.
  if (contradicted) c = Math.min(c, 0.4)

  return Math.max(0, Math.min(1, Number(c.toFixed(3))))
}

/**
 * Default heuristic atomizer used when no LLM is available.
 * Splits on sentence boundaries and keeps sentences that look like factual
 * assertions. Crude by design — it exists so the pipeline degrades instead of
 * failing, and the LLM atomizer is strongly preferred.
 *
 * @param {string} text
 * @returns {AtomicClaim[]}
 */
export function heuristicAtomize(text) {
  const sentences = String(text ?? '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

  return sentences
    .map((s, i) => ({ id: `c${i + 1}`, text: s, checkworthy: isCheckworthy(s) }))
    .filter((c) => c.checkworthy)
}

/**
 * Does this sentence assert something checkable? Opinions, questions and
 * hedged speculation are not check-worthy and must not be graded as if they were.
 * @param {string} s
 * @returns {boolean}
 */
export function isCheckworthy(s) {
  const t = s.trim()
  if (t.length < 25) return false
  if (t.endsWith('?')) return false
  if (/^(i think|in my opinion|arguably|it depends|perhaps|maybe|consider|let'?s|you should|try)\b/i.test(t)) {
    return false
  }
  // Requires some factual anchor: a number, date, proper noun, or a copula.
  return /\d|\b[A-Z][a-z]{2,}|\b(is|are|was|were|has|have|had|will|reported|announced|found|showed)\b/.test(t)
}

/**
 * @typedef {object} VerifyDeps
 * @property {(text:string)=>Promise<AtomicClaim[]>} [atomize]
 * @property {(claim:AtomicClaim)=>Promise<EvidenceDoc[]>} [gather]
 * @property {(claim:AtomicClaim, doc:EvidenceDoc)=>Promise<{verdict:keyof typeof Verdict, quote:string, score:number}>} [judge]
 */

/**
 * @typedef {object} VerifyReport
 * @property {ClaimJudgment[]} claims
 * @property {number} phantomCitationRate
 * @property {object} totals
 * @property {string} summary
 * @property {string[]} warnings
 */

/**
 * Verify the factual claims in a block of text.
 *
 * @param {string} text
 * @param {VerifyDeps} [deps]
 * @returns {Promise<VerifyReport>}
 */
export async function verifyText(text, deps = {}) {
  const atomize = deps.atomize ?? (async (t) => heuristicAtomize(t))
  const gather = deps.gather ?? (async () => [])
  const judge = deps.judge ?? null

  /** @type {string[]} */ const warnings = []
  const claims = await atomize(text)

  if (claims.length === 0) {
    return {
      claims: [],
      phantomCitationRate: 0,
      totals: { total: 0, supported: 0, contradicted: 0, unverified: 0 },
      summary: 'No check-worthy factual claims were found in the supplied text.',
      warnings,
    }
  }
  if (!judge) {
    warnings.push(
      'No entailment judge was provided — claims can be located in sources but not graded for support.',
    )
  }

  /** @type {ClaimJudgment[]} */ const judgments = []
  let proposedCitations = 0
  let rejectedCitations = 0

  for (const claim of claims) {
    const docs = await gather(claim)
    /** @type {ClaimJudgment['citations']} */ const citations = []
    /** @type {string[]} */ const notes = []
    let contradicted = false
    /** @type {keyof typeof Verdict} */ let verdict = Verdict.UNVERIFIED

    /** @type {EvidenceDoc[]} */ const supporting = []
    const credibilities = []

    for (const doc of docs) {
      if (!judge) continue
      let result
      try {
        result = await judge(claim, doc)
      } catch (err) {
        notes.push(`Judge failed for ${doc.id}: ${err?.message ?? err}`)
        continue
      }
      proposedCitations++

      // MECHANICAL GATE (M1): the quote must actually exist in the document.
      const anchor = anchorQuote(result.quote ?? '', doc.text)
      if (!anchor.ok) {
        rejectedCitations++
        notes.push(`Rejected citation from ${doc.url ?? doc.id}: ${anchor.reason}`)
        continue
      }

      const cred = assessCredibility(doc)
      credibilities.push(cred.score)

      if (result.verdict === Verdict.CONTRADICTED) {
        contradicted = true
        notes.push(`Contradicted by ${doc.url ?? doc.id}.`)
      }
      if (result.verdict === Verdict.SUPPORTED || result.verdict === Verdict.PARTIAL) {
        supporting.push(doc)
        if (verdict !== Verdict.SUPPORTED) verdict = result.verdict
      }

      citations.push({
        docId: doc.id,
        url: doc.url,
        quote: anchor.matchedText ?? result.quote,
        charStart: anchor.charStart,
        charEnd: anchor.charEnd,
        anchorKind: anchor.kind,
        credibility: cred.score,
      })
    }

    // INDEPENDENCE (M2): corroboration is counted in origins, not documents.
    const lineage = analyzeLineage(
      supporting.map((d) => ({
        id: d.id,
        text: d.text,
        url: d.url,
        publishedAt: d.publishedAt,
        waybackFirstSeen: d.waybackFirstSeen,
        outboundUrls: d.outboundUrls,
      })),
    )
    if (lineage.total > lineage.ics) {
      notes.push(lineage.summary)
    }
    if (lineage.circular.length > 0) {
      notes.push('Circular citation detected among supporting sources — corroboration is illusory.')
    }

    if (contradicted && verdict === Verdict.SUPPORTED) verdict = Verdict.PARTIAL
    if (contradicted && supporting.length === 0) verdict = Verdict.CONTRADICTED

    const meanCred = credibilities.length
      ? credibilities.reduce((a, b) => a + b, 0) / credibilities.length
      : 50

    judgments.push({
      claimId: claim.id,
      claim: claim.text,
      verdict,
      confidence: scoreConfidence({ verdict, ics: lineage.ics, meanCredibility: meanCred, contradicted }),
      ics: lineage.ics,
      sourceCount: supporting.length,
      citations,
      notes,
      volatility: classifyVolatility(claim.text),
    })
  }

  const supported = judgments.filter((j) => j.verdict === Verdict.SUPPORTED).length
  const contradictedCount = judgments.filter((j) => j.verdict === Verdict.CONTRADICTED).length
  const unverified = judgments.filter((j) => j.verdict === Verdict.UNVERIFIED).length
  const phantomCitationRate = proposedCitations === 0 ? 0 : rejectedCitations / proposedCitations

  const summary =
    `${judgments.length} check-worthy claims · ` +
    `${supported} supported · ${contradictedCount} contradicted · ${unverified} unverified` +
    (rejectedCitations > 0
      ? ` · ${rejectedCitations} fabricated citation(s) blocked (${(phantomCitationRate * 100).toFixed(0)}%)`
      : '')

  return {
    claims: judgments,
    phantomCitationRate,
    totals: { total: judgments.length, supported, contradicted: contradictedCount, unverified },
    summary,
    warnings,
  }
}

/**
 * Render a verification report as human-readable markdown.
 * @param {VerifyReport} report
 * @returns {string}
 */
export function renderReport(report) {
  const icon = {
    [Verdict.SUPPORTED]: '✅',
    [Verdict.PARTIAL]: '🟡',
    [Verdict.NEUTRAL]: '⚪',
    [Verdict.CONTRADICTED]: '❌',
    [Verdict.UNVERIFIED]: '⚠️',
  }
  const lines = ['# Verification report', '', report.summary, '']
  for (const w of report.warnings) lines.push(`> ⚠️ ${w}`, '')

  for (const j of report.claims) {
    lines.push(`### ${icon[j.verdict] ?? '•'} ${j.verdict} — ${(j.confidence * 100).toFixed(0)}% confidence`)
    lines.push(`> ${j.claim}`, '')
    if (j.sourceCount > 0) {
      lines.push(
        `**Corroboration:** ${j.ics} independent origin${j.ics === 1 ? '' : 's'} ` +
          `across ${j.sourceCount} source${j.sourceCount === 1 ? '' : 's'}`,
      )
    }
    for (const c of j.citations) {
      lines.push(`- [${c.anchorKind}] ${c.url ?? c.docId} (credibility ${c.credibility}/100)`)
      lines.push(`  > "${c.quote}"`)
    }
    for (const n of j.notes) lines.push(`- _${n}_`)
    lines.push('')
  }
  return lines.join('\n')
}

export { Verdict, contentHash, admitCitations }
