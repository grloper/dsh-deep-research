# Kestrel / dsh-deep-research

JavaScript evidence-processing tools for source-text anchoring, document similarity/lineage, claim assessment, and storage. The implementation is in `lib/`; the command-line entry point is `bin/kestrel.mjs`.

## Verified local behavior

On the audited branch, 265 Node tests pass. `node demo/run.mjs` executes the real library against the bundled fictional corpus: it checks source-text quotations, groups copied documents, surfaces the fixture contradiction, and recalls stored findings. These are offline fixture results; the corpus is not real-world business evidence.

The audit reproduced a citation defect: fuzzy matching admitted a long quotation whose amount was changed from 42 to 91. Quote matching now defaults to strict mode, and both citation-admission paths disable fuzzy matching. Regression tests exercise that exact counterexample. Explicit approximate search is still available, but it cannot enable fuzzy citation admission.

## Run

Requires Node 20 or later. The local test/demo path has no required third-party packages or API keys.

```sh
node --test
node demo/run.mjs
node bin/kestrel.mjs --help
```

Standalone URL-fetching commands and DeepSeek Harness/model integration are implemented in the source but were not validated against live providers in this audit. Running URL commands makes network requests; installing into a Harness profile changes local configuration.

## Limits

Finding a quote in a document does not prove the claim is true. Normalized matching ignores case and punctuation; inspect the returned source span. Similarity-based lineage is a heuristic, not proof of source independence. Model judgments, live search, fetch resilience and real-world research accuracy remain unverified here. No fabricated-quote-proof, accuracy, latency, or production-scale guarantee is claimed.
