#!/usr/bin/env bash
# Single source of truth for 'is this change OK'. Exit code is the truth.
# Only checks that pass on main today are included (formatters are not enabled where they would fail).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

npx --yes eslint@10.12.0 .
npm test
echo "verify: ALL CHECKS PASSED"
