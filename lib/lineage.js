/**
 * @file Kestrel — Independence & copy-lineage analysis (mechanism M2).
 * @license MIT
 *
 * The single most important idea in this project.
 *
 * Every other research tool treats "12 sources say X" as strong evidence. Usually it
 * isn't: it's one press release and eleven syndications. This module reconstructs the
 * copy-lineage DAG over a document set and reports how many *genuinely independent*
 * origins exist — the Independent Corroboration Score (ICS).
 *
 * Pipeline:
 *   text → normalize → k-shingles → MinHash signature → LSH banding → candidate pairs
 *        → exact Jaccard + shared-quote detection → directed edges (older → newer)
 *        → SCC detection (circular reporting) → transitive reduction → roots = ICS
 *
 * Pure computation: no network, no LLM, no native dependencies. Deterministic and
 * therefore testable — which is the entire point.
 */

import { createHash } from 'node:crypto'

/** Jaccard at/above this ⇒ verbatim syndication (wire copy). */
export const T_SYNDICATION = 0.85
/** Jaccard at/above this (but below syndication) ⇒ derivative/spun reporting. */
export const T_DERIVATION = 0.40
/** A shared verbatim run of at least this many chars ⇒ quote propagation. */
export const T_QUOTE_CHARS = 50

const DEFAULT_NUM_HASHES = 128
const DEFAULT_BANDS = 16

/**
 * Normalize text for comparison: lowercase, strip punctuation/markup noise, collapse
 * whitespace. Deliberately aggressive — we are detecting copying, not judging style.
 * @param {string} text
 * @returns {string}
 */
export function normalizeForCompare(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Build word-level k-shingles.
 * @param {string} text
 * @param {number} [k=3]
 * @returns {string[]} unique shingles (order irrelevant for Jaccard)
 */
export function shingles(text, k = 3) {
  const tokens = normalizeForCompare(text).split(' ').filter(Boolean)
  if (tokens.length === 0) return []
  if (tokens.length < k) return [tokens.join(' ')]
  const out = new Set()
  for (let i = 0; i <= tokens.length - k; i++) {
    out.add(tokens.slice(i, i + k).join(' '))
  }
  return [...out]
}

/**
 * Deterministic 32-bit hash of a shingle under a given seed.
 * SHA-256 keyed by seed keeps the hash family independent without shipping a
 * hand-rolled universal-hash implementation.
 * @param {string} shingle
 * @param {number} seed
 * @returns {number}
 */
function hashShingle(shingle, seed) {
  return createHash('sha256').update(`${seed}\u0000${shingle}`).digest().readUInt32LE(0)
}

/**
 * Compute a MinHash signature.
 * @param {string[]} shingleList
 * @param {number} [numHashes=128]
 * @returns {Uint32Array} signature (0xffffffff-filled when input is empty)
 */
export function minhashSignature(shingleList, numHashes = DEFAULT_NUM_HASHES) {
  const sig = new Uint32Array(numHashes).fill(0xffffffff)
  for (const sh of shingleList) {
    for (let i = 0; i < numHashes; i++) {
      const h = hashShingle(sh, i)
      if (h < sig[i]) sig[i] = h
    }
  }
  return sig
}

/**
 * Estimate Jaccard similarity from two MinHash signatures.
 * @param {Uint32Array} a
 * @param {Uint32Array} b
 * @returns {number} 0..1
 */
export function signatureJaccard(a, b) {
  if (a.length !== b.length || a.length === 0) return 0
  let match = 0
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) match++
  return match / a.length
}

/**
 * Exact Jaccard over shingle sets. Used to confirm LSH candidates, because MinHash
 * estimation error near a decision threshold would otherwise mislabel syndication.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number} 0..1
 */
export function exactJaccard(a, b) {
  if (a.length === 0 && b.length === 0) return 1
  if (a.length === 0 || b.length === 0) return 0
  const setB = new Set(b)
  let inter = 0
  for (const x of new Set(a)) if (setB.has(x)) inter++
  const union = new Set([...a, ...b]).size
  return union === 0 ? 0 : inter / union
}

/**
 * Locality-sensitive hashing index over MinHash signatures.
 * Documents colliding in any band become candidate near-duplicates, turning an
 * O(n²) comparison into something tractable.
 */
export class LshIndex {
  /**
   * @param {number} [numHashes=128]
   * @param {number} [bands=16]
   */
  constructor(numHashes = DEFAULT_NUM_HASHES, bands = DEFAULT_BANDS) {
    if (numHashes % bands !== 0) {
      throw new Error(`numHashes (${numHashes}) must be divisible by bands (${bands})`)
    }
    this.numHashes = numHashes
    this.bands = bands
    this.rows = numHashes / bands
    /** @type {Map<string, Set<string>>} */
    this.buckets = new Map()
    /** @type {Map<string, Uint32Array>} */
    this.signatures = new Map()
  }

  /**
   * @param {string} docId
   * @param {Uint32Array} signature
   */
  add(docId, signature) {
    this.signatures.set(docId, signature)
    for (let b = 0; b < this.bands; b++) {
      const key = this.#bandKey(b, signature)
      let bucket = this.buckets.get(key)
      if (!bucket) this.buckets.set(key, (bucket = new Set()))
      bucket.add(docId)
    }
  }

  /**
   * @param {number} band
   * @param {Uint32Array} signature
   * @returns {string}
   */
  #bandKey(band, signature) {
    const slice = signature.subarray(band * this.rows, (band + 1) * this.rows)
    return `${band}:${Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString('hex')}`
  }

  /**
   * Candidate near-duplicates of a document already added to the index.
   * @param {string} docId
   * @returns {Set<string>} excludes docId itself
   */
  candidates(docId) {
    const sig = this.signatures.get(docId)
    const out = new Set()
    if (!sig) return out
    for (let b = 0; b < this.bands; b++) {
      const bucket = this.buckets.get(this.#bandKey(b, sig))
      if (!bucket) continue
      for (const other of bucket) if (other !== docId) out.add(other)
    }
    return out
  }
}

/**
 * Longest shared verbatim substring length between two normalized texts, computed
 * over word-run hashing (cheap approximation of a suffix-automaton LCS).
 *
 * We only need "is there a shared run ≥ T_QUOTE_CHARS", so we binary-search run
 * lengths in words rather than computing the true LCS.
 * @param {string} a
 * @param {string} b
 * @returns {string|null} the longest shared run found, or null
 */
export function longestSharedQuote(a, b) {
  const wa = normalizeForCompare(a).split(' ').filter(Boolean)
  const wb = normalizeForCompare(b).split(' ').filter(Boolean)
  if (wa.length === 0 || wb.length === 0) return null

  /** @param {number} n */
  const runsOf = (words, n) => {
    const s = new Map()
    for (let i = 0; i + n <= words.length; i++) {
      const run = words.slice(i, i + n).join(' ')
      if (!s.has(run)) s.set(run, i)
    }
    return s
  }

  let lo = 1
  let hi = Math.min(wa.length, wb.length)
  /** @type {string|null} */
  let best = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const setA = runsOf(wa, mid)
    let found = null
    for (const [run] of runsOf(wb, mid)) {
      if (setA.has(run)) {
        found = run
        break
      }
    }
    if (found) {
      best = found
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

/**
 * @typedef {object} LineageDoc
 * @property {string} id
 * @property {string} text                 full extracted text
 * @property {string} [url]
 * @property {string} [domain]
 * @property {number} [publishedAt]        epoch ms — earliest trustworthy publish time
 * @property {number} [waybackFirstSeen]   epoch ms — archive.org CDX first capture
 * @property {string[]} [outboundUrls]     links found in the document
 */

/**
 * @typedef {object} LineageEdge
 * @property {string} from   older/origin document id
 * @property {string} to     newer/derivative document id
 * @property {'syndication'|'derivation'|'quote'|'citation'} kind
 * @property {number} score
 * @property {string} [quote]
 */

/**
 * Effective origin timestamp: the earliest defensible time this text existed.
 * Publishers routinely rewrite `datePublished`, so the archive's first sighting is
 * used as a corroborating lower bound.
 * @param {LineageDoc} doc
 * @returns {number} epoch ms (Infinity when unknown, so undated docs never win rootship)
 */
export function originTime(doc) {
  const candidates = [doc.publishedAt, doc.waybackFirstSeen].filter(
    (t) => typeof t === 'number' && Number.isFinite(t) && t > 0,
  )
  return candidates.length ? Math.min(...candidates) : Number.POSITIVE_INFINITY
}

/**
 * Tarjan strongly-connected components. Any component of size > 1 is a circular
 * citation loop — the structural signature of citation laundering / citogenesis.
 * @param {string[]} nodes
 * @param {Map<string, string[]>} adj
 * @returns {string[][]} components with size > 1
 */
export function stronglyConnectedComponents(nodes, adj) {
  let index = 0
  /** @type {Map<string, number>} */ const idx = new Map()
  /** @type {Map<string, number>} */ const low = new Map()
  /** @type {Set<string>} */ const onStack = new Set()
  /** @type {string[]} */ const stack = []
  /** @type {string[][]} */ const out = []

  /** @param {string} v */
  const strongConnect = (v) => {
    idx.set(v, index)
    low.set(v, index)
    index++
    stack.push(v)
    onStack.add(v)
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        strongConnect(w)
        low.set(v, Math.min(low.get(v), low.get(w)))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), idx.get(w)))
      }
    }
    if (low.get(v) === idx.get(v)) {
      /** @type {string[]} */ const comp = []
      for (;;) {
        const w = stack.pop()
        onStack.delete(w)
        comp.push(w)
        if (w === v) break
      }
      if (comp.length > 1) out.push(comp)
    }
  }

  for (const n of nodes) if (!idx.has(n)) strongConnect(n)
  return out
}

/**
 * @typedef {object} LineageResult
 * @property {LineageEdge[]} edges
 * @property {string[]} roots                    independent origin document ids
 * @property {number} ics                        Independent Corroboration Score
 * @property {number} total                      documents considered
 * @property {string[][]} circular                circular-citation components
 * @property {Map<string, string>} originOf       docId → its lineage root id
 * @property {string} summary                    human-readable one-liner
 */

/**
 * Build the copy-lineage DAG over a document set and compute the ICS.
 *
 * @param {LineageDoc[]} docs
 * @param {object} [opts]
 * @param {number} [opts.numHashes=128]
 * @param {number} [opts.bands=16]
 * @param {number} [opts.shingleK=3]
 * @returns {LineageResult}
 */
export function analyzeLineage(docs, opts = {}) {
  const { numHashes = DEFAULT_NUM_HASHES, bands = DEFAULT_BANDS, shingleK = 3 } = opts
  const total = docs.length
  if (total === 0) {
    return {
      edges: [],
      roots: [],
      ics: 0,
      total: 0,
      circular: [],
      originOf: new Map(),
      summary: 'No documents to analyze.',
    }
  }

  // 1. Signatures + LSH candidate generation.
  const lsh = new LshIndex(numHashes, bands)
  /** @type {Map<string, string[]>} */ const shingleCache = new Map()
  /** @type {Map<string, LineageDoc>} */ const byId = new Map()
  for (const d of docs) {
    byId.set(d.id, d)
    const sh = shingles(d.text, shingleK)
    shingleCache.set(d.id, sh)
    lsh.add(d.id, minhashSignature(sh, numHashes))
  }

  // 2. Confirm candidates with exact Jaccard, orient by origin time.
  /** @type {LineageEdge[]} */ const edges = []
  /** @type {Set<string>} */ const seenPair = new Set()
  const urlToId = new Map()
  for (const d of docs) if (d.url) urlToId.set(normalizeUrl(d.url), d.id)

  for (const d of docs) {
    for (const otherId of lsh.candidates(d.id)) {
      const pairKey = d.id < otherId ? `${d.id}|${otherId}` : `${otherId}|${d.id}`
      if (seenPair.has(pairKey)) continue
      seenPair.add(pairKey)

      const other = byId.get(otherId)
      if (!other) continue
      const j = exactJaccard(shingleCache.get(d.id), shingleCache.get(otherId))
      if (j < T_DERIVATION) continue

      const [older, newer] = originTime(d) <= originTime(other) ? [d, other] : [other, d]
      if (originTime(older) === originTime(newer)) {
        // Undated or simultaneous: record as an undirected derivation using stable
        // id order so the result stays deterministic, but never claim a direction
        // we cannot defend.
        edges.push({
          from: older.id < newer.id ? older.id : newer.id,
          to: older.id < newer.id ? newer.id : older.id,
          kind: j >= T_SYNDICATION ? 'syndication' : 'derivation',
          score: j,
        })
        continue
      }
      edges.push({
        from: older.id,
        to: newer.id,
        kind: j >= T_SYNDICATION ? 'syndication' : 'derivation',
        score: j,
      })
    }
  }

  // 3. Quote-propagation edges (catch partial lifting that Jaccard misses).
  for (let i = 0; i < docs.length; i++) {
    for (let k = i + 1; k < docs.length; k++) {
      const a = docs[i]
      const b = docs[k]
      const pairKey = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
      if (seenPair.has(pairKey)) continue
      const quote = longestSharedQuote(a.text, b.text)
      if (!quote || quote.length < T_QUOTE_CHARS) continue
      seenPair.add(pairKey)
      const [older, newer] = originTime(a) <= originTime(b) ? [a, b] : [b, a]
      edges.push({ from: older.id, to: newer.id, kind: 'quote', score: quote.length, quote })
    }
  }

  // 4. Explicit citation edges: a document linking to another in the set.
  for (const d of docs) {
    for (const raw of d.outboundUrls ?? []) {
      const targetId = urlToId.get(normalizeUrl(raw))
      if (targetId && targetId !== d.id) {
        edges.push({ from: targetId, to: d.id, kind: 'citation', score: 1 })
      }
    }
  }

  // 5. Circular reporting detection.
  /** @type {Map<string, string[]>} */ const adj = new Map()
  for (const d of docs) adj.set(d.id, [])
  for (const e of edges) adj.get(e.from)?.push(e.to)
  const circular = stronglyConnectedComponents(
    docs.map((d) => d.id),
    adj,
  )

  // 6. Roots via the CONDENSATION graph. Collapsing each strongly-connected
  //    component to a single node turns the lineage graph into a DAG whose source
  //    nodes are exactly the independent origins. This is what makes a citation
  //    loop count once instead of once per participant — two outlets citing each
  //    other are one origin, not two.
  /** @type {Map<string, string>} */ const componentOf = new Map()
  for (const comp of circular) {
    const rep = [...comp].sort()[0]
    for (const id of comp) componentOf.set(id, rep)
  }
  for (const d of docs) if (!componentOf.has(d.id)) componentOf.set(d.id, d.id)

  /** @type {Map<string, number>} */ const compInDegree = new Map()
  for (const rep of new Set(componentOf.values())) compInDegree.set(rep, 0)
  for (const e of edges) {
    const fromComp = componentOf.get(e.from)
    const toComp = componentOf.get(e.to)
    if (fromComp === toComp) continue // intra-component edge carries no direction
    compInDegree.set(toComp, (compInDegree.get(toComp) ?? 0) + 1)
  }
  const allRoots = [...compInDegree.entries()]
    .filter(([, deg]) => deg === 0)
    .map(([rep]) => rep)
    .sort()

  // 7. Map every document to its lineage root (BFS from each root).
  /** @type {Map<string, string>} */ const originOf = new Map()
  for (const r of allRoots) {
    const queue = [r]
    while (queue.length) {
      const cur = queue.shift()
      if (originOf.has(cur)) continue
      originOf.set(cur, r)
      for (const nxt of adj.get(cur) ?? []) if (!originOf.has(nxt)) queue.push(nxt)
    }
  }
  for (const d of docs) if (!originOf.has(d.id)) originOf.set(d.id, d.id)

  const ics = allRoots.length
  const collapsed = total - ics
  const summary =
    collapsed > 0 || circular.length > 0
      ? `${total} sources → ${ics} independent origin${ics === 1 ? '' : 's'}` +
        (collapsed > 0 ? ` (${collapsed} derivative/syndicated)` : '') +
        (circular.length > 0 ? ` · ${circular.length} circular-citation loop(s) detected` : '')
      : `${total} source${total === 1 ? '' : 's'}, all independent`

  return { edges, roots: allRoots, ics, total, circular, originOf, summary }
}

/**
 * Normalize a URL for identity comparison (drop protocol, www, trailing slash,
 * tracking params, fragment).
 * @param {string} raw
 * @returns {string}
 */
export function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw))
    u.hash = ''
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref|referrer|source)/i.test(p)) u.searchParams.delete(p)
    }
    const host = u.hostname.replace(/^www\./i, '')
    const path = u.pathname.replace(/\/+$/, '')
    const qs = u.searchParams.toString()
    return `${host}${path}${qs ? `?${qs}` : ''}`.toLowerCase()
  } catch {
    return String(raw).trim().toLowerCase()
  }
}
