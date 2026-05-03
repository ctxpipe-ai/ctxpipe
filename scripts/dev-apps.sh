#!/usr/bin/env bash
# Portless host dev: start HTTPS proxy, export URLs via `portless get`, then turbo dev.
# Root package.json selects the Turbo script name (default dev):
# - pnpm dev        → env -u CTXPIPE_TURBO_DEV_TASK (defaults to Turbo `dev`).
# - pnpm dev:tailscale → CTXPIPE_TURBO_DEV_TASK=dev:tailscale (matches apps' `dev:tailscale` scripts).
# @ctxpipe/backend and @ctxpipe/ui use plain `portless` vs `portless --funnel` in package.json — no sentinel/env for funnel.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TASK="${CTXPIPE_TURBO_DEV_TASK:-dev}"

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

if [[ "$TASK" == "dev:tailscale" ]]; then
  echo "pnpm dev:tailscale — public URLs are the \`funnel:\` lines in \`pnpm exec portless list\` (set \`PORTLESS_TAILSCALE_URL\` for the backend app origin)." >&2
fi

# Optional Amplitude: backend reads `apps/backend/.env.local`; the UI dev server needs the same
# `AMPLITUDE_API_KEY` and `AMPLITUDE_REGION` in the environment (e.g. `export` in your shell or
# `apps/ui/.env.local`). See apps/backend/.env.example and ADR-017.

# Do not use `exec` so EXIT trap in codesearch-docker-dev.sh can stop the container when turbo exits.
# Default: backend + UI. Forge development needs an account-specific ngrok/Forge setup, so opt in with
# `WITH_FORGE=1 pnpm dev` or run `pnpm --filter @ctxpipe/forge-ctxpipe-agent dev` separately.
# Forward extra args so e.g. `pnpm dev --filter @ctxpipe/docs` (args land here) or
# `bash scripts/dev-apps.sh --filter=@ctxpipe/docs` can run other apps.
if [ "$#" -gt 0 ]; then
  pnpm exec turbo run "$TASK" "$@"
elif [ "${WITH_FORGE:-0}" = "1" ]; then
  pnpm exec turbo run "$TASK" --filter=@ctxpipe/backend --filter=@ctxpipe/ui --filter=@ctxpipe/forge-ctxpipe-agent
else
  pnpm exec turbo run "$TASK" --filter=@ctxpipe/backend --filter=@ctxpipe/ui
fi
