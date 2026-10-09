# AGENTS.md

Instructions for AI coding agents and contributors.

## Verification (required before claiming anything works)

Run exactly this and read the output:

```
scripts/verify.sh
```

Exit code 0 = pass. Anything else = not done. CI runs the same script (job `verify`) plus `scripts/check-test-integrity.sh` (job `test-integrity`).

Rules for AI agents and humans:
1. **Reproduce first.** For a bug, write or run a failing test/command that shows it before editing; the fix is done only when that flips to green.
2. **Do not weaken tests.** Never delete tests, add skip/ignore/xfail markers, remove assertions, or loosen expected values to get green. `test-integrity` fails the PR if you do; only the owner may approve via the PR label `test-change-approved`.
3. **Report only what was run.** State the exact command and its real result. If something was not run or could not run, say so. Never claim success without the output.
4. Do not edit `.github/`, `scripts/verify.sh`, or `scripts/check-test-integrity.sh` to make a failing check pass; those are owned by @grloper (CODEOWNERS).
