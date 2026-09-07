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
 * Consecutive evidence-free rounds tolerated before declaring no-progress.
 * A single flat round is normal: a reformulated query often needs one round to
 * reach a new corner of the corpus.
 */
export const STALL_LIMIT = 2

/**
 * @typedef {object} SubQuestion
 * @property {string} id
 * @property {string} text
 * @property {'open'|'resolved'|'contested'|'exhausted'} status
 * @property {import('./tribunal.js').TribunalVerdict|null} verdict
 * @property {number} attempts
 */

/**
 * Comparison connectives. When a question compares two subjects we want ONE
 * sub-question per subject that still carries the shared predicate, never two
 * severed fragments.
 */
const COMPARISON_SPLIT = /\s+(?:versus|vs\.?|compared to|compared with|or)\s+/i

/**
 * Facet probes appended to a bare question so a single topic still fans out
 * across multiple angles of the corpus.
 *
 * These are deliberately NON-adversarial. Hunting disconfirming evidence is the
 * Tribunal's job: it runs a dedicated prosecutor with its own refutation query
 * templates against EVERY sub-question. Adding a "criticism/counterevidence"
 * facet here would duplicate that work as a separate sub-question which, having
 * no affirmative answer of its own, is then reported as an unresolved gap and
 * drags coverage down — penalising a well-evidenced question for the planner's
 * own phrasing. Each facet must therefore be independently answerable.
 */
const FACETS = Object.freeze([
  (q) => q,
  (q) => `${q} evidence study data`,
  (q) => `${q} official report OR primary source`,
])

/**
 * Fallback decomposition when no planner LLM is available.
 *
 * The previous implementation split on ` and ` / ` vs `, which DESTROYED the
 * question: "Compare Rust and Go for backend services" became
 * `["Compare Rust", "Go for backend services"]` — two corrupted fragments that
 * were then issued verbatim as search queries. Garbage sub-questions produce
 * garbage evidence, which the loop then reports as "unresolved".
 *
 * This version never emits a fragment that has lost its predicate. It either
 * distributes a shared predicate across compared subjects, or fans the intact
 * question out across evidence FACETS (support, counterevidence, consensus) so
 * that even a single-topic question drives a genuinely adversarial search.
 *
 * @param {string} question
 * @param {number} max
 * @returns {string[]}
 */
export function heuristicDecompose(question, max = 6) {
  const q = String(question ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!q) return []
  if (max <= 1) return [q]

  // Multi-sentence / explicitly-listed questions: honour the author's own split.
  const explicit = q
    .split(/(?<=[.?!])\s+|\s*;\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12)
  if (explicit.length > 1) return dedupeStrings(explicit).slice(0, max)

  // Comparison: distribute the shared predicate instead of severing it.
  const cmp = q.split(COMPARISON_SPLIT).map((s) => s.trim())
  if (cmp.length > 1 && cmp.every((s) => s.length > 1)) {
    const distributed = distributePredicate(q, cmp)
    if (distributed.length > 1) return dedupeStrings([q, ...distributed]).slice(0, max)
  }

  // Single intact topic: fan out across evidence facets so one question still
  // yields an adversarial, multi-angle investigation.
  return dedupeStrings(FACETS.map((f) => f(q))).slice(0, max)
}

/**
 * Rebuild full sub-questions from a compared list by re-attaching the trailing
 * predicate (and leading interrogative) to every subject.
 * @param {string} original
 * @param {string[]} parts
 * @returns {string[]}
 */
function distributePredicate(original, parts) {
  // Trailing predicate: the tail of the LAST part beyond its head noun, e.g.
  // "Go for backend services" -> predicate "for backend services".
  const last = parts[parts.length - 1]
  const predMatch = last.match(/\s+((?:for|in|on|at|as|with|during|when|to)\s+.+)$/i)
  const predicate = predMatch ? predMatch[1] : ''
  const lead = original.match(/^((?:which|what|who|how|why|when|where|is|are|does|do|did|compare|should)\b[^A-Z]*?)\s/i)
  const stem = predicate ? last.slice(0, last.length - predicate.length).trim() : last

  const subjects = [...parts.slice(0, -1), stem].map((s) =>
    s.replace(new RegExp('^' + escapeRegex(lead?.[1] ?? '') + '\\s*', 'i'), '').trim(),
  )
  return subjects
    .filter((s) => s.length > 1)
    .map((s) => [s, predicate].filter(Boolean).join(' ').trim())
    .filter((s) => s.length > 3)
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Case-insensitive de-duplication that preserves first-seen order.
 * @param {string[]} list
 * @returns {string[]}
 */
function dedupeStrings(list) {
  const seen = new Set()
  /** @type {string[]} */ const out = []
  for (const item of list) {
    const key = String(item ?? '').trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(String(item).trim())
  }
  return out
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
export function gapQuery(gap, attempt = 0) {
  const variants = GAP_STRATEGIES[gap.strategy] ?? GAP_STRATEGIES.broaden
  // Rotate through reformulations across rounds. Re-issuing an identical query
  // every round guarantees identical results, which the loop would then read as
  // "no progress" and abort — the search must actually change to make progress.
  const pick = variants[Math.min(attempt, variants.length - 1)]
  return pick(gap.text)
}

/**
 * Reformulation ladders per diagnosed weakness. Each successive round moves to a
 * materially different corner of the corpus rather than repeating itself.
 */
export const GAP_STRATEGIES = Object.freeze({
  'seek-independent': [
    (t) => `${t} primary source OR original study OR official filing`,
    (t) => `${t} peer-reviewed OR dataset OR government report`,
    (t) => `${t} independent replication OR corroboration`,
  ],
  'adjudicate-conflict': [
    (t) => `${t} systematic review OR meta-analysis OR consensus`,
    (t) => `${t} why do experts disagree`,
    (t) => `${t} limitations methodology dispute`,
  ],
  'corroborate-refutation': [
    (t) => `${t} correction OR retraction OR rebuttal`,
    (t) => `${t} fact check OR debunked`,
    (t) => `${t} original claim source scrutiny`,
  ],
  strengthen: [
    (t) => `${t} data OR statistics OR report`,
    (t) => `${t} latest figures ${new Date().getUTCFullYear()}`,
    (t) => `${t} quantitative evidence measurement`,
  ],
  broaden: [
    (t) => t,
    (t) => `${t} explained overview background`,
    (t) => `${t} evidence for and against`,
  ],
})

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
  // Capability facts, if the caller probed them. A run with no search service
  // CANNOT produce findings; saying so is the difference between an actionable
  // error and a mysteriously empty report.
  const caps = opts.capabilities ?? null
  if (caps) {
    timeline.push(
      `Capabilities: search=${caps.search ? 'yes' : 'NO'} · judge=${caps.judgeKind} · planner=${caps.plannerKind}.`,
    )
    for (const d of caps.degraded ?? []) timeline.push(`  ⚠️ ${d}`)
    if (caps.usable === false) {
      const blocked = {
        question,
        mode,
        subQuestions: [],
        rounds: 0,
        coverage: 0,
        stopReason: 'unavailable',
        recalled: 0,
        capabilities: caps,
        timeline,
        summary:
          'Research could not run: no web-search capability is available in this session. ' +
          (caps.degraded ?? []).join(' '),
      }
      return blocked
    }
  }

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
  let lastEvidenceCount = 0
  let lastOriginCount = 0
  let stalledRounds = 0
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
      const probe = round === 1 || !gap ? s.text : gapQuery(gap, s.attempts - 1)
      s.attempts++
      try {
        const verdict = await tryClaim(probe, deps.tribunal, { maxPerSide: cfg.perSide })
        // Keep the stronger of old/new evidence rather than overwriting blindly.
        s.verdict = mergeVerdicts(s.verdict, verdict, s.text)
      } catch (err) {
        timeline.push(`  ! ${s.id} failed: ${err?.message ?? err}`)
      }
    }

    // Progress is measured over TOTAL admitted evidence, not just independent
    // origins: a round that adds corroborating documents to an existing origin
    // is still progress and must not be mistaken for a stalled loop.
    const evidenceCount = subs.reduce(
      (a, s) => a + (s.verdict ? s.verdict.support.length + s.verdict.refute.length : 0),
      0,
    )
    const originCount = subs.reduce(
      (a, s) => a + (s.verdict ? s.verdict.supportIcs + s.verdict.refuteIcs : 0),
      0,
    )
    const after = assessCoverage(subs, bar)

    if (after.gaps.length === 0) {
      stopReason = 'resolved'
      timeline.push(`Round ${round}: coverage complete.`)
      break
    }

    const progressed = evidenceCount > lastEvidenceCount || originCount > lastOriginCount
    if (progressed) {
      stalledRounds = 0
    } else {
      stalledRounds++
      timeline.push(
        `Round ${round}: no new admissible evidence (stall ${stalledRounds}/${STALL_LIMIT}).`,
      )
    }
    // Require CONSECUTIVE stalled rounds before quitting. The old check compared
    // against a counter seeded at -1 and bailed after a single flat round, so
    // "deep" (6 rounds) and "forensic" (12) routinely stopped at round 2 having
    // never issued their reformulated follow-up queries.
    if (stalledRounds >= STALL_LIMIT) {
      stopReason = 'no-progress'
      timeline.push(`Round ${round}: ${STALL_LIMIT} consecutive rounds added no evidence. Stopping.`)
      break
    }
    lastEvidenceCount = Math.max(lastEvidenceCount, evidenceCount)
    lastOriginCount = Math.max(lastOriginCount, originCount)
  }

  // Status must agree with the coverage ledger. Previously a sub-question that
  // assessCoverage had diagnosed as a GAP (e.g. only 1 of 2 required independent
  // origins) was still stamped 'resolved' here. The summary then counted it as
  // neither resolved, contested, nor unresolved — printing "0 resolved · 0
  // contested · 0 unresolved" for a question that HAD been investigated. That
  // all-zeros report is exactly the "nothing happened" symptom users hit.
  const ledger = assessCoverage(subs, bar)
  const gapIds = new Set(ledger.gaps.map((g) => g.id))
  for (const s of subs) {
    if (!s.verdict || s.verdict.verdict === Verdict.UNVERIFIED) s.status = 'exhausted'
    else if (s.verdict.contested) s.status = 'contested'
    else if (gapIds.has(s.id)) s.status = 'weak'
    else s.status = 'resolved'
  }

  // Feed everything worth keeping back into the graph, so the next run starts
  // further along than this one did.
  //
  // Store the CANONICAL question, not every search reformulation of it. The
  // planner fans one question into several facet sub-questions ("<q>",
  // "<q> evidence study data", ...); writing each as its own claim stored
  // near-duplicate rows and leaked raw facet suffixes into research_recall, so
  // prior findings read as three copies of one result. The id was also keyed on
  // the sub-question ORDINAL (q1-, q2-), which guaranteed distinct rows for the
  // same underlying claim and made downstream de-duplication impossible.
  if (deps.graph && typeof deps.graph.addClaim === 'function') {
    /** @type {Map<string, import('./tribunal.js').TribunalVerdict>} */
    const best = new Map()
    for (const s of subs) {
      if (!s.verdict || s.verdict.verdict === Verdict.UNVERIFIED) continue
      const text = baseQuestion(s.text, question)
      const prev = best.get(text)
      // Keep the best-evidenced verdict per distinct claim: more independent
      // origins first, then higher confidence.
      if (
        !prev ||
        s.verdict.supportIcs > prev.supportIcs ||
        (s.verdict.supportIcs === prev.supportIcs && s.verdict.confidence > prev.confidence)
      ) {
        best.set(text, s.verdict)
      }
    }
    for (const [text, verdict] of best) {
      try {
        deps.graph.addClaim({
          id: hashText(text),
          text,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          ics: verdict.supportIcs,
        })
      } catch {
        /* graph persistence is best-effort and must never fail a run */
      }
    }
  }

  const final = assessCoverage(subs, bar)
  const tally = (status) => subs.filter((s) => s.status === status).length
  // Every sub-question lands in exactly one bucket, so the counts always sum to
  // the total. 'weak' is reported explicitly instead of vanishing.
  const summary =
    `${subs.length} sub-question(s) · ${tally('resolved')} resolved · ` +
    `${tally('weak')} weakly evidenced · ` +
    `${tally('contested')} contested · ` +
    `${tally('exhausted')} unresolved · ` +
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
    capabilities: caps,
    timeline,
    summary,
  }
}

/**
 * Strip a facet suffix so a search reformulation reports as the question the
 * user actually asked.
 * @param {string} text
 * @param {string} original
 * @returns {string}
 */
export function baseQuestion(text, original) {
  const t = String(text ?? '').trim()
  const orig = String(original ?? '').trim()
  if (orig && t.toLowerCase().startsWith(orig.toLowerCase())) return orig
  return t.replace(/\s+(?:evidence study data|official report OR primary source)$/i, '').trim()
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
  if (r.stopReason === 'unavailable') {
    return [
      `# ${r.question}`,
      '',
      '## ⛔ Research could not run',
      '',
      r.summary,
      '',
      'No findings were produced because the engine had no way to discover sources.',
      'This is a capability problem in the host session, not an empty result set.',
    ].join('\n')
  }

  const lines = [
    `# ${r.question}`,
    '',
    `_${r.summary}_`,
    '',
    '## Findings',
    '',
  ]
  // Facet sub-questions are search REFORMULATIONS of one underlying question, so
  // several of them routinely land on the same evidence set. Rendering each in
  // full produced a report that repeated the same quotes three times, which
  // reads as padding and buries the actual finding. Collapse findings that share
  // an identical evidence set, keeping the strongest verdict as the canonical one.
  const groups = []
  for (const s of r.subQuestions) {
    if (!s.verdict) {
      lines.push('### ⚠️ UNRESOLVED', `> ${s.text}`, '', 'No admissible evidence was found.', '')
      continue
    }
    const fingerprint = [
      ...s.verdict.support.map((e) => `+${e.docId}|${e.quote}`),
      ...s.verdict.refute.map((e) => `-${e.docId}|${e.quote}`),
    ]
      .sort()
      .join('~')
    const existing = groups.find((g) => g.fingerprint === fingerprint)
    if (existing) {
      existing.aliases.push(s.text)
      // Prefer the phrasing whose verdict carries the most confidence.
      if (s.verdict.confidence > existing.sub.verdict.confidence) {
        existing.aliases.push(existing.sub.text)
        existing.aliases = existing.aliases.filter((a) => a !== s.text)
        existing.sub = s
      }
      continue
    }
    groups.push({ fingerprint, sub: s, aliases: [] })
  }

  for (const g of groups) {
    lines.push(renderVerdict(g.sub.verdict), '')
    if (g.aliases.length > 0) {
      lines.push(
        `_Also reached via ${g.aliases.length} equivalent reformulation(s) of this question, ` +
          'which returned the same evidence set._',
        '',
      )
    }
  }

  const weak = r.subQuestions.filter((s) => s.status === 'weak')
  if (weak.length) {
    lines.push('## 🔶 Weakly evidenced', '')
    lines.push('Investigated, but below this mode\'s evidence bar — treat as provisional:', '')
    for (const s of weak) {
      const v = s.verdict
      lines.push(
        `- ${s.text}` +
          (v ? ` — ${v.verdict}, ${v.supportIcs} independent origin(s), ${(v.confidence * 100).toFixed(0)}% confidence` : ''),
      )
    }
    lines.push('')
  }

  // Report the canonical question text, not every search reformulation of it.
  // Listing "Q", "Q evidence study data" and "Q official report OR primary
  // source" as three separate contested points is noise: they are one point.
  const canonical = (list) => {
    const seen = new Set()
    /** @type {string[]} */ const out = []
    for (const s of list) {
      const base = baseQuestion(s.text, r.question)
      const key = base.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(base)
    }
    return out
  }

  const contested = canonical(r.subQuestions.filter((s) => s.status === 'contested'))
  if (contested.length) {
    lines.push('## ⚖️ Contested points', '')
    lines.push('These are reported as disputed rather than resolved:', '')
    for (const t of contested) lines.push(`- ${t}`)
    lines.push('')
  }

  const unresolved = canonical(r.subQuestions.filter((s) => s.status === 'exhausted'))
  if (unresolved.length) {
    lines.push('## ❓ Could not be established', '')
    for (const t of unresolved) lines.push(`- ${t}`)
    lines.push('')
  }

  lines.push('## Research trace', '')
  for (const t of r.timeline) lines.push(`- ${t}`)
  return lines.join('\n')
}
