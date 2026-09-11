#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
exec node scripts/ci/typecheck.mjs apps/backend/tsconfig.json scripts/ci/diagnostics/backend.json
