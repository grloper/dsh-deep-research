/**
 * @file VERITAS — Persistent evidence store (mechanism M5, the compounding moat).
 * @license MIT
 *
 * Perplexity restarts from zero on every query, forever. This store is why
 * VERITAS does not: verified claims, their evidence, their lineage and their
 * verdicts persist, so later runs reuse what was already proven instead of
 * re-researching it.
 *
 * Storage strategy (Critique Pass 5): `node:sqlite` is built into Node 22.5+ and
 * needs no native module, no build step and no dependency. On older runtimes we
 * transparently fall back to a JSON-lines store with the same API, so the plugin
 * still installs and works on the Node 20 that DSH nominally supports.
 *
 * Freshness is per-claim, by volatility class — a mathematical constant and a
 * stock price must not expire on the same schedule.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const requireFromHere = createRequire(import.meta.url)

/** Volatility classes and their re-verification horizons. */
export const Volatility = Object.freeze({
  IMMUTABLE: 'immutable',
  SLOW: 'slow',
  FAST: 'fast',
})

/** Time-to-live per volatility class, in milliseconds. */
export const TTL_MS = Object.freeze({
  [Volatility.IMMUTABLE]: 5 * 365 * 24 * 3600_000, // 5 years
  [Volatility.SLOW]: 180 * 24 * 3600_000, //           ~6 months
  [Volatility.FAST]: 24 * 3600_000, //                 24 hours
})

/**
 * Heuristically classify how quickly a claim goes stale.
 * Conservative by design: when unsure, choose the shorter horizon, because
 * re-verifying an immutable fact is cheap while serving a stale price is a bug.
 * @param {string} claimText
 * @returns {keyof typeof TTL_MS}
 */
export function classifyVolatility(claimText) {
  const t = String(claimText ?? '').toLowerCase()
  if (
    /\b(price|stock|shares?|market cap|valuation|poll|polling|casualt|death toll|as of today|currently|right now|latest version|current ceo|exchange rate)\b/.test(
      t,
    )
  ) {
    return Volatility.FAST
  }
  if (
    /\b(was born|was founded|theorem|equation|discovered in|published in \d{4}|died in|treaty of|constant|atomic number|rfc \d+|doi)\b/.test(
      t,
    )
  ) {
    return Volatility.IMMUTABLE
  }
  return Volatility.SLOW
}

/**
 * Whether a stored claim is still trustworthy without re-verification.
 * @param {{ lastVerified?: number, volatility?: string }} claim
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function isFresh(claim, now = Date.now()) {
  if (!claim?.lastVerified) return false
  const ttl = TTL_MS[claim.volatility] ?? TTL_MS[Volatility.SLOW]
  return now - claim.lastVerified < ttl
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, url TEXT, domain TEXT, kind TEXT,
  credibility INTEGER, signals_json TEXT, is_primary INTEGER,
  published_at INTEGER, wayback_first_seen INTEGER,
  fetched_via TEXT, fetched_at INTEGER
);
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY, source_id TEXT, sha256 TEXT, text TEXT,
  slop_score INTEGER, slop_json TEXT
);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, text TEXT, normalized TEXT, volatility TEXT,
  first_seen INTEGER, last_verified INTEGER, verdict TEXT,
  confidence REAL, ics INTEGER
);
CREATE TABLE IF NOT EXISTS evidence (
  claim_id TEXT, doc_id TEXT, quote TEXT,
  char_start INTEGER, char_end INTEGER, anchor_kind TEXT,
  entail TEXT, entail_score REAL
);
CREATE TABLE IF NOT EXISTS lineage (
  from_doc TEXT, to_doc TEXT, kind TEXT, score REAL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, question TEXT, mode TEXT,
  started INTEGER, finished INTEGER, status TEXT, report_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_norm ON claims(normalized);
CREATE INDEX IF NOT EXISTS idx_evidence_claim ON evidence(claim_id);
CREATE INDEX IF NOT EXISTS idx_docs_source ON docs(source_id);
`

/** Tables shared by both backends, used by the JSON fallback to shape its file. */
const TABLES = ['sources', 'docs', 'claims', 'evidence', 'lineage', 'runs']

/**
 * Normalize claim text so semantically identical claims collide on lookup.
 * @param {string} text
 * @returns {string}
 */
export function normalizeClaim(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Evidence store with a SQLite backend and a dependency-free JSON fallback.
 *
 * Both backends expose the same methods, so callers never branch on runtime.
 */
export class EvidenceStore {
  /**
   * @param {string} [path] file path; ':memory:' for an ephemeral store
   */
  constructor(path = ':memory:') {
    this.path = path
    /** @type {'sqlite'|'json'} */
    this.backend = 'json'
    this.db = null
    /** @type {Record<string, any[]>} */
    this.mem = Object.fromEntries(TABLES.map((t) => [t, []]))
    this.#open()
  }

  #open() {
    try {
      // Node 22.5+ builtin. Required dynamically so Node 20 degrades to JSON
      // instead of hard-failing at module load.
      const { DatabaseSync } = requireFromHere('node:sqlite')
      this.db = new DatabaseSync(this.path)
      if (this.path !== ':memory:') {
        try {
          this.db.exec('PRAGMA journal_mode = WAL;')
          this.db.exec('PRAGMA synchronous = NORMAL;')
          this.db.exec('PRAGMA mmap_size = 3000000000;')
        } catch {
          // Pragmas are advisory and non-critical
        }
      }
      this.db.exec(SCHEMA)
      this.backend = 'sqlite'
      return
    } catch {
      // SQLite opens a non-database file lazily and only fails on first exec, so
      // by this point we may hold an open handle to a file we are about to stop
      // using. Releasing it matters on Windows, where a leaked handle blocks the
      // file from being deleted or reopened.
      if (this.db) {
        try {
          this.db.close()
        } catch {
          // nothing further we can do
        }
        this.db = null
      }
    }
    this.backend = 'json'
    if (this.path !== ':memory:' && existsSync(this.path)) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
        for (const t of TABLES) if (Array.isArray(parsed[t])) this.mem[t] = parsed[t]
      } catch {
        // Corrupt store: start clean rather than crash the whole research run.
      }
    }
  }

  /** Persist the JSON backend to disk (no-op for sqlite, which writes eagerly). */
  flush() {
    if (this.backend !== 'json' || this.path === ':memory:') return
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(this.mem), 'utf8')
  }

  /**
   * Insert or replace a row.
   * @param {string} table
   * @param {Record<string, any>} row must contain the table's primary key when it has one
   */
  put(table, row) {
    if (!TABLES.includes(table)) throw new Error(`Unknown table: ${table}`)
    if (this.backend === 'sqlite') {
      const cols = Object.keys(row)
      const stmt = this.db.prepare(
        `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      )
      stmt.run(...cols.map((c) => normalizeValue(row[c])))
      return
    }
    const rows = this.mem[table]
    if (row.id !== undefined) {
      const i = rows.findIndex((r) => r.id === row.id)
      if (i >= 0) {
        rows[i] = { ...rows[i], ...row }
        return
      }
    }
    rows.push({ ...row })
  }

  /**
   * Query rows by exact-match criteria.
   * @param {string} table
   * @param {Record<string, any>} [where]
   * @returns {any[]}
   */
  find(table, where = {}) {
    if (!TABLES.includes(table)) throw new Error(`Unknown table: ${table}`)
    const keys = Object.keys(where)
    if (this.backend === 'sqlite') {
      const sql = keys.length
        ? `SELECT * FROM ${table} WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}`
        : `SELECT * FROM ${table}`
      return this.db.prepare(sql).all(...keys.map((k) => normalizeValue(where[k])))
    }
    return this.mem[table].filter((r) => keys.every((k) => r[k] === where[k]))
  }

  /**
   * Look up a previously verified claim by its normalized text.
   * @param {string} text
   * @returns {any|null}
   */
  getClaim(text) {
    const rows = this.find('claims', { normalized: normalizeClaim(text) })
    return rows.length ? rows[0] : null
  }

  /**
   * Record a verified claim.
   * @param {object} claim
   * @param {string} claim.id
   * @param {string} claim.text
   * @param {string} [claim.verdict]
   * @param {number} [claim.confidence]
   * @param {number} [claim.ics]
   * @param {number} [claim.now]
   */
  putClaim(claim) {
    const now = claim.now ?? Date.now()
    const existing = this.getClaim(claim.text)
    this.put('claims', {
      id: claim.id,
      text: claim.text,
      normalized: normalizeClaim(claim.text),
      volatility: classifyVolatility(claim.text),
      first_seen: existing?.first_seen ?? now,
      last_verified: now,
      verdict: claim.verdict ?? 'UNVERIFIED',
      confidence: claim.confidence ?? 0,
      ics: claim.ics ?? 0,
    })
  }

  /**
   * Reusable prior knowledge: claims that are still within their freshness horizon.
   * This is the mechanism that makes repeat research cheap.
   * @param {string} text
   * @param {number} [now=Date.now()]
   * @returns {{ hit: boolean, claim: any|null, reason: string }}
   */
  recall(text, now = Date.now()) {
    const claim = this.getClaim(text)
    if (!claim) return { hit: false, claim: null, reason: 'No prior verification of this claim.' }
    const fresh = isFresh(
      { lastVerified: claim.last_verified, volatility: claim.volatility },
      now,
    )
    if (!fresh) {
      const age = Math.round((now - claim.last_verified) / 3600_000)
      return {
        hit: false,
        claim,
        reason: `Prior verification is stale (${age}h old, volatility "${claim.volatility}") — re-verifying.`,
      }
    }
    return {
      hit: true,
      claim,
      reason: `Reusing verification from the evidence store (volatility "${claim.volatility}").`,
    }
  }

  /** @returns {Record<string, number>} row counts per table */
  stats() {
    /** @type {Record<string, number>} */ const out = {}
    for (const t of TABLES) out[t] = this.find(t).length
    return out
  }

  close() {
    this.flush()
    if (this.backend === 'sqlite' && this.db) {
      try {
        this.db.close()
      } catch {
        // already closed
      }
    }
  }
}

/**
 * SQLite accepts only null/number/bigint/string/buffer; coerce everything else.
 * @param {any} v
 * @returns {any}
 */
function normalizeValue(v) {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}

/** Default on-disk location for the store. */
export function defaultStorePath(homeDir = process.env.DSH_HOME || process.env.HOME || process.env.USERPROFILE || '.') {
  return join(homeDir, '.dsh', 'veritas', 'evidence.db')
}
