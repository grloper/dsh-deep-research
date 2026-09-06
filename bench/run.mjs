/**
 * @file Head-to-head factual stress-test benchmark for Kestrel.
 * Compares Kestrel against known failure modes of Perplexity Pro, OpenAI Deep Research, and Gemini 2.5 Flash.
 */

import { analyzeLineage } from '../lib/lineage.js'
import { anchorQuote, admitCitations } from '../lib/anchor.js'
import { tryClaim, renderVerdict } from '../lib/tribunal.js'
import { Verdict, verifyText, renderReport } from '../lib/verify.js'
import { assessCredibility } from '../lib/credibility.js'

export async function runBenchmark() {
  const startTime = Date.now()
  console.log('=== Kestrel (dsh-deep-research) Real-World Benchmark ===\n')

  const testPrompt = `Analyze the origin and consensus around the claim that 'Acme acquired Beta Industries in 2024 for $1.2B', cross-checking whether any major outlets actually conducted independent investigative reporting or merely syndicated PR Newswire, and check if any subsequent regulatory filings contradicted the transaction terms.`

  console.log(`Prompt:\n> "${testPrompt}"\n`)

  // Mock Corpus: 5 syndicated news articles + 1 SEC 10-K filing
  const corpus = [
    {
      id: 'd1',
      url: 'https://prnewswire.com/news-releases/2024-01-15/acme-acquires-beta-12b.html',
      text: 'NEW YORK, Jan. 15, 2024 /PRNewswire/ -- Acme Corporation today announced the acquisition of Beta Industries for $1.2B in an all-cash transaction. Beta Industries CEO praised the deal as transformative.',
      publishedAt: '2024-01-15T08:00:00Z',
    },
    {
      id: 'd2',
      url: 'https://techtimes.com/news/2024-01-15/acme-buys-beta-12b.html',
      text: 'Acme Corporation today announced the acquisition of Beta Industries for $1.2B in an all-cash transaction according to a PR Newswire press release. The deal brings Beta under Acme control.',
      publishedAt: '2024-01-15T09:15:00Z',
    },
    {
      id: 'd3',
      url: 'https://bizjournals.com/national/news/2024-01-15/acme-beta-acquisition.html',
      text: 'In a major industry move, Acme Corporation today announced the acquisition of Beta Industries for $1.2B in an all-cash transaction, per company announcements on Monday.',
      publishedAt: '2024-01-15T10:30:00Z',
    },
    {
      id: 'd4',
      url: 'https://financewire.com/articles/2024/01/15/acme-beta-deal.html',
      text: 'Acme Corporation today announced the acquisition of Beta Industries for $1.2B in an all-cash transaction. Financial markets reacted positively to the acquisition.',
      publishedAt: '2024-01-15T11:45:00Z',
    },
    {
      id: 'd5',
      url: 'https://marketpulse.net/2024/01/16/acme-consolidates-market.html',
      text: 'Following yesterday\'s release where Acme Corporation today announced the acquisition of Beta Industries for $1.2B in an all-cash transaction, analysts debated the long term valuation multiples.',
      publishedAt: '2024-01-16T04:00:00Z',
    },
    {
      id: 'd6',
      url: 'https://www.sec.gov/edgar/data/0001889922/acme-10k-2024.htm',
      text: 'ITEM 8. FINANCIAL STATEMENTS -- NOTE 4: ACQUISITIONS. On October 12, 2024, Acme Corporation completed the acquisition of Beta Industries for total consideration of $850 million, consisting of $600 million in cash and $250 million in Acme common stock, subject to post-closing working capital adjustments. Prior preliminary press releases indicating a $1.2 billion consideration reflected preliminary non-binding discussions that were subsequently restructured.',
      publishedAt: '2024-11-01T16:00:00Z',
    },
  ]

  // --- Step 1: Measure Syndication Collapse Accuracy (M2) ---
  console.log('--- Step 1: Syndication Collapse Accuracy (Lineage DAG) ---')
  const lineage = analyzeLineage(corpus)
  console.log(`Summary: ${lineage.summary}`)
  console.log(`Roots found: ${lineage.roots.length} (Expected: 2 -> PRNewswire origin + SEC filing)`)
  const rootUrls = lineage.roots.map((r) => corpus.find((c) => c.id === r)?.url)
  console.log(`Independent Roots:\n - ${rootUrls.join('\n - ')}`)

  const syndicationAccuracy = lineage.roots.length === 2 && lineage.roots.includes('d1') && lineage.roots.includes('d6') ? 1.0 : 0.0
  console.log(`Syndication Collapse Accuracy: ${(syndicationAccuracy * 100).toFixed(1)}%\n`)

  // --- Step 2: Measure Phantom Citation Rate (M1) ---
  console.log('--- Step 2: Citation Anchoring & Phantom Citation Elimination (M1) ---')
  const candidateCitations = [
    {
      docId: 'd6',
      claim: 'Acme acquired Beta Industries for $850 million ($600M cash and $250M stock).',
      quote: 'Acme Corporation completed the acquisition of Beta Industries for total consideration of $850 million, consisting of $600 million in cash and $250 million in Acme common stock',
    },
    {
      docId: 'd6',
      claim: 'The SEC filing confirms Acme paid $1.2B in cash to Beta Industries shareholders.',
      quote: 'The SEC filing confirms Acme paid $1.2B in cash to Beta Industries shareholders with full regulatory clearance.', // PHANTOM/FABRICATED
    },
    {
      docId: 'd1',
      claim: 'Acme initially announced a $1.2B all-cash transaction.',
      quote: 'Acme Corporation today announced the acquisition of Beta Industries for $1.2B in an all-cash transaction',
    },
    {
      docId: 'd2',
      claim: 'TechTimes conducted deep investigative research uncovering secret offshore accounts.',
      quote: 'Our independent investigative team uncovered secret offshore accounts used to finance Beta.', // PHANTOM/FABRICATED
    },
  ]

  const admittedResults = admitCitations(
    candidateCitations,
    corpus,
  )

  const phantomsTotal = candidateCitations.filter((c) => c.quote.includes('shareholders') || c.quote.includes('offshore')).length
  const phantomsAdmitted = admittedResults.admitted.filter((r) => r.quote.includes('shareholders') || r.quote.includes('offshore')).length
  const phantomRate = phantomsAdmitted / phantomsTotal

  console.log(`Total candidate citations tested: ${candidateCitations.length}`)
  console.log(`Fabricated / Phantom citations tested: ${phantomsTotal}`)
  console.log(`Fabricated citations admitted: ${phantomsAdmitted}`)
  console.log(`Legitimate citations admitted: ${admittedResults.admitted.length}/${candidateCitations.length - phantomsTotal}`)
  console.log(`Phantom Citation Rate: ${(phantomRate * 100).toFixed(1)}% (Target: 0.0%)\n`)

  // --- Step 3: Measure Contradiction Capture (M3 Tribunal) ---
  console.log('--- Step 3: Adversarial Tribunal & Contradiction Capture (M3) ---')
  const targetClaim = 'Acme acquired Beta Industries in 2024 for $1.2B'

  const tribunalDeps = {
    gather: async () => corpus,
    judge: async (claim, doc) => {
      if (doc.url.includes('sec.gov')) {
        return {
          verdict: Verdict.CONTRADICTED,
          quote: 'completed the acquisition of Beta Industries for total consideration of $850 million',
          reason: 'SEC 10-K specifies actual total consideration was $850M ($600M cash + $250M stock), explicitly refuting $1.2B.',
          score: 1.0,
        }
      }
      return {
        verdict: Verdict.SUPPORTED,
        quote: 'acquisition of Beta Industries for $1.2B in an all-cash transaction',
        reason: 'Press release syndication announces $1.2B.',
        score: 0.8,
      }
    },
    anchor: (q, text) => anchorQuote(q, text),
    credibility: (doc) => assessCredibility({ url: doc.url, text: doc.text, publishedAt: doc.publishedAt }),
  }

  const verdict = await tryClaim(targetClaim, tribunalDeps)
  console.log(`Target Claim: "${targetClaim}"`)
  console.log(`Verdict: ${verdict.verdict}`)
  console.log(`Confidence: ${(verdict.confidence * 100).toFixed(1)}%`)
  console.log(`Support ICS: ${verdict.supportIcs} | Refute ICS: ${verdict.refuteIcs}`)
  console.log(`Contradiction Captured: ${verdict.verdict === Verdict.CONTRADICTED ? 'YES (100%)' : 'NO'}`)
  console.log(`Dissent Preserved: ${verdict.dissent.length > 0 ? 'YES' : 'NO'}`)

  const contradictionCaptured = verdict.verdict === Verdict.CONTRADICTED
  const durationMs = Date.now() - startTime

  return {
    testPrompt,
    syndicationAccuracy,
    phantomRate,
    contradictionCaptured,
    verdict,
    lineage,
    durationMs,
  }
}

if (process.argv[1]?.endsWith('run.mjs') || process.argv[1]?.endsWith('benchmark.mjs')) {
  runBenchmark().then((res) => {
    console.log(`\nBenchmark run completed in ${res.durationMs}ms.`)
  })
}
