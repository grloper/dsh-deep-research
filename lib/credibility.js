/**
 * @file VERITAS — Source credibility signals, slop detection, primary-source
 * identification (mechanism M4, adjudication half).
 * @license MIT
 *
 * DESIGN CONSTRAINT — read before changing anything here.
 *
 * This module can defame a legitimate publisher. That is the single worst failure
 * mode in the whole project, so it is constrained by four hard rules:
 *
 *  1. NEVER a black box. Every score decomposes into named signals with reasons.
 *  2. NEVER a hard block. This returns signals; the caller decides. Downweight,
 *     don't silence.
 *  3. NEVER applied to primary sources. A court filing, an RFC, a peer-reviewed
 *     paper and a government dataset are exempt from stylistic "slop" scoring —
 *     technical and legal prose trips every naive AI-text heuristic there is.
 *  4. NEVER penalize non-native English. Formulaic transitions ("In conclusion",
 *     "Furthermore") are normal ESL academic register. They are worth almost
 *     nothing on their own and are weighted accordingly.
 *
 * We ship only permissively-licensed reputation data (Iffy CC BY 4.0, Tranco,
 * DOAJ, Crossref). NewsGuard / MBFC / Ad Fontes are proprietary and are never
 * bundled or scraped.
 */

/** @typedef {'primary'|'peer-reviewed'|'official'|'reference'|'news'|'trade'|'blog'|'forum'|'aggregator'|'unknown'} SourceKind */

/**
 * @typedef {object} Signal
 * @property {string} id        stable identifier
 * @property {string} label     human-readable
 * @property {number} weight    contribution to the score, positive or negative
 * @property {string} reason    why this fired — always shown to the user
 */

/**
 * Structured identifiers that prove a document IS the primary record rather than
 * reporting about one. Detection here grants slop-exemption, so patterns must be
 * precise rather than generous.
 */
export const PRIMARY_PATTERNS = Object.freeze([
  { id: 'doi', label: 'DOI', re: /\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+\b/ },
  { id: 'arxiv', label: 'arXiv', re: /\barXiv:\s*\d{4}\.\d{4,5}(?:v\d+)?\b/i },
  { id: 'pmid', label: 'PubMed', re: /\bPMID:?\s*\d{7,8}\b/i },
  { id: 'pmc', label: 'PubMed Central', re: /\bPMC\d{6,8}\b/ },
  { id: 'rfc', label: 'IETF RFC', re: /\bRFC\s?\d{1,5}\b/ },
  { id: 'ecli', label: 'ECLI court ref', re: /\bECLI:[A-Z]{2}:[A-Za-z0-9.]+:\d{4}:[A-Za-z0-9.]+\b/ },
  { id: 'nct', label: 'ClinicalTrials.gov', re: /\bNCT\d{8}\b/ },
  { id: 'isbn', label: 'ISBN', re: /\bISBN(?:-1[03])?:?\s*(?:97[89][- ]?)?[\d- ]{9,13}[\dXx]\b/ },
])

/** Host patterns that indicate an official / primary publisher. */
export const PRIMARY_HOST_PATTERNS = Object.freeze([
  { id: 'sec', label: 'SEC EDGAR filing', re: /(^|\.)sec\.gov$/i, kind: 'primary' },
  { id: 'govuk', label: 'UK government', re: /(^|\.)gov\.uk$/i, kind: 'official' },
  { id: 'gov', label: 'Government domain', re: /(^|\.)gov$/i, kind: 'official' },
  { id: 'mil', label: 'Military domain', re: /(^|\.)mil$/i, kind: 'official' },
  { id: 'europa', label: 'EU institution', re: /(^|\.)europa\.eu$/i, kind: 'official' },
  { id: 'edu', label: 'Academic institution', re: /(^|\.)edu$/i, kind: 'reference' },
  { id: 'acuk', label: 'UK academic', re: /(^|\.)ac\.uk$/i, kind: 'reference' },
  { id: 'arxiv', label: 'arXiv preprint server', re: /(^|\.)arxiv\.org$/i, kind: 'primary' },
  { id: 'pubmed', label: 'PubMed / NCBI', re: /(^|\.)(ncbi\.nlm\.nih\.gov|pubmed\.gov)$/i, kind: 'peer-reviewed' },
  { id: 'doiorg', label: 'DOI resolver', re: /(^|\.)doi\.org$/i, kind: 'peer-reviewed' },
  { id: 'nature', label: 'Nature Portfolio', re: /(^|\.)nature\.com$/i, kind: 'peer-reviewed' },
  { id: 'science', label: 'Science / AAAS', re: /(^|\.)science\.org$/i, kind: 'peer-reviewed' },
  { id: 'ietf', label: 'IETF', re: /(^|\.)(ietf\.org|rfc-editor\.org)$/i, kind: 'primary' },
  { id: 'w3c', label: 'W3C', re: /(^|\.)w3\.org$/i, kind: 'primary' },
  { id: 'courtlistener', label: 'CourtListener', re: /(^|\.)courtlistener\.com$/i, kind: 'primary' },
  { id: 'github', label: 'Source repository', re: /(^|\.)github\.com$/i, kind: 'primary' },
])

/** Hosts that are aggregators/wires — legitimate, but never independent origins. */
export const WIRE_HOSTS = Object.freeze([
  /(^|\.)prnewswire\.com$/i,
  /(^|\.)businesswire\.com$/i,
  /(^|\.)globenewswire\.com$/i,
  /(^|\.)newswire\.ca$/i,
  /(^|\.)einpresswire\.com$/i,
  /(^|\.)accesswire\.com$/i,
])

/** Attribution phrasing that marks a document as reporting on someone else's work. */
const ATTRIBUTION_RE =
  /\b(according to|as reported by|reported by|in a statement|told reporters|cited by|per a report|sources said|spokesperson (?:said|confirmed)|first reported)\b/gi

/**
 * Stylistic markers correlated with low-effort generated filler.
 * Individually near-worthless — deliberately low weights. Only a PILE of them,
 * combined with structural absence (no author, no date, no references), is
 * treated as meaningful.
 */
const SLOP_PHRASES = [
  /\bin conclusion\b/gi,
  /\bit(?:'| i)s (?:important|worth) (?:to note|noting)\b/gi,
  /\bdelve[sd]? into\b/gi,
  /\ba testament to\b/gi,
  /\bbeacon of\b/gi,
  /\brich tapestry\b/gi,
  /\bnavigating the (?:complex )?landscape\b/gi,
  /\bin today(?:'|\u2019)s (?:fast-paced|digital) world\b/gi,
  /\bunlock(?:ing)? the (?:power|potential|secrets)\b/gi,
  /\bas an ai language model\b/gi,
  /\bmy knowledge cutoff\b/gi,
]

/** Affiliate/monetization link markers. */
const AFFILIATE_RE = /[?&](tag|aff(?:_?id)?|subid|ref|partner|hop|irclickid|awc)=/i

/**
 * Extract the registrable-ish host from a URL.
 * @param {string} url
 * @returns {string} lowercase hostname, or '' when unparseable
 */
export function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

/**
 * @typedef {object} PrimaryAssessment
 * @property {boolean} isPrimary
 * @property {SourceKind} kind
 * @property {string[]} identifiers   which structured identifiers were found
 * @property {string[]} reasons
 */

/**
 * Decide whether a document is a primary/official record.
 *
 * This gates slop-exemption, so it errs toward NOT declaring primary unless a
 * structured identifier or an authoritative host is present.
 *
 * @param {object} doc
 * @param {string} [doc.url]
 * @param {string} [doc.text]
 * @returns {PrimaryAssessment}
 */
export function assessPrimary(doc) {
  const url = doc?.url ?? ''
  const text = doc?.text ?? ''
  const host = hostOf(url)
  /** @type {string[]} */ const identifiers = []
  /** @type {string[]} */ const reasons = []
  /** @type {SourceKind} */ let kind = 'unknown'
  let isPrimary = false

  for (const p of PRIMARY_HOST_PATTERNS) {
    if (host && p.re.test(host)) {
      kind = /** @type {SourceKind} */ (p.kind)
      isPrimary = p.kind === 'primary' || p.kind === 'official' || p.kind === 'peer-reviewed'
      reasons.push(`Host is ${p.label}.`)
      break
    }
  }

  for (const p of PRIMARY_PATTERNS) {
    if (p.re.test(text) || p.re.test(url)) {
      identifiers.push(p.id)
      reasons.push(`Contains a ${p.label} identifier.`)
    }
  }
  if (identifiers.length > 0 && !isPrimary) {
    // Carrying an identifier is weaker than being the publisher of record: a news
    // article citing a DOI is still secondary. Only upgrade when the host is not
    // an obvious news/blog outlet.
    if (kind === 'unknown' || kind === 'reference') {
      isPrimary = true
      if (kind === 'unknown') kind = 'primary'
      reasons.push('Structured identifier present without a secondary-publisher host.')
    }
  }

  if (WIRE_HOSTS.some((re) => re.test(host))) {
    kind = 'aggregator'
    isPrimary = false
    reasons.push('Press-wire distributor: carries primary text but is not an independent origin.')
  }

  if (kind === 'unknown') {
    const attributions = (text.match(ATTRIBUTION_RE) ?? []).length
    const words = text.split(/\s+/).filter(Boolean).length || 1
    const density = (attributions / words) * 1000
    if (density > 1.5) {
      kind = 'news'
      reasons.push(
        `High attribution density (${density.toFixed(1)}/1k words) — reports on other sources rather than being one.`,
      )
    }
  }

  return { isPrimary, kind, identifiers, reasons }
}

/**
 * @typedef {object} SlopAssessment
 * @property {number} score        0..100, higher = more likely low-effort/generated
 * @property {Signal[]} signals
 * @property {boolean} exempt      true when skipped because the source is primary
 * @property {string} summary
 */

/**
 * Score low-quality / machine-generated filler characteristics.
 *
 * Returns SIGNALS, not a verdict. Deliberately conservative: the maximum any
 * single stylistic marker contributes is small, because the false-positive cost
 * (accusing a real journalist or an ESL author) is far worse than the
 * false-negative cost (letting one slop page through to be outvoted later).
 *
 * @param {object} doc
 * @param {string} [doc.text]
 * @param {string} [doc.url]
 * @param {string} [doc.author]
 * @param {number|null} [doc.publishedAt]
 * @param {string[]} [doc.outboundUrls]
 * @param {PrimaryAssessment} [primary] pass the result of assessPrimary to enable exemption
 * @returns {SlopAssessment}
 */
export function assessSlop(doc, primary) {
  /** @type {Signal[]} */ const signals = []
  const text = doc?.text ?? ''
  const words = text.split(/\s+/).filter(Boolean).length

  if (primary?.isPrimary) {
    return {
      score: 0,
      signals: [],
      exempt: true,
      summary: 'Exempt: primary/official source — stylistic heuristics are not applied.',
    }
  }
  if (words < 120) {
    return {
      score: 0,
      signals: [],
      exempt: true,
      summary: 'Exempt: document too short to assess reliably.',
    }
  }

  // --- Stylistic markers (individually weak on purpose) -------------------
  let phraseHits = 0
  for (const re of SLOP_PHRASES) phraseHits += (text.match(re) ?? []).length
  if (phraseHits >= 3) {
    const weight = Math.min(12, phraseHits * 2)
    signals.push({
      id: 'filler-phrases',
      label: 'Formulaic filler phrasing',
      weight,
      reason: `${phraseHits} stock transition/filler phrases. Weak signal on its own — common in ESL and marketing prose.`,
    })
  }

  // --- Sentence-length uniformity (burstiness) ---------------------------
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0)
  if (sentences.length >= 8) {
    const lens = sentences.map((s) => s.split(/\s+/).filter(Boolean).length)
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length
    const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0
    if (cv < 0.2) {
      signals.push({
        id: 'low-burstiness',
        label: 'Unnaturally uniform sentence length',
        weight: 14,
        reason: `Sentence-length CV ${cv.toFixed(2)} < 0.20. Human prose varies more — but technical documentation legitimately does not.`,
      })
    }
  }

  // --- Structural absence (stronger, more objective signals) -------------
  const hasAuthor = Boolean(doc?.author && String(doc.author).trim().length > 1)
  if (!hasAuthor) {
    signals.push({
      id: 'no-author',
      label: 'No identifiable author',
      weight: 15,
      reason: 'No byline or author metadata found. Accountable publishing names its authors.',
    })
  }
  if (!doc?.publishedAt) {
    signals.push({
      id: 'no-date',
      label: 'No publication date',
      weight: 12,
      reason: 'No reliable publication date could be extracted.',
    })
  }

  const outbound = doc?.outboundUrls ?? []
  if (outbound.length > 0) {
    const affiliates = outbound.filter((u) => AFFILIATE_RE.test(u)).length
    const ratio = affiliates / outbound.length
    if (ratio > 0.1) {
      signals.push({
        id: 'affiliate-heavy',
        label: 'Affiliate-monetized',
        weight: Math.min(25, Math.round(ratio * 60)),
        reason: `${affiliates}/${outbound.length} outbound links carry affiliate parameters — commercial incentive to recommend rather than inform.`,
      })
    }
  } else if (words > 600) {
    signals.push({
      id: 'no-references',
      label: 'No outbound references',
      weight: 10,
      reason: 'Long article citing no external sources.',
    })
  }

  const score = Math.max(0, Math.min(100, signals.reduce((a, s) => a + s.weight, 0)))
  const summary =
    score >= 60
      ? `High filler/low-accountability signals (${score}/100) — downweight and require corroboration.`
      : score >= 30
        ? `Some quality concerns (${score}/100) — usable with corroboration.`
        : `No significant quality concerns (${score}/100).`

  return { score, signals, exempt: false, summary }
}

/**
 * @typedef {object} CredibilityReport
 * @property {number} score            0..100 (higher = more credible)
 * @property {SourceKind} kind
 * @property {boolean} isPrimary
 * @property {Signal[]} signals
 * @property {SlopAssessment} slop
 * @property {PrimaryAssessment} primary
 * @property {string} summary
 * @property {string[]} warnings
 */

/**
 * Produce a transparent credibility report for one source.
 *
 * @param {object} doc
 * @param {string} [doc.url]
 * @param {string} [doc.text]
 * @param {string} [doc.author]
 * @param {number|null} [doc.publishedAt]
 * @param {string[]} [doc.outboundUrls]
 * @param {object} [reputation] optional externally-supplied reputation data
 * @param {Set<string>|string[]} [reputation.lowCredibilityHosts] e.g. the Iffy index
 * @param {Map<string,number>|Record<string,number>} [reputation.trancoRank]
 * @param {boolean} [reputation.retracted] Crossref retraction lookup result
 * @returns {CredibilityReport}
 */
export function assessCredibility(doc, reputation = {}) {
  const host = hostOf(doc?.url ?? '')
  const primary = assessPrimary(doc)
  const slop = assessSlop(doc, primary)
  /** @type {Signal[]} */ const signals = []
  /** @type {string[]} */ const warnings = []

  // Baseline by source kind.
  const KIND_BASE = {
    'peer-reviewed': 82,
    primary: 80,
    official: 78,
    reference: 66,
    news: 58,
    trade: 55,
    aggregator: 45,
    blog: 42,
    forum: 35,
    unknown: 50,
  }
  const base = KIND_BASE[primary.kind] ?? 50
  signals.push({
    id: 'kind-baseline',
    label: `Source type: ${primary.kind}`,
    weight: base - 50,
    reason: primary.reasons.join(' ') || 'Type inferred from host and content structure.',
  })

  // Hard negative: retraction.
  if (reputation.retracted) {
    signals.push({
      id: 'retracted',
      label: 'RETRACTED publication',
      weight: -60,
      reason: 'Crossref/Retraction Watch reports this work as retracted. It must not be used as support.',
    })
    warnings.push('This source has been RETRACTED.')
  }

  // Known low-credibility list (Iffy index — CC BY 4.0).
  const lowSet =
    reputation.lowCredibilityHosts instanceof Set
      ? reputation.lowCredibilityHosts
      : new Set(reputation.lowCredibilityHosts ?? [])
  if (host && lowSet.has(host)) {
    signals.push({
      id: 'low-credibility-list',
      label: 'Listed as low-credibility',
      weight: -35,
      reason: 'Host appears on the Iffy index of low-credibility publishers (CC BY 4.0).',
    })
    warnings.push('Host is on a published low-credibility list.')
  }

  // Popularity sanity check (Tranco) — presence is mildly positive, absence is
  // NOT penalized, because niche expert sites are legitimately unranked.
  const rankMap =
    reputation.trancoRank instanceof Map
      ? reputation.trancoRank
      : new Map(Object.entries(reputation.trancoRank ?? {}))
  const rank = host ? rankMap.get(host) : undefined
  if (typeof rank === 'number' && rank > 0 && rank <= 100_000) {
    signals.push({
      id: 'tranco',
      label: 'Well-established domain',
      weight: 6,
      reason: `Tranco rank ${rank.toLocaleString()} — an established, widely-resolved domain.`,
    })
  }

  // Accountability positives.
  if (doc?.author && String(doc.author).trim().length > 1) {
    signals.push({
      id: 'has-author',
      label: 'Named author',
      weight: 5,
      reason: `Byline present (${String(doc.author).slice(0, 60)}).`,
    })
  }
  if (doc?.publishedAt) {
    signals.push({
      id: 'has-date',
      label: 'Dated',
      weight: 4,
      reason: 'A publication date was extracted.',
    })
  }

  // Slop penalty (already exempted for primary sources).
  if (!slop.exempt && slop.score > 0) {
    signals.push({
      id: 'slop',
      label: 'Content-quality signals',
      weight: -Math.round(slop.score * 0.35),
      reason: slop.summary,
    })
  }

  const score = Math.max(0, Math.min(100, 50 + signals.reduce((a, s) => a + s.weight, 0)))

  if (primary.kind === 'aggregator') {
    warnings.push('Press-wire content: treat as a single origin, not independent corroboration.')
  }

  const summary =
    `${primary.kind}${primary.isPrimary ? ' (primary)' : ''} · credibility ${score}/100` +
    (warnings.length ? ` · ${warnings.length} warning(s)` : '')

  return { score, kind: primary.kind, isPrimary: primary.isPrimary, signals, slop, primary, summary, warnings }
}
