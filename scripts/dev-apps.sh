#!/usr/bin/env bash
# Portless host dev: start HTTPS proxy, export URLs via `portless get` (same worktree prefix logic as
# `portless run` — see https://port1355.dev/ ), then turbo dev.
# Put local portless on PATH (same as pnpm/npm scripts). Avoid `pnpm exec portless` — portless rejects that.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
export PATH="$REPO_ROOT/node_modules/.bin:$PATH"

if ! portless proxy start --https 2>/dev/null; then
  echo "portless: proxy already running or start failed — if HTTPS URLs look wrong, try: portless proxy stop && pnpm dev" >&2
fi

strip() {
  tr -d '\n\r' || true
}

export AUTH_BASE_URL="$(portless get app.ctxpipe | strip)"
export UI_PROXY_URL="$(portless get ui.ctxpipe | strip)"
export VITE_PUBLIC_API_URL="$AUTH_BASE_URL"
export AUTH_ALLOWED_ORIGINS="$UI_PROXY_URL,$AUTH_BASE_URL"

# Codesearch runs in Docker (zoekt-index + zoekt-webserver + API via start.sh); random host port → CODESEARCH_URL.
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/codesearch-docker-dev.sh"

# Do not use `exec` so EXIT trap in codesearch-docker-dev.sh can stop the container when turbo exits.
pnpm exec turbo run dev --filter=@ctxpipe/backend --filter=@ctxpipe/ui
