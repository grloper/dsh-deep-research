/**
 * @file Kestrel — The Tribunal: adversarial claim adjudication (mechanism M3).
 * @license MIT
 *
 * Kills confirmation bias by making refutation a REQUIRED pipeline stage rather
 * than an emergent behaviour we hope for.
 *
 * Every research agent surveyed (GPT-Researcher, STORM, dzhng, Firesearch)
 * seeds its queries from the hypothesis, so it only ever finds support. A claim
 * that is wrong but popular sails straight through. Here, three roles run
 * against every load-bearing claim:
 *
 *   PROSECUTOR  — must actively hunt disconfirming evidence. Its queries are
 *                 adversarial by construction, not by prompt-politeness.
 *   DEFENDER    — assembles the strongest supporting evidence, preferring
 *                 primary sources.
 *   ADJUDICATOR — weighs both sides using INDEPENDENT origin counts and source
 *                 credibility, and records dissent instead of smoothing it away.
 *
 * The adjudicator is deliberately mechanical, not another LLM call: it applies
 * stated rules to already-verified evidence. That keeps the final verdict
 * auditable and reproducible.
 */

import { Verdict } from './anchor.js'
import { analyzeLineage } from './lineage.js'
import { scoreConfidence } from './verify.js'

/**
 * Query templates that force the search AWAY from the hypothesis.
 * Kept as data so they can be inspected, extended and tested.
 */
export const REFUTATION_TEMPLATES = Object.freeze([
  (c) => `${c} debunked`,
  (c) => `${c} false OR misleading OR incorrect`,
  (c) => `${c} retracted OR correction OR withdrawn`,
  (c) => `${c} failed to replicate`,
  (c) => `criticism of ${c}`,
  (c) => `evidence against ${c}`,
])

/** Query templates that seek the strongest possible support. */
export const SUPPORT_TEMPLATES = Object.freeze([
  (c) => c,
  (c) => `"${c}" study OR report OR filing`,
  (c) => `${c} primary source OR original`,
])

/**
 * Build the adversarial query set for a claim.
 * @param {string} claimText
 * @param {object} [opts]
 * @param {number} [opts.maxPerSide=3]
 * @returns {{ support: string[], refute: string[] }}
 */
export function buildQueries(claimText, opts = {}) {
  const { maxPerSide = 3 } = opts
  const c = String(claimText ?? '').replace(/\s+/g, ' ').trim()
  if (!c) return { support: [], refute: [] }
  return {
    support: SUPPORT_TEMPLATES.slice(0, maxPerSide).map((f) => f(c)),
    refute: REFUTATION_TEMPLATES.slice(0, maxPerSide).map((f) => f(c)),
  }
}

/**
 * @typedef {object} SideEvidence
 * @property {string} docId
 * @property {string} [url]
 * @property {string} quote
 * @property {number} credibility
 * @property {boolean} isPrimary
 * @property {number} [publishedAt]
 * @property {string} text
 */

/**
 * @typedef {object} TribunalVerdict
 * @property {string} claim
 * @property {keyof typeof Verdict} verdict
 * @property {number} confidence
 * @property {number} supportIcs           independent origins supporting
 * @property {number} refuteIcs            independent origins refuting
 * @property {SideEvidence[]} support
 * @property {SideEvidence[]} refute
 * @property {string[]} dissent            recorded minority position, never discarded
 * @property {string[]} reasoning          the adjudication rules that fired
 * @property {boolean} contested
 */

/**
 * Adjudicate a claim from evidence already gathered and verified by both sides.
 *
 * Mechanical and rule-based on purpose. Every branch appends to `reasoning`, so
 * the verdict can be audited without re-running any model.
 *
 * @param {object} input
 * @param {string} input.claim
 * @param {SideEvidence[]} input.support
 * @param {SideEvidence[]} input.refute
 * @returns {TribunalVerdict}
 */
export function adjudicate({ claim, support = [], refute = [] }) {
  /** @type {string[]} */ const reasoning = []
  /** @type {string[]} */ const dissent = []

  const supportLineage = analyzeLineage(
    support.map((e) => ({ id: e.docId, text: e.text, url: e.url, publishedAt: e.publishedAt })),
  )
  const refuteLineage = analyzeLineage(
    refute.map((e) => ({ id: e.docId, text: e.text, url: e.url, publishedAt: e.publishedAt })),
  )

  const supportIcs = supportLineage.ics
  const refuteIcs = refuteLineage.ics

  if (support.length > supportIcs) {
    reasoning.push(
      `Supporting evidence: ${supportLineage.summary} — corroboration counted in origins, not documents.`,
    )
  }
  if (refute.length > refuteIcs) {
    reasoning.push(`Refuting evidence: ${refuteLineage.summary}`)
  }

  // Weight each side by independence AND source quality. A single primary
  // source outweighs a pile of syndicated blog posts.
  const weigh = (side, ics) => {
    if (side.length === 0) return 0
    const meanCred = side.reduce((a, e) => a + (e.credibility ?? 50), 0) / side.length
    const primaryBonus = side.some((e) => e.isPrimary) ? 1.25 : 1
    return ics * (meanCred / 50) * primaryBonus
  }
  const supportWeight = weigh(support, supportIcs)
  const refuteWeight = weigh(refute, refuteIcs)

  /** @type {keyof typeof Verdict} */
  let verdict
  let contested = false

  if (support.length === 0 && refute.length === 0) {
    verdict = Verdict.UNVERIFIED
    reasoning.push('No admissible evidence was found on either side.')
  } else if (refuteWeight > supportWeight * 1.5) {
    verdict = Verdict.CONTRADICTED
    reasoning.push(
      `Refuting evidence decisively outweighs support (${refuteWeight.toFixed(2)} vs ${supportWeight.toFixed(2)}).`,
    )
    if (support.length > 0) {
      contested = true
      for (const e of support) {
        dissent.push(`Supporting view retained from ${e.url ?? e.docId}: "${truncate(e.quote, 160)}"`)
      }
    }
  } else if (supportWeight > refuteWeight * 1.5) {
    if (refute.length > 0) {
      contested = true
      verdict = Verdict.PARTIAL
      reasoning.push(
        `Support outweighs refutation (${supportWeight.toFixed(2)} vs ${refuteWeight.toFixed(2)}), ` +
          'but credible disagreement exists, so the claim is not reported as settled.',
      )
      for (const e of refute) {
        dissent.push(`Dissent from ${e.url ?? e.docId}: "${truncate(e.quote, 160)}"`)
      }
    } else {
      verdict = Verdict.SUPPORTED
      reasoning.push(
        `Support is uncontested across ${supportIcs} independent origin${supportIcs === 1 ? '' : 's'}; ` +
          'an explicit search for disconfirming evidence found none.',
      )
    }
  } else if (support.length > 0 && refute.length > 0) {
    verdict = Verdict.PARTIAL
    contested = true
    reasoning.push(
      `Evidence is genuinely divided (${supportWeight.toFixed(2)} vs ${refuteWeight.toFixed(2)}). ` +
        'Reported as contested rather than resolved.',
    )
    for (const e of refute) dissent.push(`Dissent from ${e.url ?? e.docId}: "${truncate(e.quote, 160)}"`)
  } else if (support.length > 0) {
    verdict = supportIcs >= 2 ? Verdict.SUPPORTED : Verdict.PARTIAL
    reasoning.push(
      supportIcs >= 2
        ? `Supported by ${supportIcs} independent origins.`
        : 'Only one independent origin supports this claim — reported as partial, not settled.',
    )
  } else {
    verdict = Verdict.CONTRADICTED
    reasoning.push('Only refuting evidence was found.')
  }

  // Single-origin support is never "settled", however many copies exist.
  if (verdict === Verdict.SUPPORTED && supportIcs < 2) {
    verdict = Verdict.PARTIAL
    reasoning.push(
      'Downgraded to PARTIAL: a single independent origin cannot corroborate itself, ' +
        'regardless of how many outlets republished it.',
    )
  }

  const meanCred = [...support, ...refute].length
    ? [...support, ...refute].reduce((a, e) => a + (e.credibility ?? 50), 0) / (support.length + refute.length)
    : 50

  const confidence = scoreConfidence({
    verdict,
    ics: supportIcs,
    meanCredibility: meanCred,
    contradicted: refute.length > 0,
  })

  return {
    claim,
    verdict,
    confidence,
    supportIcs,
    refuteIcs,
    support,
    refute,
    dissent,
    reasoning,
    contested,
  }
}

/**
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
function truncate(s, n) {
  const t = String(s ?? '')
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

/**
 * @typedef {object} TribunalDeps
 * @property {(query:string)=>Promise<any[]>} gather   fetch+extract docs for a query
 * @property {(claim:{text:string}, doc:any)=>Promise<{verdict:string,quote:string,score:number}>} judge
 * @property {(quote:string, docText:string)=>{ok:boolean,matchedText?:string}} anchor
 * @property {(doc:any)=>{score:number,isPrimary:boolean}} credibility
 */

/**
 * Run the full adversarial process for one claim.
 *
 * Both sides gather independently so neither can suppress the other's evidence,
 * and every piece of evidence must survive mechanical quote anchoring (M1)
 * before it is allowed to influence the verdict.
 *
 * @param {string} claimText
 * @param {TribunalDeps} deps
 * @param {object} [opts]
 * @param {number} [opts.maxPerSide=3]
 * @returns {Promise<TribunalVerdict>}
 */
export async function tryClaim(claimText, deps, opts = {}) {
  const queries = buildQueries(claimText, opts)
  const claim = { text: claimText }

  /**
   * @param {string[]} qs
   * @param {'support'|'refute'} side
   * @returns {Promise<SideEvidence[]>}
   */
  const runSide = async (qs, side) => {
    /** @type {Map<string, any>} */ const docs = new Map()
    for (const q of qs) {
      let found = []
      try {
        found = await deps.gather(q)
      } catch {
        continue
      }
      for (const d of found) if (d?.id && !docs.has(d.id)) docs.set(d.id, d)
    }

    /** @type {SideEvidence[]} */ const out = []
    for (const doc of docs.values()) {
      let judged
      try {
        judged = await deps.judge(claim, doc)
      } catch {
        continue
      }
      // Only evidence pointing the RIGHT way counts for this side.
      const wants =
        side === 'support'
          ? judged.verdict === Verdict.SUPPORTED || judged.verdict === Verdict.PARTIAL
          : judged.verdict === Verdict.CONTRADICTED
      if (!wants) continue

      const anchored = deps.anchor(judged.quote ?? '', doc.text ?? '')
      if (!anchored.ok) continue // M1: unanchored evidence never influences a verdict

      const cred = deps.credibility(doc)
      out.push({
        docId: doc.id,
        url: doc.url,
        quote: anchored.matchedText ?? judged.quote,
        credibility: cred.score,
        isPrimary: Boolean(cred.isPrimary),
        publishedAt: doc.publishedAt,
        text: doc.text ?? '',
      })
    }
    return out
  }

  const [support, refute] = await Promise.all([
    runSide(queries.support, 'support'),
    runSide(queries.refute, 'refute'),
  ])

  return adjudicate({ claim: claimText, support, refute })
}

/**
 * Render a tribunal verdict as markdown, dissent included.
 * @param {TribunalVerdict} v
 * @returns {string}
 */
export function renderVerdict(v) {
  const icon = {
    [Verdict.SUPPORTED]: '✅',
    [Verdict.PARTIAL]: '🟡',
    [Verdict.NEUTRAL]: '⚪',
    [Verdict.CONTRADICTED]: '❌',
    [Verdict.UNVERIFIED]: '⚠️',
  }[v.verdict]

  const lines = [
    `### ${icon} ${v.verdict}${v.contested ? ' (contested)' : ''} — ${(v.confidence * 100).toFixed(0)}% confidence`,
    `> ${v.claim}`,
    '',
    `**Independent origins:** ${v.supportIcs} supporting · ${v.refuteIcs} refuting`,
    '',
  ]
  if (v.support.length) {
    lines.push('**Supporting evidence**')
    for (const e of v.support) lines.push(`- ${e.url ?? e.docId} (${e.credibility}/100)\n  > "${e.quote}"`)
    lines.push('')
  }
  if (v.refute.length) {
    lines.push('**Refuting evidence**')
    for (const e of v.refute) lines.push(`- ${e.url ?? e.docId} (${e.credibility}/100)\n  > "${e.quote}"`)
    lines.push('')
  }
  if (v.dissent.length) {
    lines.push('**Recorded dissent**')
    for (const d of v.dissent) lines.push(`- ${d}`)
    lines.push('')
  }
  lines.push('**Adjudication**')
  for (const r of v.reasoning) lines.push(`- ${r}`)
  return lines.join('\n')
}
