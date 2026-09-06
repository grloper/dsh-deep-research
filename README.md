<div align="center">

# VERITAS

### `dsh-deep-research`

**A research engine that can't cite something a source never said.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-120%20passing-brightgreen.svg)](#verification)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](package.json)
[![DSH Plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-5865f2.svg)](https://github.com/topics/dsh-plugin)

</div>

---

## The problem

Every AI research tool — Perplexity, GPT-Researcher, and the rest — optimizes for **plausible prose with URLs attached.** That produces four failures that no amount of prompt engineering fixes:

| | Failure | Reality |
|---|---|---|
| **F1** | *Citation ≠ support* | Independent tests find 20–35% of Perplexity's cited URLs don't actually state the sentence they're attached to. |
| **F2** | *Fake corroboration* | "12 sources agree" is usually **one press release and eleven syndications.** No consumer tool checks this. |
| **F3** | *Confirmation-only search* | Agents search for support. They never search for refutation. |
| **F4** | *Slop + paywall blindness* | AI-generated affiliate blogs rank equal to primary sources; hard targets get silently dropped. |

VERITAS attacks all four **mechanically** — with code a language model cannot talk its way past.

---

## The two ideas that matter

### 1. A fabricated quote fails `indexOf`

Every claim must carry a **verbatim quote** plus `{docId, charStart, charEnd, sha256}`. Before a citation is admitted, VERITAS performs a literal substring check against the stored, hashed source text.

```
quote ∈ document ?  ✅ citation admitted
                 ✗  ❌ REJECTED → claim demoted to UNVERIFIED
```

No model is asked whether the citation is good. Asking the thing that hallucinates to check its own hallucination is circular. **`String.indexOf` is not.**

> **Phantom-citation rate: 0% by construction.** Not by benchmark. By construction.

### 2. Corroboration is counted in *origins*, not documents

```
$ compare_sources [14 urls about the same story]

⚠  14 sources → 1 independent origin (13 derivative/syndicated)
   Root: acme-corp.com/press/2024-11-03  ·  2024-11-03 08:00Z
   1 circular-citation loop detected (outlet-b ↔ outlet-f)

   Independent Corroboration Score: 1/14
```

MinHash → LSH → lineage DAG → SCC condensation → count the sources of the DAG. Direction is fixed by `min(publishDate, waybackFirstSeen)` — because publishers rewrite their own dates, and the archive is the one timestamp they don't control.

**No other open-source research tool does this.**

---

## Install

```bash
dsh plugin --profile web add dsh-deep-research
```

Zero runtime dependencies. No API keys required beyond the LLM your harness already uses. Node 20+ (uses built-in `node:sqlite` on 22+, transparently falls back to JSON storage below that).

---

## Tools

### `verify_text` — the one to try first

Paste **any** AI output, article, or your own draft. Get every factual claim graded, with receipts.

```
✅ SUPPORTED — 91% confidence
> The trial enrolled 4,200 participants across 12 sites.
Corroboration: 3 independent origins across 5 sources
- [EXACT] journals.example/study-2024 (credibility 84/100)
  > "a randomized trial of 4,200 participants at twelve centres"

❌ CONTRADICTED — 12% confidence
> The treatment eliminated all hospitalizations.
- [EXACT] replication.example/followup (credibility 79/100)
  > "found no statistically significant reduction"

⚠️ UNVERIFIED — 5% confidence
> Adoption grew 400% year over year.
- Rejected citation from blog.example: Quote does not appear in the
  source document (best token overlap 0.31 < 0.85). The citation is
  fabricated or points at the wrong document.
```

### `check_source` — audit one URL

Source type (primary / peer-reviewed / news / blog), transparent credibility signals **with reasons**, content-quality signals, and forged-date detection.

### `compare_sources` — the independence check

Give it N URLs on the same story. Get the Independent Corroboration Score, the true origin, and any circular-citation loops.

---

## How it works

```
INTAKE ──> RECALL ──> ACQUIRE ──> ADJUDICATE ──> GROUND ──> TRIBUNAL ──> GAP ──> SYNTHESIZE
   │          │           │            │             │           │          │         │
 falsifiers  reuse     multi-query   credibility   quote      prosecutor  coverage  claims
 defined     fresh     + COUNTER     + slop gate   anchor     vs          matrix    only
 up front    claims    -claim search + lineage     (M1)       defender    → re-loop
                                       DAG (M2)               (M3)
```

**Five mechanisms:**

- **M1 — Mechanical anchoring.** Quotes verified by string match, not model opinion.
- **M2 — Independent Corroboration Score.** Syndication, derivation, quote-propagation and circular citation collapse to true origins.
- **M3 — The Tribunal.** A **Prosecutor** actively hunts disconfirming evidence (`"X debunked"`, `"X failed to replicate"`). Refutation search is a *required stage*, so confirmation bias is structurally impossible.
- **M4 — Tiered acquisition.** plain fetch → Jina Reader → crawl4ai/scrapling → camoufox/patchright → OCR. Every tier failure is **surfaced, never silently swallowed.**
- **M5 — Compounding evidence graph.** Verified claims persist with per-claim freshness (immutable 5y / slow 6mo / fast 24h). Perplexity restarts from zero every query, forever. This doesn't.

---

## Calibrated confidence, not vibes

Confidence is **not** the model's self-reported certainty — research shows that's badly miscalibrated and clusters at "very sure." It's computed from signals that actually track correctness:

```js
verdict base
  + independent origins (log-scaled, diminishing returns)
  + source credibility  (±0.1)
  × contradiction cap   (hard ceiling of 0.4 if anything contradicts)
```

Four syndicated copies of one press release will **never** score like four independent confirmations.

---

## Honest limitations

This project is about not overstating things, so:

- **It reduces and exposes error. It is not an oracle.** A claim marked SUPPORTED means *evidence was located and mechanically verified*, not that it is true.
- **Credibility scoring can be wrong.** Every score decomposes into named signals with reasons, nothing is ever hard-blocked, and primary sources are exempt from stylistic heuristics — because technical and legal prose trips every naive AI-text detector there is.
- **Slop heuristics carry false-positive risk.** Non-native-English and technical writing use formulaic transitions legitimately. They're weighted near-zero on purpose.
- **Only permissively-licensed reputation data ships.** Iffy Index (CC BY 4.0), Tranco, DOAJ, Crossref. NewsGuard, MBFC and Ad Fontes are proprietary and are **never** bundled or scraped.
- **robots.txt is respected by default.** Aggressive acquisition tiers are opt-in.
- Heuristics are tuned for English. Other languages degrade.

---

## Verification

A tool about verifiable claims should not ship unverifiable claims.

```bash
npm test    # 120 tests, 0 dependencies
```

The suite includes **adversarial tests** asserting the guarantees above — a lying judge that invents quotes, four syndicated sources posing as independent corroboration, forged publication dates, a rewritten permalink, SSR render timestamps posing as publish dates, and false-positive guards protecting legitimate ESL and technical writing from slop penalties.

Benchmark harness (SimpleQA / FRAMES / LongFact / ALCE citation precision) is in progress; **numbers will be published here rather than claimed.**

---

## Design

Full architecture, competitive analysis and five adversarial self-critique passes: **[DESIGN.md](DESIGN.md)**

---

## License

MIT © [grloper](https://github.com/grloper)
