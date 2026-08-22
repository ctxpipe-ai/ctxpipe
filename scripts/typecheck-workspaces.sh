#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/apps/backend"

set +e
out="$(pnpm exec tsc --noEmit --pretty false 2>&1)"
status=$?
set -e

pattern='src/(domain/workspaces|routes/v1/workspaces|routes/v1/conversations|openworkflow/workflows/workspace|openworkflow/enqueue-workspace|models/workspaces|mcp/tools)'
errors="$(printf '%s\n' "$out" | grep -E "$pattern" || true)"

if [[ -n "$errors" ]]; then
  printf '%s\n' "$errors"
  exit 1
fi

if [[ "$status" -ne 0 ]]; then
  echo "Workspace TypeScript is clean. Other backend files still have type errors (not gated here)."
fi
