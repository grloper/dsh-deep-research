# VERITAS — Design Document

**Package:** `dsh-deep-research` · **Engine codename:** VERITAS · **Host:** DeepSeek Harness (Cordis plugin)

> An adversarial, evidence-first research engine. It does not try to sound right.
> It tries to be *checkable*.

---

## 0. Naming decision (locked)

`dsh-research` is **already taken** on npm (`literaf`, v0.4.3 — an academic plugin-market UI, unrelated).
`dsh-deep-research` and `dsh-veritas` are both unclaimed.

- **npm package + repo name:** `dsh-deep-research` — wins discovery; people browsing DSH plugin
  directories search "deep research", not invented brand names.
- **Engine brand inside the product:** **VERITAS** — memorable, gives the project an identity
  and a logo hook.
- `dsh-veritas` will be claimed as a defensive alias package.

Reversible before first publish; nothing downstream depends on the string.

---

## 1. Thesis: why every existing research agent is fundamentally beatable

The entire field — commercial and open-source — optimizes for **plausible prose with URLs attached**.
That produces four failure modes that are *structural*, not fixable by a better prompt:

| # | Failure | Why it happens | Who has it |
|---|---|---|---|
| F1 | **Citation ≠ support.** The cited page doesn't actually state the claim. | Nobody checks entailment. A URL near a sentence is treated as proof. | Perplexity (20–35% mismatch in independent tests), GPT-Researcher, Morphic, Perplexica |
| F2 | **Fake corroboration.** "12 sources agree" is really 1 press release + 11 syndications. | Source *count* is used as a truth proxy. Independence is never computed. | **Everyone. No tool in the survey does this.** |
| F3 | **Confirmation-only search.** The agent searches for support, never for refutation. | Query generation is seeded from the hypothesis. Disconfirming evidence is never sought. | GPT-Researcher, dzhng, Firesearch, STORM |
| F4 | **Slop contamination + paywall blindness.** AI-generated affiliate blogs rank equal to primary sources; hard targets silently dropped. | No credibility model; single-tier fetch that gives up on Cloudflare/JS/PDF. | Perplexity, OpenAI DR (silently retreats to secondary), Jina |

**VERITAS attacks all four mechanically — not with better prompting, but with code that an LLM
cannot talk its way past.**

---

## 2. Competitive gap (measured, not assumed)

**Inside the DSH ecosystem** there is *no* autonomous deep-research orchestrator. What exists:

| Plugin | ★ | What it is | Gap |
|---|---|---|---|
| `dsh-web-tools` | ~24 | 8-provider search/fetch proxy | I/O layer only; no planning, no verification |
| `ai4scholar-plugin-dsh` | ~11–25 | 38 academic API tools | Tool-surface bloat; academic silo; no web; no gap loops |
| `dsh-weknora` | (Tencent) | Enterprise RAG over internal KBs | No live web |
| `dsh-library` | ~2 | Local SQLite doc KB | Local files only; rule-based cite check |
| `dsh-plugin-llm-verifier` | ~9 | LLM-as-judge scoring | Not grounded against retrieved evidence |

Best-in-class OSS elsewhere (GPT-Researcher 29k★, STORM 31k★, dzhng 19.6k★) all exhibit F1–F3.
**The niche is empty and the bar is low. That is the opportunity.**

---

## 3. The five mechanisms (this is the whole product)

### M1 — Mechanical citation anchoring (kills F1, no LLM trust required)

Every claim must carry a **verbatim quote** plus `{docId, charStart, charEnd, sha256}`.
Before a citation is allowed into the output, the engine performs a **literal substring check**
of that quote against the stored, hashed document text.

```
quote ∈ normalize(document.text) ?  → citation admitted
                                  ✗ → citation REJECTED, claim demoted to UNVERIFIED
```

This is deterministic. A model that fabricates a quote is caught by `String.includes`, not by
another model's opinion. **No competitor does this.** It alone eliminates phantom citations.

Then, on top: NLI entailment (claim vs. quoted span) → `SUPPORTED / PARTIAL / NEUTRAL / CONTRADICTED`.

### M2 — Independent Corroboration Score (kills F2 — the flagship differentiator)

Naive tools count sources. VERITAS computes **how many *independent* origins** exist.

```
docs → 3-word shingles → MinHash(128) → LSH(16 bands × 8 rows) → candidate pairs
     → Jaccard ≥ 0.85 : syndication edge
     → Jaccard 0.40–0.84 : derivation edge
     → shared-quote ≥ 50 chars : quote-propagation edge
     → direction fixed by min(publishDate, waybackFirstSeen)
     → Tarjan SCC (circular reporting) + transitive reduction
     → count roots (in-degree 0) = ICS
```

Output the user actually sees:

```
⚠  14 sources cite this claim — but only 2 are independent.
   Root origin: acme-corp.com/press/2024-11-03 (2024-11-03 08:00Z)
   12 downstream syndications collapsed  ·  1 circular-citation loop detected
   Independent Corroboration Score: 2/14
```

That is a **screenshot people share.** It is the single most viral thing in this design.

### M3 — The Tribunal (kills F3)

For every load-bearing claim, three roles run as DSH subagents:

- **Prosecutor** — explicitly searches for *disconfirming* evidence, methodological flaws,
  retractions, contradicting primary data. Its queries are adversarial by construction
  (`"X debunked"`, `"X failed to replicate"`, `"criticism of X"`, counter-claim phrasing).
- **Defender** — assembles strongest supporting evidence, prioritizing primary sources.
- **Adjudicator** — issues a verdict + calibrated confidence + explicit dissent record.

Confirmation bias becomes structurally impossible: refutation search is a *required pipeline
stage*, not an emergent behavior we hope for.

### M4 — Tiered acquisition (kills F4's paywall half)

```
1. plain fetch + Readability          (fast path, ~80% of pages)
2. Jina Reader r.jina.ai              (JS-rendered, free)
3. crawl4ai / scrapling               (optional, if present)
4. camoufox / patchright              (Cloudflare/Turnstile, opt-in)
5. PaddleOCR / pdf text layer         (PDFs, scans, charts)
```

Tiers 3–5 light up automatically **if** the `dsh-godmode` engine set is installed — a genuine
unfair advantage — but the core works with zero of them. Every tier failure is *recorded and
surfaced*, never silently swallowed (OpenAI DR's documented sin).

### M5 — Compounding evidence graph (the moat)

Every run writes to a persistent store: sources, docs, chunks, claims, verdicts, entities,
lineage edges. Later runs **query the store first** and reuse claims that are still fresh.

Freshness is per-claim, by volatility class:

| Class | Examples | TTL |
|---|---|---|
| immutable | theorems, historical events, published DOIs, RFCs | 5–20 y |
| slow | leadership, standards, docs | 6–18 mo |
| fast | prices, polls, casualty counts, versions | 1–48 h |

Perplexity restarts from zero on every query, forever. VERITAS gets *better the more you use it*.
Export to Obsidian (claim notes + backlinks), Mermaid, and a machine-readable evidence bundle.

---

## 4. Pipeline

```
┌── 0 INTAKE ─────────────────────────────────────────────────────────┐
│ classify(question) → {factual|comparative|causal|temporal|explore}   │
│ extract entities, timeframe, volatility, success criteria            │
│ decompose → sub-question DAG   ·   set budget (searches/fetches/$)   │
│ define FALSIFIERS: "what evidence would prove this wrong?"           │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌── 1 RECALL ─────────────────────────────────────────────────────────┐
│ query evidence store (BM25 ⊕ vector, RRF k=60) → reusable claims     │
│ freshness gate → stale claims re-enter the research queue            │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌── 2 ACQUIRE ────────────────────────────────────────────────────────┐
│ multi-query (neutral / entity+attr / COUNTER-CLAIM / step-back)      │
│ multi-engine search → RRF fuse                                      │
│ primary-source chase: DOI, arXiv, PMID, SEC EDGAR, RFC, ECLI, gov   │
│ tiered fetch (M4) → clean text + char offsets + sha256              │
│ date waterfall (JSON-LD→OG→DC→HTTP→URL→sitemap→wayback CDX)         │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌── 3 ADJUDICATE SOURCES ─────────────────────────────────────────────┐
│ credibility signals (transparent, reasoned — never a black box):     │
│   domain tier · primary-vs-secondary · author · refs · date conf.    │
│   retraction check (Crossref) · slop heuristics · Tranco sanity      │
│ MinHash → LSH → lineage DAG → INDEPENDENT EVIDENCE UNITS  (M2)       │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌── 4 GROUND ─────────────────────────────────────────────────────────┐
│ evidence-first claim mining (claims come FROM sources, not the model)│
│ atomize + decontextualize · chunk w/ preserved offsets               │
│ QUOTE ANCHOR CHECK (M1, mechanical) → then NLI entailment            │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌── 5 TRIBUNAL ───────────────────────────────────────────────────────┐
│ Prosecutor ⚔ Defender → Adjudicator verdict + dissent      (M3)     │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌── 6 GAP ANALYSIS ───────────────────────────────────────────────────┐
│ coverage × confidence × independence matrix                          │
│ unanswered? weak? contradicted? → targeted follow-ups → loop to 2    │
│ stop on: convergence | budget | no-new-information                   │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌── 7 SYNTHESIZE ─────────────────────────────────────────────────────┐
│ compose ONLY from admitted claims · every factual sentence → claimIds│
│ unsupported → dropped or explicitly marked ⚠                        │
│ dedicated CONTRADICTIONS section · per-section confidence            │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌── 8 PERSIST + AUDIT ────────────────────────────────────────────────┐
│ evidence store write · Obsidian/Mermaid export                       │
│ report.md · evidence.json (full provenance) · audit.html (clickable) │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 5. Data model (SQLite, `node:sqlite` builtin — zero native deps)

```
runs(id, question, mode, budget, started, finished, status)
sources(id, url, domain, domain_tier, credibility, cred_reasons_json, is_primary,
        published_at, modified_at, date_confidence, wayback_first_seen, fetched_via)
docs(id, source_id, sha256, text, lang, slop_score, slop_reasons_json)
chunks(id, doc_id, char_start, char_end, text)
minhash(doc_id, band, band_hash)                     -- LSH index
lineage(from_doc, to_doc, kind, score)               -- syndication|derivation|quote
claims(id, text, normalized, volatility, first_seen, last_verified)
evidence(claim_id, chunk_id, quote, anchor_ok, entail, entail_score)
verdicts(claim_id, run_id, verdict, confidence, ics, dissent_json, adjudicator)
entities(id, name, type)  ·  claim_entities(claim_id, entity_id)
```

Node 20 fallback: same schema over a JSON-lines store (feature-detected at boot).

---

## 6. DSH integration surface

**Tools:**
- `deep_research(question, mode?, budget?)` — full pipeline, streams progress
- `verify_text(text)` — ⭐ **standalone killer feature**: paste *any* AI output, get every claim
  graded with receipts. Instantly useful with zero setup. This is the adoption wedge.
- `research_recall(query)` — query the accumulated evidence graph
- `check_source(url)` — credibility + lineage + primary-source report for one URL

**Also:** Cordis host plugin + optional Web UI panel (live tribunal, lineage graph, claim table),
a `SKILL.md` so the agent knows when to invoke it, and a `dsh-deep-research` CLI bin for
standalone/CI use.

**Modes:** `quick` (~30 s, verify top claims) · `standard` (2–4 min, default) ·
`deep` (10–30 min, full tribunal) · `forensic` (unbounded, archive everything).

**Cost control:** cheap model for atomization/triage/extraction, strong model only for
adjudication/synthesis; content-hash caching; store reuse; hard budget caps with graceful
degradation.

---

## 7. Legal & ethical constraints (non-negotiable, designed in)

- **Bundle only permissive data.** Iffy Index (CC BY 4.0) ✅ · Tranco ✅ · DOAJ ✅ ·
  Crossref/Retraction Watch (public) ✅ · WP:RSP (CC BY-SA, fetched+cached, attributed) ✅.
  **NewsGuard / MBFC / Ad Fontes are proprietary — never bundled or scraped.** ❌
- **Credibility is "signals with reasons," never a black-box verdict.** Every score is expandable
  into the exact signals that produced it. Users can override.
- **Slop heuristics never hard-block**, are **never applied to primary sources**, and carry an
  explicit false-positive warning (non-native English and technical docs trip naive detectors).
- **robots.txt respected by default**; rate-limited; aggressive acquisition tiers are **opt-in**
  with a clear warning.
- **Honest framing.** This reduces and exposes error. It is not an oracle. The README will say so.

---

## 8. Proving it (we hold ourselves to our own standard)

A tool about verifiable claims must not ship unverifiable claims. Ships with `bench/`:

| Benchmark | Measures | Practical |
|---|---|---|
| **SimpleQA** | short-form factual precision | ✅ cheap, deterministic grading |
| **FRAMES** | multi-hop retrieval + temporal reasoning | ✅ 824 q |
| **LongFact + SAFE** | long-form factual precision (F1@K) | ✅ sampled |
| **FreshQA** | freshness / temporal drift | ✅ 600 q |
| **RAGTruth** | span-level hallucination detection | ✅ passive |
| **ALCE/ASQA** | citation precision & recall | ✅ the metric that matters most |

Headline metrics published in README: **citation-support precision**, **phantom-citation rate**
(target: 0.00% by construction via M1), **ICS accuracy**, cost/run, latency/run.

---

## 9. Adversarial self-review — five passes

**Pass 1 — "Is this better, or just more complex?"**
Risk: 8 stages could mean a 15-minute, $2 answer that loses to Perplexity's 30 seconds.
→ **Fix applied:** four depth modes, `standard` default; streaming progress so it never feels
hung; store reuse makes follow-ups fast. Complexity must be *opt-in per query*.

**Pass 2 — "Which parts are vaporware?"**
Lineage needs full text (snippets insufficient) → **only run lineage on cited sources, not all**.
Wayback SPN2 needs keys/rate limits → **CDX read (free, keyless) for first-seen is the part that
matters; archiving is best-effort optional**. MiniCheck ONNX = 400 MB → **optional tier; default
to batched LLM entailment**. Embeddings → **optional; BM25 is the default**. Everything survives
tiering.

**Pass 3 — "What makes someone actually star this?"**
Not architecture. Three things: `verify_text` (paste any AI answer → graded, shareable), the ICS
lineage reveal ("14 sources, 2 independent"), and real benchmark numbers. → **Fix applied:**
these are promoted to first-class features and lead the README, rather than being buried
pipeline internals.

**Pass 4 — "How does it embarrass the user?"**
False slop/credibility accusations against legitimate outlets; over-claiming "truth"; non-English
misfires; ToS trouble from aggressive scraping. → **Fix applied:** §7 constraints are hard design
requirements — never hard-block, always show reasons, exempt primary sources, conservative
thresholds, opt-in aggression, honest README framing.

**Pass 5 — "Will the DSH integration survive?"**
DSH is 0.1.2-rc/alpha and moving (godmode already ships a `CallId→ToolCallId` compat patch for
another plugin). Over-coupling to `dsh-godmode` would also kill standalone installs. → **Fix
applied:** defensive adapter layer around every DSH API with feature detection and soft failure;
loose peer ranges; **zero mandatory heavy dependencies**; works headless *and* web; godmode
engines are a detected bonus tier, never a requirement. Node 22 `node:sqlite` with a Node 20
JSON fallback.

**Bonus pass — "Does it meet its own bar?"**
A truth tool shipping unmeasured claims would be self-refuting. → §8 benchmark harness is a
release requirement, not a nice-to-have.

---

## 10. Honest expectations

This design targets a real, empty niche with a genuinely novel core (M1+M2+M3 combined exist in
no open-source tool surveyed). What I can control: engineering quality, novelty, benchmarks,
documentation, demo clarity. What I cannot promise: a specific star count — that depends on
launch timing, community reception, and luck. The plan maximizes the odds; it doesn't guarantee
the outcome.
