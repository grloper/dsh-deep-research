#!/usr/bin/env node
/**
 * @file VERITAS standalone CLI — usable outside DeepSeek Harness and in CI.
 * @license MIT
 *
 * Deliberately dependency-free and offline-capable: the independence and
 * source-assessment commands need no LLM and no API key at all.
 */

import { readFileSync } from 'node:fs'
import { analyzeLineage } from '../lib/lineage.js'
import { assessCredibility } from '../lib/credibility.js'
import { resolveDate } from '../lib/dates.js'
import { makeFetch, stripHtml } from '../lib/index.js'
import { heuristicAtomize, renderReport, verifyText } from '../lib/verify.js'

const USAGE = `
VERITAS — evidence-first research tooling (dsh-deep-research)

Usage:
  dsh-deep-research compare <url...>      Independence / copy-lineage analysis (no LLM needed)
  dsh-deep-research source <url>          Credibility + date-integrity report   (no LLM needed)
  dsh-deep-research claims <file|->       Extract check-worthy atomic claims     (no LLM needed)
  dsh-deep-research verify <file|->       Verify claims in a text file

Notes:
  'compare' is the flagship: give it several URLs covering the same story and it
  reports how many are genuinely independent rather than syndicated copies.
`

const fetchDoc = makeFetch({})

/**
 * @param {string} url
 * @returns {Promise<{id:string,url:string,text:string,publishedAt?:number}|null>}
 */
async function load(url, id) {
  const got = await fetchDoc(url)
  if (!got?.text) {
    process.stderr.write(`  ! could not retrieve ${url}\n`)
    return null
  }
  const dates = resolveDate({ html: got.html ?? '', url })
  return { id, url, text: got.text, publishedAt: dates.effective ?? undefined }
}

/** @param {string[]} urls */
async function cmdCompare(urls) {
  if (urls.length < 2) {
    process.stderr.write('compare needs at least two URLs.\n')
    process.exitCode = 1
    return
  }
  process.stderr.write(`Fetching ${urls.length} sources...\n`)
  const docs = []
  let i = 0
  for (const u of urls) {
    const d = await load(u, `d${++i}`)
    if (d) docs.push(d)
  }
  if (docs.length < 2) {
    process.stderr.write('Not enough sources could be retrieved.\n')
    process.exitCode = 1
    return
  }

  const r = analyzeLineage(docs)
  const urlOf = new Map(docs.map((d) => [d.id, d.url]))

  console.log(`\n${r.summary}\n`)
  console.log('Independent origins:')
  for (const id of r.roots) console.log(`  * ${urlOf.get(id) ?? id}`)

  const derived = r.edges.filter((e) => e.kind === 'syndication' || e.kind === 'derivation')
  if (derived.length) {
    console.log('\nDerivation:')
    for (const e of derived) {
      console.log(`  ${urlOf.get(e.from)} -> ${urlOf.get(e.to)}  (${e.kind} ${e.score.toFixed(2)})`)
    }
  }
  if (r.circular.length) {
    console.log('\n!! Circular citation detected:')
    for (const c of r.circular) console.log(`  ${c.map((id) => urlOf.get(id) ?? id).join(' <-> ')}`)
  }
  console.log(`\nIndependent Corroboration Score: ${r.ics}/${r.total}\n`)
}

/** @param {string} url */
async function cmdSource(url) {
  const got = await fetchDoc(url)
  if (!got?.text) {
    process.stderr.write(`Could not retrieve ${url}\n`)
    process.exitCode = 1
    return
  }
  const dates = resolveDate({ html: got.html ?? '', url })
  const cred = assessCredibility({ url, text: got.text, publishedAt: dates.effective })

  console.log(`\n${url}`)
  console.log(`${cred.summary}`)
  console.log(`Date confidence: ${dates.confidence}`)
  for (const w of dates.warnings) console.log(`  ! ${w}`)
  console.log('\nCredibility signals:')
  for (const s of cred.signals) {
    console.log(`  ${s.weight >= 0 ? '+' : ''}${s.weight}  ${s.label}: ${s.reason}`)
  }
  if (cred.slop.signals.length) {
    console.log('\nContent-quality signals:')
    for (const s of cred.slop.signals) console.log(`  -${s.weight}  ${s.label}: ${s.reason}`)
  }
  for (const w of cred.warnings) console.log(`\n  ! ${w}`)
  console.log()
}

/** @param {string} file */
function readInput(file) {
  if (!file || file === '-') return readFileSync(0, 'utf8')
  return readFileSync(file, 'utf8')
}

/** @param {string} file */
function cmdClaims(file) {
  const text = readInput(file)
  const claims = heuristicAtomize(text)
  if (claims.length === 0) {
    console.log('No check-worthy factual claims found.')
    return
  }
  for (const c of claims) console.log(`${c.id}. ${c.text}`)
}

/** @param {string} file */
async function cmdVerify(file) {
  const text = readInput(file)
  const report = await verifyText(text, {})
  console.log(renderReport(report))
  if (report.warnings.length) {
    process.stderr.write(
      '\nNote: running without an LLM judge. Claims were extracted but not graded.\n' +
        'Use the verify_text tool inside DeepSeek Harness for full verification.\n',
    )
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'compare':
      await cmdCompare(rest)
      break
    case 'source':
      await cmdSource(rest[0])
      break
    case 'claims':
      cmdClaims(rest[0])
      break
    case 'verify':
      await cmdVerify(rest[0])
      break
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(USAGE)
      break
    default:
      process.stderr.write(`Unknown command: ${cmd}\n${USAGE}`)
      process.exitCode = 1
  }
}

main().catch((err) => {
  process.stderr.write(`veritas: ${err?.stack ?? err}\n`)
  process.exitCode = 1
})

export { stripHtml }
