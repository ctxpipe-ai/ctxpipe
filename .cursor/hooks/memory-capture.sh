#!/usr/bin/env bash
# In-repo Cursor memory-capture entrypoint.
# Prefer TypeScript source so `git pull` is what the Stop hook runs — not a
# stale packages/cli/dist build and not published npx ctxpipe@0.3.0, which
# recaptures followup_message as a new lesson.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI_SRC="$ROOT/packages/cli/src/cli.ts"
CLI_BIN="$ROOT/packages/cli/bin/ctxpipe.js"

if command -v bun >/dev/null 2>&1 && [[ -f "$CLI_SRC" ]]; then
  exec bun "$CLI_SRC" "$@"
fi
if [[ -f "$ROOT/packages/cli/dist/cli.js" ]]; then
  exec node "$CLI_BIN" "$@"
fi
# Fail-open: never fall back to npx (published 0.3.0 classifies Stop follow-ups).
printf '%s\n' '{}'
exit 0
