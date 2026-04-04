#!/usr/bin/env bash
# Portless host dev: start HTTPS proxy (default: HTTPS on 443 — clean URLs), export URLs via
# `portless get` (same worktree prefix logic as `portless run` — see https://portless.sh/ ), then turbo dev.
# Invoke portless via `pnpm exec` so the root devDependency is used (no PATH hack).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! pnpm exec portless proxy start 2>/dev/null; then
  echo "portless: proxy already running or start failed — if HTTPS URLs look wrong, try: pnpm exec portless proxy stop && pnpm dev" >&2
fi

strip() {
  tr -d '\n\r' || true
}

export AUTH_BASE_URL="$(pnpm exec portless get app.ctxpipe | strip)"
export UI_PROXY_URL="$(pnpm exec portless get ui.ctxpipe | strip)"
export VITE_PUBLIC_API_URL="$AUTH_BASE_URL"
export AUTH_ALLOWED_ORIGINS="$UI_PROXY_URL,$AUTH_BASE_URL"

# Codesearch runs in Docker (zoekt-index + zoekt-webserver + API via start.sh); random host port → CODESEARCH_URL.
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/codesearch-docker-dev.sh"

# Do not use `exec` so EXIT trap in codesearch-docker-dev.sh can stop the container when turbo exits.
# Default: backend + UI. Forward extra args so e.g. `pnpm dev --filter @ctxpipe/docs` (args land here) or
# `bash scripts/dev-apps.sh --filter=@ctxpipe/docs` can run other apps.
if [ "$#" -gt 0 ]; then
  pnpm exec turbo run dev "$@"
else
  pnpm exec turbo run dev --filter=@ctxpipe/backend --filter=@ctxpipe/ui --filter=@ctxpipe/forge-ctxpipe-agent
fi
