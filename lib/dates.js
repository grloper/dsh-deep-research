/**
 * @file VERITAS — Publication date resolution with adversarial validation.
 * @license MIT
 *
 * Lineage direction (mechanism M2) is decided by "who published first", so a
 * forged date silently inverts the entire copy-lineage DAG and turns a
 * syndicator into an apparent origin. Dates are therefore treated as *contested
 * evidence*, not metadata.
 *
 * Extraction waterfall, strongest first:
 *   JSON-LD → OpenGraph/meta → Dublin Core → HTTP Last-Modified → URL path →
 *   visible byline → archive.org first capture
 *
 * Each tier has documented failure modes (CMS auto-bumping `dateModified`, SSR
 * platforms returning render time, permalink migration faking freshness,
 * sitemaps cron-touched daily for SEO), so tiers cross-validate rather than
 * simply taking the first hit.
 */

/** @typedef {'HIGH'|'MEDIUM'|'LOW'|'SUSPECT'} DateConfidence */

/** Earliest plausible web publication date; anything before this is bogus. */
const MIN_VALID = Date.UTC(1993, 0, 1)

/**
 * Parse a date string defensively.
 * @param {unknown} raw
 * @param {number} [now=Date.now()]
 * @returns {number|null} epoch ms, or null when unusable
 */
export function parseDate(raw, now = Date.now()) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') return sane(raw, now)
  const s = String(raw).trim()
  if (!s) return null
  const t = Date.parse(s)
  if (Number.isNaN(t)) return null
  return sane(t, now)
}

/**
 * Reject impossible timestamps: pre-web, or meaningfully in the future.
 * @param {number} t
 * @param {number} now
 * @returns {number|null}
 */
function sane(t, now) {
  if (!Number.isFinite(t)) return null
  if (t < MIN_VALID) return null
  // Allow a day of clock skew; beyond that a "future" date is manipulation.
  if (t > now + 86_400_000) return null
  return t
}

/**
 * Extract every JSON-LD block from HTML.
 * @param {string} html
 * @returns {any[]}
 */
export function extractJsonLd(html) {
  /** @type {any[]} */ const out = []
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(String(html ?? ''))) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim())
      for (const node of flattenLd(parsed)) out.push(node)
    } catch {
      // Malformed JSON-LD is extremely common; skip silently.
    }
  }
  return out
}

/**
 * @param {any} node
 * @returns {any[]}
 */
function flattenLd(node) {
  if (Array.isArray(node)) return node.flatMap(flattenLd)
  if (node && typeof node === 'object') {
    const graph = node['@graph']
    if (Array.isArray(graph)) return [node, ...graph.flatMap(flattenLd)]
    return [node]
  }
  return []
}

/**
 * Read a `<meta>` value by property or name.
 * @param {string} html
 * @param {string} key
 * @returns {string|null}
 */
export function metaContent(html, key) {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(
    `<meta[^>]+(?:property|name|itemprop)=["']${esc}["'][^>]*content=["']([^"']*)["']`,
    'i',
  )
  const m = re.exec(String(html ?? ''))
  if (m) return m[1]
  // Attribute order is not guaranteed; try the reverse arrangement.
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${esc}["']`,
    'i',
  )
  const m2 = re2.exec(String(html ?? ''))
  return m2 ? m2[1] : null
}

/**
 * Extract a date embedded in a URL path (e.g. /2024/03/12/slug).
 * @param {string} url
 * @param {number} [now=Date.now()]
 * @returns {number|null}
 */
export function dateFromUrl(url, now = Date.now()) {
  const m = /\/(\d{4})\/(\d{1,2})(?:\/(\d{1,2}))?\//.exec(String(url ?? ''))
  if (!m) return null
  const [, y, mo, d] = m
  const year = Number(y)
  const month = Number(mo)
  if (month < 1 || month > 12) return null
  return sane(Date.UTC(year, month - 1, d ? Number(d) : 1), now)
}

/**
 * @typedef {object} DateEvidence
 * @property {string} tier
 * @property {number} value      epoch ms
 * @property {string} field
 */

/**
 * @typedef {object} ResolvedDate
 * @property {number|null} publishedAt
 * @property {number|null} modifiedAt
 * @property {number|null} effective        earliest defensible origin time
 * @property {DateConfidence} confidence
 * @property {DateEvidence[]} evidence
 * @property {string[]} warnings
 */

/**
 * Resolve a document's publication date from all available signals.
 *
 * @param {object} input
 * @param {string} [input.html]
 * @param {string} [input.url]
 * @param {string} [input.httpLastModified]
 * @param {string} [input.httpDate]              the response `Date` header
 * @param {number} [input.waybackFirstSeen]      epoch ms from the CDX API
 * @param {number} [input.now]
 * @returns {ResolvedDate}
 */
export function resolveDate(input = {}) {
  const now = input.now ?? Date.now()
  const html = input.html ?? ''
  /** @type {DateEvidence[]} */ const evidence = []
  /** @type {string[]} */ const warnings = []

  /** @param {string} tier @param {string} field @param {unknown} raw */
  const consider = (tier, field, raw) => {
    const v = parseDate(raw, now)
    if (v !== null) evidence.push({ tier, field, value: v })
    return v
  }

  // Tier 1 — JSON-LD (most reliable when present).
  let published = null
  let modified = null
  for (const node of extractJsonLd(html)) {
    if (published === null && node?.datePublished) {
      published = consider('json-ld', 'datePublished', node.datePublished)
    }
    if (modified === null && node?.dateModified) {
      modified = consider('json-ld', 'dateModified', node.dateModified)
    }
  }

  // Tier 2 — OpenGraph / article meta.
  if (published === null) {
    published =
      consider('meta', 'article:published_time', metaContent(html, 'article:published_time')) ??
      consider('meta', 'pubdate', metaContent(html, 'pubdate')) ??
      consider('meta', 'date', metaContent(html, 'date'))
  }
  if (modified === null) {
    modified =
      consider('meta', 'article:modified_time', metaContent(html, 'article:modified_time')) ??
      consider('meta', 'og:updated_time', metaContent(html, 'og:updated_time'))
  }

  // Tier 3 — Dublin Core.
  if (published === null) {
    published =
      consider('dublin-core', 'DC.date.issued', metaContent(html, 'DC.date.issued')) ??
      consider('dublin-core', 'dcterms.created', metaContent(html, 'dcterms.created'))
  }

  // Tier 4 — HTTP Last-Modified, but only when it isn't just the render time.
  if (input.httpLastModified) {
    const lm = parseDate(input.httpLastModified, now)
    const dh = parseDate(input.httpDate, now)
    const isRenderTime = lm !== null && dh !== null && Math.abs(lm - dh) < 60_000
    if (isRenderTime) {
      warnings.push(
        'HTTP Last-Modified equals the response Date — dynamic render timestamp, not a publication date. Ignored.',
      )
    } else if (lm !== null) {
      evidence.push({ tier: 'http', field: 'Last-Modified', value: lm })
      if (modified === null) modified = lm
    }
  }

  // Tier 5 — URL path.
  const urlDate = dateFromUrl(input.url ?? '', now)
  if (urlDate !== null) evidence.push({ tier: 'url', field: 'path', value: urlDate })

  // Tier 6 — archive.org first capture: an independent lower bound that a
  // publisher cannot retroactively forge.
  const wayback = parseDate(input.waybackFirstSeen, now)
  if (wayback !== null) evidence.push({ tier: 'wayback', field: 'first-capture', value: wayback })

  // --- Cross-validation -------------------------------------------------
  if (published !== null && modified !== null && modified < published - 86_400_000) {
    warnings.push('dateModified precedes datePublished by more than a day — metadata is inconsistent.')
  }
  if (published !== null && wayback !== null && wayback < published - 7 * 86_400_000) {
    warnings.push(
      'Archived copy predates the stated publication date by over a week — the publication date appears to have been rewritten.',
    )
  }
  if (published !== null && urlDate !== null && Math.abs(urlDate - published) > 180 * 86_400_000) {
    warnings.push('URL path date and metadata date disagree by more than six months.')
  }

  // Effective origin time: the earliest defensible signal. Wayback is included
  // because it is the one timestamp a publisher does not control.
  const candidates = evidence
    .filter((e) => e.tier !== 'http') // render-time noise
    .map((e) => e.value)
  if (published !== null) candidates.push(published)
  const effective = candidates.length ? Math.min(...candidates) : null

  /** @type {DateConfidence} */
  let confidence = 'LOW'
  if (warnings.some((w) => /rewritten|inconsistent/.test(w))) {
    confidence = 'SUSPECT'
  } else if (published !== null && evidence.filter((e) => e.value === published).length >= 2) {
    confidence = 'HIGH'
  } else if (published !== null && evidence.some((e) => e.tier === 'json-ld')) {
    confidence = 'HIGH'
  } else if (published !== null || effective !== null) {
    confidence = 'MEDIUM'
  } else {
    confidence = 'LOW'
  }

  return { publishedAt: published, modifiedAt: modified, effective, confidence, evidence, warnings }
}
