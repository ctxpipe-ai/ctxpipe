#!/usr/bin/env bash
# In-repo Cursor memory-capture entrypoint.
# Prefer TypeScript source so `git pull` is what the hook runs — not a stale
# packages/cli/dist and not published npx ctxpipe, which recaptures follow-ups.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI_SRC="$ROOT/packages/cli/src/cli.ts"
CLI_BIN="$ROOT/packages/cli/bin/ctxpipe.js"
TURBO="$ROOT/node_modules/.bin/turbo"

fail_open() {
  printf '%s\n' '{}'
  exit 0
}

if command -v bun >/dev/null 2>&1 && [[ -f "$CLI_SRC" ]]; then
  exec bun "$CLI_SRC" "$@"
fi

# Compiled fallback only: Turbo must successfully refresh dist before we run
# it. Never wrap bun-from-source in Turbo. Never execute an unverified dist
# (failed/missing Turbo used to keep the stale-classifier hole open).
# Turbo writes a banner to stdout; discard it so Cursor still sees JSON.
if [[ ! -x "$TURBO" ]]; then
  fail_open
fi
if ! "$TURBO" run build --filter=ctxpipe --output-logs=errors-only >/dev/null 2>&1; then
  fail_open
fi
if [[ -f "$ROOT/packages/cli/dist/cli.js" ]]; then
  exec node "$CLI_BIN" "$@"
fi
fail_open
