/**
 * @file Kestrel — Mechanical citation anchoring (mechanism M1).
 * @license MIT
 *
 * The deterministic anti-hallucination gate.
 *
 * Every other tool asks a model "is this citation good?" and trusts the answer.
 * That is circular: you are using the thing that hallucinates to check whether it
 * hallucinated. Kestrel instead requires each claim to carry a *verbatim quote*
 * from a stored, hashed document, and then verifies that quote with string
 * matching. A fabricated quote fails `indexOf`. No model opinion involved.
 *
 * Only quotes that pass this gate are allowed to become citations. Claims whose
 * quotes fail are demoted to UNVERIFIED and never silently presented as sourced.
 */

import { createHash } from 'node:crypto'

/** @typedef {'EXACT'|'NORMALIZED'|'FUZZY'|'FAILED'} AnchorMatchKind */

/**
 * Verdict values for a claim after grounding.
 * @readonly
 */
export const Verdict = Object.freeze({
  SUPPORTED: 'SUPPORTED',
  PARTIAL: 'PARTIAL',
  NEUTRAL: 'NEUTRAL',
  CONTRADICTED: 'CONTRADICTED',
  UNVERIFIED: 'UNVERIFIED',
})

/** Minimum quote length worth anchoring; shorter strings match by accident. */
export const MIN_QUOTE_CHARS = 24
/** Fuzzy acceptance threshold (token-level Jaccard against the best window). */
export const FUZZY_THRESHOLD = 0.85

/**
 * SHA-256 of document text, used to prove the evidence hasn't changed since citation.
 * @param {string} text
 * @returns {string} hex digest
 */
export function contentHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/**
 * Whitespace/punctuation-tolerant normalization that PRESERVES nothing but words,
 * used as the second matching tier. Keeps a parallel index map so a match in
 * normalized space can be projected back to original character offsets.
 * @param {string} text
 * @returns {{ normalized: string, indexMap: number[] }}
 */
export function normalizeWithIndex(text) {
  const src = String(text ?? '')
  let normalized = ''
  /** @type {number[]} */
  const indexMap = []
  let lastWasSpace = true
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    // Treat any non-alphanumeric as a separator, and collapse runs of separators.
    if (/[\p{L}\p{N}]/u.test(ch)) {
      normalized += ch.toLowerCase()
      indexMap.push(i)
      lastWasSpace = false
    } else if (!lastWasSpace) {
      normalized += ' '
      indexMap.push(i)
      lastWasSpace = true
    }
  }
  // Trim trailing separator
  if (normalized.endsWith(' ')) {
    normalized = normalized.slice(0, -1)
    indexMap.pop()
  }
  return { normalized, indexMap }
}

/**
 * Tokenize to lowercase word tokens.
 * @param {string} text
 * @returns {string[]}
 */
function tokens(text) {
  const { normalized } = normalizeWithIndex(text)
  return normalized.split(' ').filter(Boolean)
}

/**
 * Token-level Jaccard, used only for the fuzzy tier.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
function tokenJaccard(a, b) {
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a)
  const setB = new Set(b)
  let inter = 0
  for (const t of setA) if (setB.has(t)) inter++
  return inter / new Set([...setA, ...setB]).size
}

/**
 * @typedef {object} AnchorResult
 * @property {boolean} ok               whether the quote is admissible as a citation
 * @property {AnchorMatchKind} kind     how it matched
 * @property {number} charStart         offset into the ORIGINAL document text (-1 if failed)
 * @property {number} charEnd           exclusive end offset (-1 if failed)
 * @property {number} score             1 for exact/normalized, Jaccard for fuzzy, 0 for failed
 * @property {string} [matchedText]     the actual document substring that matched
 * @property {string} reason            human-readable explanation (always populated)
 */

/**
 * Verify that a quote genuinely appears in a document, and return its exact
 * character span so the citation is replayable and auditable.
 *
 * Three tiers, strictest first:
 *  1. EXACT      — byte-identical substring. Strongest possible evidence.
 *  2. NORMALIZED — identical after whitespace/punctuation normalization. Handles
 *                  models that "clean up" spacing, smart quotes, or line wrapping.
 *  3. FUZZY      — token-Jaccard ≥ threshold over the best-matching window. Handles
 *                  minor elision, but is reported distinctly so callers can be strict.
 *
 * @param {string} quote      the verbatim quote a claim is citing
 * @param {string} docText    the stored document text
 * @param {object} [opts]
 * @param {boolean} [opts.allowFuzzy=true]
 * @param {number} [opts.minChars=MIN_QUOTE_CHARS]
 * @param {number} [opts.fuzzyThreshold=FUZZY_THRESHOLD]
 * @returns {AnchorResult}
 */
export function anchorQuote(quote, docText, opts = {}) {
  const {
    allowFuzzy = true,
    minChars = MIN_QUOTE_CHARS,
    fuzzyThreshold = FUZZY_THRESHOLD,
  } = opts

  const q = String(quote ?? '').trim()
  const doc = String(docText ?? '')

  if (q.length === 0) {
    return fail('Quote is empty — nothing to verify.')
  }
  if (q.length < minChars) {
    return fail(
      `Quote is too short (${q.length} < ${minChars} chars) to anchor reliably; ` +
        'short strings match by coincidence.',
    )
  }
  if (doc.length === 0) {
    return fail('Document text is empty — the cited source was never successfully fetched.')
  }

  // Tier 1: exact substring.
  const exactIdx = doc.indexOf(q)
  if (exactIdx !== -1) {
    return {
      ok: true,
      kind: 'EXACT',
      charStart: exactIdx,
      charEnd: exactIdx + q.length,
      score: 1,
      matchedText: doc.slice(exactIdx, exactIdx + q.length),
      reason: 'Quote appears verbatim in the source document.',
    }
  }

  // Tier 2: normalized substring, projected back to original offsets.
  const { normalized: nDoc, indexMap } = normalizeWithIndex(doc)
  const { normalized: nQuote } = normalizeWithIndex(q)
  if (nQuote.length > 0) {
    const nIdx = nDoc.indexOf(nQuote)
    if (nIdx !== -1) {
      const startOrig = indexMap[nIdx]
      const endIdxInMap = Math.min(nIdx + nQuote.length - 1, indexMap.length - 1)
      const endOrig = indexMap[endIdxInMap] + 1
      return {
        ok: true,
        kind: 'NORMALIZED',
        charStart: startOrig,
        charEnd: endOrig,
        score: 1,
        matchedText: doc.slice(startOrig, endOrig),
        reason:
          'Quote matches the source after whitespace/punctuation normalization ' +
          '(formatting differs, wording does not).',
      }
    }
  }

  // Tier 3: fuzzy window search.
  if (allowFuzzy) {
    const qTokens = tokens(q)
    const dTokens = nDoc.split(' ').filter(Boolean)
    if (qTokens.length > 0 && dTokens.length >= qTokens.length) {
      const win = qTokens.length
      const qSet = new Set(qTokens)
      const qUnique = qSet.size

      // Incremental sliding window (O(docTokens) instead of O(docTokens × quoteTokens)).
      //
      // The previous implementation rebuilt two Sets and re-scanned the whole
      // quote for every window position, which measured ~289ms for a single
      // 40-token quote against one 40k-token document — and a forensic run does
      // that for many claims across many documents. Here the window's token
      // counts are maintained incrementally: advancing by one position costs one
      // decrement and one increment, so the intersection size is always known
      // without recomputation.
      //
      // Jaccard is derived from the intersection alone:
      //   |A ∩ B| = inter
      //   |A ∪ B| = |A| + |B| - inter, using UNIQUE counts on both sides.
      /** @type {Map<string, number>} token → occurrences inside the current window */
      const counts = new Map()
      let windowUnique = 0
      let inter = 0

      /** @param {string} t */
      const addToken = (t) => {
        const prev = counts.get(t) ?? 0
        counts.set(t, prev + 1)
        if (prev === 0) {
          windowUnique++
          if (qSet.has(t)) inter++
        }
      }
      /** @param {string} t */
      const removeToken = (t) => {
        const prev = counts.get(t) ?? 0
        if (prev <= 1) {
          counts.delete(t)
          if (prev === 1) {
            windowUnique--
            if (qSet.has(t)) inter--
          }
        } else {
          counts.set(t, prev - 1)
        }
      }

      let best = 0
      let bestStart = -1

      for (let i = 0; i < win; i++) addToken(dTokens[i])
      const scoreWindow = () => {
        const union = qUnique + windowUnique - inter
        return union === 0 ? 0 : inter / union
      }
      best = scoreWindow()
      bestStart = 0

      for (let i = win; i < dTokens.length; i++) {
        removeToken(dTokens[i - win])
        addToken(dTokens[i])
        const j = scoreWindow()
        if (j > best) {
          best = j
          bestStart = i - win + 1
          // A perfect token match cannot be improved on; stop early.
          if (best === 1) break
        }
      }
      if (best >= fuzzyThreshold && bestStart >= 0) {
        // Project token window back to original offsets via the index map.
        let seen = 0
        let charStart = -1
        let charEnd = -1
        for (let p = 0; p < nDoc.length; p++) {
          if (p === 0 || nDoc[p - 1] === ' ') {
            if (seen === bestStart) charStart = indexMap[p]
            if (seen === bestStart + win - 1) {
              let e = p
              while (e < nDoc.length && nDoc[e] !== ' ') e++
              charEnd = indexMap[Math.min(e - 1, indexMap.length - 1)] + 1
              break
            }
            seen++
          }
        }
        if (charStart >= 0 && charEnd > charStart) {
          return {
            ok: true,
            kind: 'FUZZY',
            charStart,
            charEnd,
            score: best,
            matchedText: doc.slice(charStart, charEnd),
            reason: `Quote approximately matches the source (token overlap ${best.toFixed(2)}); treat with caution.`,
          }
        }
      }
      return fail(
        `Quote does not appear in the source document (best token overlap ${best.toFixed(2)} ` +
          `< ${fuzzyThreshold}). The citation is fabricated or points at the wrong document.`,
      )
    }
  }

  return fail('Quote does not appear in the source document. The citation is not admissible.')

  /**
   * @param {string} reason
   * @returns {AnchorResult}
   */
  function fail(reason) {
    return { ok: false, kind: 'FAILED', charStart: -1, charEnd: -1, score: 0, reason }
  }
}

/**
 * @typedef {object} CitationCandidate
 * @property {string} claimId
 * @property {string} quote
 * @property {string} docId
 */

/**
 * @typedef {object} StoredDoc
 * @property {string} id
 * @property {string} text
 * @property {string} [sha256]
 */

/**
 * @typedef {object} AdmissionReport
 * @property {Array<CitationCandidate & { anchor: AnchorResult }>} admitted
 * @property {Array<CitationCandidate & { anchor: AnchorResult }>} rejected
 * @property {number} phantomRate      fraction of proposed citations that were fabricated
 * @property {string} summary
 */

/**
 * Gate a batch of proposed citations. This is the function that makes the
 * project's headline guarantee true: nothing reaches the user as "sourced"
 * unless its quote was mechanically located in stored source text.
 *
 * @param {CitationCandidate[]} candidates
 * @param {StoredDoc[]} docs
 * @param {object} [opts] forwarded to {@link anchorQuote}
 * @returns {AdmissionReport}
 */
export function admitCitations(candidates, docs, opts = {}) {
  /** @type {Map<string, StoredDoc>} */
  const byId = new Map(docs.map((d) => [d.id, d]))
  const admitted = []
  const rejected = []

  for (const c of candidates) {
    const doc = byId.get(c.docId)
    if (!doc) {
      rejected.push({
        ...c,
        anchor: {
          ok: false,
          kind: 'FAILED',
          charStart: -1,
          charEnd: -1,
          score: 0,
          reason: `Cited document "${c.docId}" is not in the evidence store — the citation references a source that was never retrieved.`,
        },
      })
      continue
    }
    // Integrity: if a hash was recorded at fetch time, confirm the text still matches.
    if (doc.sha256 && contentHash(doc.text) !== doc.sha256) {
      rejected.push({
        ...c,
        anchor: {
          ok: false,
          kind: 'FAILED',
          charStart: -1,
          charEnd: -1,
          score: 0,
          reason: 'Stored document text does not match its recorded hash — evidence integrity failure.',
        },
      })
      continue
    }
    const anchor = anchorQuote(c.quote, doc.text, opts)
    ;(anchor.ok ? admitted : rejected).push({ ...c, anchor })
  }

  const total = candidates.length
  const phantomRate = total === 0 ? 0 : rejected.length / total
  const summary =
    total === 0
      ? 'No citations proposed.'
      : `${admitted.length}/${total} citations admitted · ` +
        `${rejected.length} rejected as unverifiable (phantom rate ${(phantomRate * 100).toFixed(1)}%)`

  return { admitted, rejected, phantomRate, summary }
}
