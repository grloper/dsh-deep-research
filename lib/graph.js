/**
 * @file Kestrel — Evidence knowledge graph and recall (mechanism M5, graph half).
 * @license MIT
 *
 * The store persists claims. This turns them into a *graph* that compounds.
 *
 * Two capabilities:
 *
 *  1. RECALL — before spending a single search, ask what we already know.
 *     Hybrid BM25 + entity overlap, fused with Reciprocal Rank Fusion. Prior
 *     verdicts that are still within their freshness horizon are reused, which
 *     is what makes repeat and adjacent research progressively cheaper.
 *
 *  2. STRUCTURE — entities and relations extracted from verified claims, so
 *     multi-hop questions can traverse ("what connects A to C?") rather than
 *     relying on one lucky similarity match.
 *
 * Deliberately NOT full GraphRAG. The research surveyed puts Microsoft-style
 * community summarization at $0.10–$0.50 and hours of indexing per corpus, with
 * 2–8 s global-search latency — economically absurd for transient web evidence.
 * We build the graph only over CLAIMS THAT WERE ALREADY VERIFIED, which is a
 * tiny, high-value corpus, and keep retrieval lexical and instant.
 */

import { classifyVolatility, isFresh, normalizeClaim } from './store.js'

/** Words carrying no retrieval signal. */
const STOPWORDS = new Set(
  ('a an the and or but if then than that this these those of in on at to for from by with without ' +
    'is are was were be been being has have had do does did will would shall should may might can could ' +
    'it its as not no nor so such about into over under again further once here there when where why how ' +
    'all any both each few more most other some only own same too very s t just don now').split(' '),
)

/**
 * Tokenize for lexical retrieval.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
}

/**
 * Extract candidate entities without an LLM or NER model.
 *
 * Capitalized multi-word runs, acronyms, and numeric-unit pairs. Crude, but it
 * runs in microseconds over already-verified claims and needs no API call.
 * Named entities are the join keys of the graph, not its final truth.
 *
 * @param {string} text
 * @returns {string[]} deduplicated, normalized entity strings
 */
export function extractEntities(text) {
  const s = String(text ?? '')
  /** @type {Set<string>} */ const out = new Set()

  // Capitalized runs (skip a leading sentence-initial single word, which is
  // usually just grammar rather than a name).
  const capRun = /\b([A-Z][\w&.-]*(?:\s+(?:of|and|for|the)?\s*[A-Z][\w&.-]*)*)\b/g
  let m
  while ((m = capRun.exec(s)) !== null) {
    const phrase = m[1].trim()
    const isSentenceStart = m.index === 0 || /[.!?]\s+$/.test(s.slice(Math.max(0, m.index - 2), m.index))
    if (isSentenceStart && !phrase.includes(' ')) continue
    if (phrase.length < 3) continue
    out.add(phrase)
  }

  // Acronyms.
  for (const a of s.match(/\b[A-Z]{2,6}\b/g) ?? []) out.add(a)

  // Quantities with units, which are usually the load-bearing fact.
  for (const q of s.match(/\b\d[\d,.]*\s?(?:%|percent|million|billion|trillion|kg|km|mw|gw|tb|gb)\b/gi) ?? []) {
    out.add(q.trim())
  }

  // Years.
  for (const y of s.match(/\b(?:19|20)\d{2}\b/g) ?? []) out.add(y)

  return [...out]
}

/**
 * BM25 ranking over a claim corpus.
 *
 * Pure lexical and dependency-free. Chosen over embeddings as the DEFAULT
 * because it needs no model download, no API key, and no vector store, while
 * remaining strong on the exact identifiers (names, numbers, dates) that
 * factual recall actually turns on. Embeddings can be layered on later.
 */
export class Bm25Index {
  /**
   * @param {{k1?:number, b?:number}} [opts]
   */
  constructor({ k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1
    this.b = b
    /** @type {Array<{id:string, tokens:string[], len:number, text:string}>} */
    this.docs = []
    /** @type {Map<string, number>} */
    this.df = new Map()
    this.avgLen = 0
  }

  /**
   * @param {string} id
   * @param {string} text
   */
  add(id, text) {
    const tokens = tokenize(text)
    this.docs.push({ id, tokens, len: tokens.length, text })
    for (const t of new Set(tokens)) this.df.set(t, (this.df.get(t) ?? 0) + 1)
    this.avgLen = this.docs.reduce((a, d) => a + d.len, 0) / this.docs.length
    return this
  }

  /**
   * @param {string} query
   * @param {number} [limit=10]
   * @returns {Array<{id:string, score:number, text:string}>}
   */
  search(query, limit = 10) {
    const qTokens = tokenize(query)
    if (qTokens.length === 0 || this.docs.length === 0) return []
    const N = this.docs.length
    /** @type {Array<{id:string,score:number,text:string}>} */ const scored = []

    for (const doc of this.docs) {
      let score = 0
      const tf = new Map()
      for (const t of doc.tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
      for (const q of qTokens) {
        const f = tf.get(q)
        if (!f) continue
        const df = this.df.get(q) ?? 0
        // BM25 IDF with the +1 guard that keeps common terms non-negative.
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
        const denom = f + this.k1 * (1 - this.b + (this.b * doc.len) / (this.avgLen || 1))
        score += idf * ((f * (this.k1 + 1)) / denom)
      }
      if (score > 0) scored.push({ id: doc.id, score, text: doc.text })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit)
  }
}

/**
 * Reciprocal Rank Fusion — merge rankings from different scorers without
 * needing their scores to be on a comparable scale.
 * @param {Array<Array<{id:string}>>} rankings
 * @param {number} [k=60]
 * @returns {Array<{id:string, score:number}>}
 */
export function rrf(rankings, k = 60) {
  /** @type {Map<string, number>} */ const fused = new Map()
  for (const ranking of rankings) {
    ranking.forEach((item, i) => {
      fused.set(item.id, (fused.get(item.id) ?? 0) + 1 / (k + i + 1))
    })
  }
  return [...fused.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
}

/**
 * The evidence knowledge graph built over verified claims.
 */
export class KnowledgeGraph {
  /**
   * @param {import('./store.js').EvidenceStore} [store]
   */
  constructor(store = null) {
    this.store = store
    this.index = new Bm25Index()
    /** @type {Map<string, Set<string>>} entity → claim ids */
    this.entityToClaims = new Map()
    /** @type {Map<string, any>} claim id → claim record */
    this.claims = new Map()
    if (store) this.reload()
  }

  /** Rebuild in-memory structures from the backing store. */
  reload() {
    if (!this.store) return this
    this.index = new Bm25Index()
    this.entityToClaims.clear()
    this.claims.clear()
    for (const row of this.store.find('claims')) this.addClaim(row, false)
    return this
  }

  /**
   * @param {{id:string, text:string, verdict?:string, confidence?:number, ics?:number, last_verified?:number, volatility?:string}} claim
   * @param {boolean} [persist=true]
   */
  addClaim(claim, persist = true) {
    if (!claim?.id || !claim?.text) return this

    // Normalize the in-memory record so freshness works immediately. Callers
    // supply verdict/confidence; last_verified and volatility are derived here
    // rather than only inside the store, otherwise a just-added claim looks
    // stale to recall() until the graph is reloaded from disk.
    const record = {
      ...claim,
      last_verified: claim.last_verified ?? Date.now(),
      volatility: claim.volatility ?? classifyVolatility(claim.text),
    }
    this.claims.set(claim.id, record)
    this.index.add(claim.id, claim.text)
    for (const e of extractEntities(claim.text)) {
      const key = e.toLowerCase()
      if (!this.entityToClaims.has(key)) this.entityToClaims.set(key, new Set())
      this.entityToClaims.get(key).add(claim.id)
    }
    if (persist && this.store) {
      try {
        this.store.putClaim({
          id: claim.id,
          text: claim.text,
          verdict: claim.verdict,
          confidence: claim.confidence,
          ics: claim.ics,
        })
      } catch {
        /* persistence is best-effort */
      }
    }
    return this
  }

  /**
   * Claims sharing an entity with the query — the graph's join operation.
   * @param {string} query
   * @param {number} [limit=10]
   * @returns {Array<{id:string, overlap:number}>}
   */
  entityMatches(query, limit = 10) {
    const qEntities = extractEntities(query).map((e) => e.toLowerCase())
    if (qEntities.length === 0) return []
    /** @type {Map<string, number>} */ const counts = new Map()
    for (const e of qEntities) {
      for (const id of this.entityToClaims.get(e) ?? []) {
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
    }
    return [...counts.entries()]
      .map(([id, overlap]) => ({ id, overlap }))
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, limit)
  }

  /**
   * Hybrid recall: lexical BM25 fused with entity overlap.
   *
   * @param {string} query
   * @param {object} [opts]
   * @param {number} [opts.limit=8]
   * @param {number} [opts.now=Date.now()]
   * @param {boolean} [opts.freshOnly=true] exclude claims past their freshness horizon
   * @returns {Array<{id:string, text:string, verdict:string, confidence:number, fresh:boolean, score:number}>}
   */
  recall(query, opts = {}) {
    const { limit = 8, now = Date.now(), freshOnly = true } = opts
    const lexical = this.index.search(query, limit * 3)
    const entity = this.entityMatches(query, limit * 3)
    const fused = rrf([lexical, entity])

    /** @type {any[]} */ const out = []
    for (const { id, score } of fused) {
      const c = this.claims.get(id)
      if (!c) continue
      const fresh = isFresh({ lastVerified: c.last_verified, volatility: c.volatility }, now)
      if (freshOnly && !fresh) continue
      out.push({
        id,
        text: c.text,
        verdict: c.verdict ?? 'UNVERIFIED',
        confidence: Number(c.confidence ?? 0),
        fresh,
        score,
      })
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * Multi-hop traversal: find a path of shared entities between two concepts.
   * This is the thing plain vector similarity cannot do — connecting A to C
   * when they share no vocabulary but both connect through B.
   *
   * @param {string} from
   * @param {string} to
   * @param {number} [maxHops=3]
   * @returns {string[]} claim ids forming the path, empty when none exists
   */
  connect(from, to, maxHops = 3) {
    const startIds = new Set(this.entityMatches(from, 50).map((m) => m.id))
    const goalIds = new Set(this.entityMatches(to, 50).map((m) => m.id))
    if (startIds.size === 0 || goalIds.size === 0) return []
    for (const id of startIds) if (goalIds.has(id)) return [id] // direct hit

    // BFS over "claims sharing an entity" adjacency.
    /** @type {Map<string,string|null>} */ const parent = new Map()
    /** @type {string[]} */ const queue = []
    for (const id of startIds) {
      parent.set(id, null)
      queue.push(id)
    }
    let depth = 0
    while (queue.length && depth < maxHops) {
      const levelSize = queue.length
      for (let i = 0; i < levelSize; i++) {
        const cur = queue.shift()
        for (const next of this.neighbors(cur)) {
          if (parent.has(next)) continue
          parent.set(next, cur)
          if (goalIds.has(next)) return reconstruct(parent, next)
          queue.push(next)
        }
      }
      depth++
    }
    return []
  }

  /**
   * Claims sharing at least one entity with the given claim.
   * @param {string} claimId
   * @returns {string[]}
   */
  neighbors(claimId) {
    const c = this.claims.get(claimId)
    if (!c) return []
    /** @type {Set<string>} */ const out = new Set()
    for (const e of extractEntities(c.text)) {
      for (const id of this.entityToClaims.get(e.toLowerCase()) ?? []) {
        if (id !== claimId) out.add(id)
      }
    }
    return [...out]
  }

  /** @returns {{claims:number, entities:number}} */
  stats() {
    return { claims: this.claims.size, entities: this.entityToClaims.size }
  }

  /**
   * Export the graph as an Obsidian vault: one note per claim with wiki-links
   * to shared entities, so the accumulated evidence is browsable by a human
   * rather than trapped inside a database.
   * @returns {Array<{path:string, content:string}>}
   */
  toObsidian() {
    /** @type {Array<{path:string, content:string}>} */ const files = []

    for (const [id, c] of this.claims) {
      const entities = extractEntities(c.text)
      const links = entities.map((e) => `[[${sanitize(e)}]]`).join(' · ')
      files.push({
        path: `claims/${sanitize(id)}.md`,
        content:
          `---\nid: ${id}\nverdict: ${c.verdict ?? 'UNVERIFIED'}\n` +
          `confidence: ${c.confidence ?? 0}\nindependent_origins: ${c.ics ?? 0}\n` +
          `volatility: ${c.volatility ?? 'slow'}\ntags: [kestrel, claim]\n---\n\n` +
          `# ${c.text}\n\n` +
          `**Verdict:** ${c.verdict ?? 'UNVERIFIED'} · ` +
          `**Confidence:** ${((Number(c.confidence) || 0) * 100).toFixed(0)}% · ` +
          `**Independent origins:** ${c.ics ?? 0}\n\n` +
          (links ? `## Entities\n${links}\n` : ''),
      })
    }

    for (const [entity, claimIds] of this.entityToClaims) {
      const list = [...claimIds]
        .map((id) => `- [[${sanitize(id)}]] — ${truncate(this.claims.get(id)?.text ?? '', 100)}`)
        .join('\n')
      files.push({
        path: `entities/${sanitize(entity)}.md`,
        content: `---\ntags: [kestrel, entity]\n---\n\n# ${entity}\n\n## Claims\n${list}\n`,
      })
    }

    files.push({
      path: 'INDEX.md',
      content:
        `---\ntags: [kestrel, index]\n---\n\n# Kestrel evidence graph\n\n` +
        `${this.claims.size} verified claims · ${this.entityToClaims.size} entities\n\n` +
        `> Generated from the persistent evidence store. Each claim note records its ` +
        `verdict, calibrated confidence, and how many INDEPENDENT origins support it.\n`,
    })

    return files
  }
}

/**
 * @param {Map<string,string|null>} parent
 * @param {string} end
 * @returns {string[]}
 */
function reconstruct(parent, end) {
  const path = []
  let cur = end
  while (cur !== null && cur !== undefined) {
    path.unshift(cur)
    cur = parent.get(cur)
  }
  return path
}

/** @param {string} s @returns {string} */
function sanitize(s) {
  return String(s).replace(/[\\/:*?"<>|#^[\]]/g, '-').trim().slice(0, 100)
}

/** @param {string} s @param {number} n @returns {string} */
function truncate(s, n) {
  const t = String(s ?? '')
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

export { normalizeClaim }
