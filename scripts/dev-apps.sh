#!/usr/bin/env bash
# Portless host dev: start HTTPS proxy, export URLs via `portless get` (same worktree prefix logic as
# `portless run` — see https://port1355.dev/ ), then turbo dev:apps.
# Put local portless on PATH (same as pnpm/npm scripts). Avoid `pnpm exec portless` — portless rejects that.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
export PATH="$REPO_ROOT/node_modules/.bin:$PATH"

if ! portless proxy start --https 2>/dev/null; then
  echo "portless: proxy already running or start failed — if HTTPS URLs look wrong, try: portless proxy stop && pnpm dev:apps" >&2
fi

strip() {
  tr -d '\n\r' || true
}

export AUTH_BASE_URL="$(portless get api.ctxpipe | strip)"
export UI_PROXY_URL="$(portless get app.ctxpipe | strip)"
export CODESEARCH_URL="$(portless get search.ctxpipe | strip)"
export VITE_PUBLIC_API_URL="$AUTH_BASE_URL"
export AUTH_ALLOWED_ORIGINS="$UI_PROXY_URL,$AUTH_BASE_URL"

exec pnpm exec turbo run dev:apps --filter=@ctxpipe/backend --filter=@ctxpipe/ui --filter=@ctxpipe/codesearch
