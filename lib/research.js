/**
 * @file Kestrel — Adaptive multi-round research loop.
 * @license MIT
 *
 * The orchestrator that turns a question into an audited answer.
 *
 * Existing agents run a fixed breadth/depth recursion and stop when a counter
 * runs out, which either burns budget on a question already answered or quits
 * while major gaps remain. This loop is driven by an explicit **coverage
 * ledger**: every round it measures which sub-questions are answered, at what
 * confidence, backed by how many INDEPENDENT origins — and only issues follow-up
 * queries targeted at the specific weaknesses found.
 *
 * Stop conditions are explicit and reported, never silent:
 *   - resolved      : every sub-question is settled at or above the bar
 *   - no-progress   : a full round added no new independent evidence
 *   - budget        : round/fetch ceiling reached
 *
 * The loop is capability-injected throughout, so it is fully testable offline.
 */

import { Verdict } from './anchor.js'
import { adjudicate, tryClaim } from './tribunal.js'

/** Research depth presets (Critique Pass 1: complexity must be opt-in per query). */
export const MODES = Object.freeze({
  quick: { rounds: 1, maxSubQuestions: 3, perSide: 1, minIcs: 1, minConfidence: 0.5 },
  standard: { rounds: 3, maxSubQuestions: 6, perSide: 2, minIcs: 2, minConfidence: 0.65 },
  deep: { rounds: 6, maxSubQuestions: 12, perSide: 3, minIcs: 2, minConfidence: 0.75 },
  forensic: { rounds: 12, maxSubQuestions: 20, perSide: 4, minIcs: 3, minConfidence: 0.8 },
})

/**
 * @typedef {object} SubQuestion
 * @property {string} id
 * @property {string} text
 * @property {'open'|'resolved'|'contested'|'exhausted'} status
 * @property {import('./tribunal.js').TribunalVerdict|null} verdict
 * @property {number} attempts
 */

/**
 * Fallback decomposition when no planner LLM is available.
 * Crude but honest: it keeps the loop functional rather than failing outright.
 * @param {string} question
 * @param {number} max
 * @returns {string[]}
 */
export function heuristicDecompose(question, max = 6) {
  const q = String(question ?? '').trim()
  if (!q) return []
  const parts = q
    .split(/\s+(?:and|versus|vs\.?|compared to|as well as)\s+|[;?]/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 8)
  const out = parts.length > 1 ? parts : [q]
  return out.slice(0, max)
}

/**
 * Measure how well the current evidence answers the question.
 *
 * This is what makes the loop *adaptive*: follow-up work is aimed at the
 * specific deficiency (no evidence / too few independent origins / unresolved
 * contradiction), not at a generic "search more".
 *
 * @param {SubQuestion[]} subs
 * @param {{minIcs:number, minConfidence:number}} bar
 * @returns {{ coverage:number, resolved:number, gaps:Array<{id:string,text:string,reason:string,strategy:string}> }}
 */
export function assessCoverage(subs, bar) {
  /** @type {Array<{id:string,text:string,reason:string,strategy:string}>} */
  const gaps = []
  let resolved = 0

  for (const s of subs) {
    const v = s.verdict
    if (!v || v.verdict === Verdict.UNVERIFIED) {
      gaps.push({
        id: s.id,
        text: s.text,
        reason: 'No admissible evidence found yet.',
        strategy: 'broaden',
      })
      continue
    }
    if (v.verdict === Verdict.CONTRADICTED) {
      // A well-evidenced refutation is a real answer, not a gap.
      if (v.refuteIcs >= bar.minIcs) {
        resolved++
        continue
      }
      gaps.push({
        id: s.id,
        text: s.text,
        reason: `Refuted by only ${v.refuteIcs} independent origin(s).`,
        strategy: 'corroborate-refutation',
      })
      continue
    }
    if (v.contested) {
      gaps.push({
        id: s.id,
        text: s.text,
        reason: 'Sources genuinely disagree; the disagreement is unresolved.',
        strategy: 'adjudicate-conflict',
      })
      continue
    }
    if (v.supportIcs < bar.minIcs) {
      gaps.push({
        id: s.id,
        text: s.text,
        reason: `Only ${v.supportIcs} independent origin(s); ${bar.minIcs} required.`,
        strategy: 'seek-independent',
      })
      continue
    }
    if (v.confidence < bar.minConfidence) {
      gaps.push({
        id: s.id,
        text: s.text,
        reason: `Confidence ${(v.confidence * 100).toFixed(0)}% below the ${(bar.minConfidence * 100).toFixed(0)}% bar.`,
        strategy: 'strengthen',
      })
      continue
    }
    resolved++
  }

  return { coverage: subs.length === 0 ? 0 : resolved / subs.length, resolved, gaps }
}

/**
 * Turn a diagnosed gap into a targeted follow-up query.
 * @param {{text:string, strategy:string}} gap
 * @returns {string}
 */
export function gapQuery(gap) {
  switch (gap.strategy) {
    case 'seek-independent':
      return `${gap.text} primary source OR original study OR official filing`
    case 'adjudicate-conflict':
      return `${gap.text} systematic review OR meta-analysis OR consensus`
    case 'corroborate-refutation':
      return `${gap.text} correction OR retraction OR rebuttal`
    case 'strengthen':
      return `${gap.text} data OR statistics OR report`
    case 'broaden':
    default:
      return gap.text
  }
}

/**
 * @typedef {object} ResearchDeps
 * @property {(q:string)=>Promise<string[]>} [decompose]
 * @property {import('./tribunal.js').TribunalDeps} tribunal
 * @property {{recall:(q:string,opts?:any)=>Array<{text:string,verdict:string,confidence:number}>, addClaim:(c:any)=>void}} [graph]
 */

/**
 * @typedef {object} ResearchResult
 * @property {string} question
 * @property {string} mode
 * @property {SubQuestion[]} subQuestions
 * @property {number} rounds
 * @property {number} coverage
 * @property {'resolved'|'no-progress'|'budget'} stopReason
 * @property {string[]} timeline
 * @property {string} summary
 */

/**
 * Run the adaptive research loop.
 *
 * @param {string} question
 * @param {ResearchDeps} deps
 * @param {object} [opts]
 * @param {keyof typeof MODES} [opts.mode='standard']
 * @returns {Promise<ResearchResult>}
 */
export async function research(question, deps, opts = {}) {
  const mode = MODES[opts.mode] ? opts.mode : 'standard'
  const cfg = MODES[mode]
  /** @type {string[]} */ const timeline = []

  const decompose = deps.decompose ?? (async (q) => heuristicDecompose(q, cfg.maxSubQuestions))
  let texts = []
  try {
    texts = await decompose(question)
  } catch {
    texts = heuristicDecompose(question, cfg.maxSubQuestions)
  }
  if (texts.length === 0) texts = heuristicDecompose(question, cfg.maxSubQuestions)

  /** @type {SubQuestion[]} */
  const subs = texts.slice(0, cfg.maxSubQuestions).map((t, i) => ({
    id: `q${i + 1}`,
    text: t,
    status: 'open',
    verdict: null,
    attempts: 0,
  }))
  timeline.push(`Decomposed into ${subs.length} sub-question(s).`)

  const bar = { minIcs: cfg.minIcs, minConfidence: cfg.minConfidence }
  /** @type {'resolved'|'no-progress'|'budget'} */ let stopReason = 'budget'
  let rounds = 0
  let lastEvidenceCount = -1
  let recalled = 0

  // STAGE 1 — RECALL. Before spending a single search, ask what we already
  // verified. This is what makes repeat and adjacent research progressively
  // cheaper instead of starting from zero every time.
  if (deps.graph && typeof deps.graph.recall === 'function') {
    for (const s of subs) {
      let hits = []
      try {
        hits = deps.graph.recall(s.text, { limit: 3 }) ?? []
      } catch {
        hits = []
      }
      const strong = hits.find((h) => h.confidence >= cfg.minConfidence && h.verdict !== 'UNVERIFIED')
      if (strong) {
        recalled++
        s.priorKnowledge = strong
        timeline.push(
          `  ↺ ${s.id}: reusing a prior verification (${strong.verdict}, ` +
            `${(strong.confidence * 100).toFixed(0)}%) from the evidence graph.`,
        )
      }
    }
    if (recalled > 0) {
      timeline.push(`Recall: ${recalled}/${subs.length} sub-question(s) had reusable prior findings.`)
    }
  }

  for (let round = 1; round <= cfg.rounds; round++) {
    rounds = round
    const { gaps } = assessCoverage(subs, bar)
    const targets =
      round === 1 ? subs : subs.filter((s) => gaps.some((g) => g.id === s.id))

    if (targets.length === 0) {
      stopReason = 'resolved'
      timeline.push(`Round ${round}: all sub-questions met the evidence bar. Stopping.`)
      break
    }

    timeline.push(`Round ${round}: investigating ${targets.length} open sub-question(s).`)

    for (const s of targets) {
      const gap = gaps.find((g) => g.id === s.id)
      // Later rounds ask a *different* question, aimed at the diagnosed weakness.
      const probe = round === 1 || !gap ? s.text : gapQuery(gap)
      s.attempts++
      try {
        const verdict = await tryClaim(probe, deps.tribunal, { maxPerSide: cfg.perSide })
        // Keep the stronger of old/new evidence rather than overwriting blindly.
        s.verdict = mergeVerdicts(s.verdict, verdict, s.text)
      } catch (err) {
        timeline.push(`  ! ${s.id} failed: ${err?.message ?? err}`)
      }
    }

    const evidenceCount = subs.reduce(
      (a, s) => a + (s.verdict ? s.verdict.supportIcs + s.verdict.refuteIcs : 0),
      0,
    )
    const after = assessCoverage(subs, bar)

    if (after.gaps.length === 0) {
      stopReason = 'resolved'
      timeline.push(`Round ${round}: coverage complete.`)
      break
    }
    if (evidenceCount === lastEvidenceCount && round > 1) {
      stopReason = 'no-progress'
      timeline.push(`Round ${round}: no new independent evidence surfaced. Stopping early.`)
      break
    }
    lastEvidenceCount = evidenceCount
  }

  for (const s of subs) {
    if (!s.verdict || s.verdict.verdict === Verdict.UNVERIFIED) s.status = 'exhausted'
    else if (s.verdict.contested) s.status = 'contested'
    else s.status = 'resolved'
  }

  // Feed everything worth keeping back into the graph, so the next run starts
  // further along than this one did.
  if (deps.graph && typeof deps.graph.addClaim === 'function') {
    for (const s of subs) {
      if (!s.verdict || s.verdict.verdict === Verdict.UNVERIFIED) continue
      try {
        deps.graph.addClaim({
          id: s.id + '-' + hashText(s.text),
          text: s.text,
          verdict: s.verdict.verdict,
          confidence: s.verdict.confidence,
          ics: s.verdict.supportIcs,
        })
      } catch {
        /* graph persistence is best-effort and must never fail a run */
      }
    }
  }

  const final = assessCoverage(subs, bar)
  const summary =
    `${subs.length} sub-question(s) · ${final.resolved} resolved · ` +
    `${subs.filter((s) => s.status === 'contested').length} contested · ` +
    `${subs.filter((s) => s.status === 'exhausted').length} unresolved · ` +
    `${rounds} round(s) · stopped: ${stopReason}` +
    (recalled > 0 ? ` · ${recalled} reused from evidence graph` : '')

  return {
    question,
    mode,
    subQuestions: subs,
    rounds,
    coverage: final.coverage,
    stopReason,
    recalled,
    timeline,
    summary,
  }
}

/**
 * Stable short hash for claim ids.
 * @param {string} s
 * @returns {string}
 */
function hashText(s) {
  let h = 2166136261
  const str = String(s ?? '')
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/**
 * Combine an earlier verdict with a newer one, keeping all distinct evidence.
 * Re-adjudicates from the union so a later round can overturn an earlier call.
 * @param {import('./tribunal.js').TribunalVerdict|null} prev
 * @param {import('./tribunal.js').TribunalVerdict} next
 * @param {string} claim
 * @returns {import('./tribunal.js').TribunalVerdict}
 */
export function mergeVerdicts(prev, next, claim) {
  if (!prev) return next
  const dedupe = (arr) => {
    const seen = new Set()
    return arr.filter((e) => {
      const k = `${e.docId}|${e.quote}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }
  return adjudicate({
    claim,
    support: dedupe([...prev.support, ...next.support]),
    refute: dedupe([...prev.refute, ...next.refute]),
  })
}

/**
 * Render the research result as an auditable markdown report.
 * @param {ResearchResult} r
 * @param {(v:any)=>string} renderVerdict
 * @returns {string}
 */
export function renderResearch(r, renderVerdict) {
  const lines = [
    `# ${r.question}`,
    '',
    `_${r.summary}_`,
    '',
    '## Findings',
    '',
  ]
  for (const s of r.subQuestions) {
    if (s.verdict) {
      lines.push(renderVerdict(s.verdict), '')
    } else {
      lines.push(`### ⚠️ UNRESOLVED`, `> ${s.text}`, '', 'No admissible evidence was found.', '')
    }
  }

  const contested = r.subQuestions.filter((s) => s.status === 'contested')
  if (contested.length) {
    lines.push('## ⚖️ Contested points', '')
    lines.push('These are reported as disputed rather than resolved:', '')
    for (const s of contested) lines.push(`- ${s.text}`)
    lines.push('')
  }

  const unresolved = r.subQuestions.filter((s) => s.status === 'exhausted')
  if (unresolved.length) {
    lines.push('## ❓ Could not be established', '')
    for (const s of unresolved) lines.push(`- ${s.text}`)
    lines.push('')
  }

  lines.push('## Research trace', '')
  for (const t of r.timeline) lines.push(`- ${t}`)
  return lines.join('\n')
}
