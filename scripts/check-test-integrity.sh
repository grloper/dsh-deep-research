#!/usr/bin/env bash
# Fails if the diff vs the PR base deletes tests, adds skip/ignore/xfail markers,
# or removes assertions. Bypass: label the PR `test-change-approved`.
# Env: BASE_REF (default origin/main), PR_LABELS (comma/newline separated; set by CI).
set -euo pipefail

if [[ "${EVENT_NAME:-pull_request}" != "pull_request" && "${EVENT_NAME:-}" != "pull_request_target" ]]; then
  echo "test-integrity: not a pull_request event; nothing to compare. OK."; exit 0
fi
if printf '%s\n' "${PR_LABELS:-}" | tr ',' '\n' | grep -qx 'test-change-approved'; then
  echo "test-integrity: label 'test-change-approved' present; check bypassed by owner approval."; exit 0
fi

BASE="${BASE_REF:-origin/main}"
MB="$(git merge-base "$BASE" HEAD)"
fail=0
TEST_RE='(^|/)(tests?|__tests__|spec|e2e|androidTest|testing)/|(^|/)test_[^/]*$|_test\.[a-z]+$|\.(test|spec)\.[a-z]+$|(Test|Tests)\.(kt|java|cs)$'
SELF='^(scripts/check-test-integrity\.sh|\.github/)'

# 1) deleted (or renamed-away) test files
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if [[ "$f" =~ $TEST_RE ]]; then
    echo "::error::test file deleted: $f"; fail=1
  fi
done < <(git diff --diff-filter=D --name-only "$MB" HEAD)

# 2) added skip/ignore/xfail markers (any non-doc file)
SKIP_RE='(@pytest\.mark\.(skip|skipif|xfail)|pytest\.(skip|xfail)\(|@unittest\.(skip|skipIf|skipUnless|expectedFailure)|\bself\.skipTest\(|#\[ignore|\b(it|test|describe|context)\.(skip|todo|failing)\b|\b(xit|xtest|xdescribe)\(|@Ignore\b|@Disabled\b|\bt\.Skip(Now|f)?\(|\[Ignore|\[Fact\(Skip|Assume\.assume|\.only\()'
while IFS= read -r f; do
  [[ -z "$f" || "$f" =~ $SELF || "$f" =~ \.(md|txt|rst)$ ]] && continue
  hits="$(git diff -U0 "$MB" HEAD -- "$f" | grep -E '^\+[^+]' | grep -E "$SKIP_RE" || true)"
  if [[ -n "$hits" ]]; then
    echo "::error::new skip/ignore/xfail marker added in $f:"; echo "$hits"; fail=1
  fi
done < <(git diff --diff-filter=AMR --name-only "$MB" HEAD)

# 3) removed assertions in test files (more removed than added per file)
ASSERT_RE='(\bassert\b|\bassert[A-Z_][A-Za-z_]*\(|\bassert_[a-z_]+!?\(|\bassert!\(|\bexpect\(|\bexpect!|\bassertThat\b|\bself\.assert|\bt\.(Error|Fatal)f?\()'
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  [[ "$f" =~ $TEST_RE ]] || continue
  d="$(git diff -U0 "$MB" HEAD -- "$f")"
  rem="$(printf '%s\n' "$d" | grep -E '^-[^-]' | grep -cE "$ASSERT_RE" || true)"
  add="$(printf '%s\n' "$d" | grep -E '^\+[^+]' | grep -cE "$ASSERT_RE" || true)"
  if (( rem > add )); then
    echo "::error::assertions removed in $f (removed=$rem, added=$add)"; fail=1
  fi
done < <(git diff --diff-filter=M --name-only "$MB" HEAD)

if (( fail )); then
  echo "test-integrity: FAILED. Add the PR label 'test-change-approved' only if the owner approved this test change."
  exit 1
fi
echo "test-integrity: OK (no deleted tests, new skip markers, or removed assertions vs $BASE)."
