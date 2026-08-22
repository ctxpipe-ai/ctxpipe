#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/apps/ui"

set +e
out="$(pnpm exec tsc --noEmit --pretty false 2>&1)"
status=$?
set -e

pattern='src/(features/workspaces/|routes/\$orgSlug\.ws\.|routes/\[\.\]workspace-ui-prototype)'
errors="$(printf '%s\n' "$out" | grep -E "$pattern" || true)"

if [[ -n "$errors" ]]; then
  printf '%s\n' "$errors"
  exit 1
fi

if [[ "$status" -ne 0 ]]; then
  echo "Workspace UI TypeScript is clean. Other UI files still have type errors (not gated here)."
fi
