#!/usr/bin/env bash
# Run codesearch on the host (zoekt-webserver + Bun API) instead of the Docker image.
# For sandboxes that cannot build apps/codesearch/Dockerfile (e.g. Claude Code on the
# web: container egress is TLS-intercepted and Docker Hub is rate-limited).
# Mirrors apps/codesearch/start.sh with writable paths under apps/codesearch/.data/.
#
# Needs zoekt-webserver + zoekt-index on PATH (.claude/hooks/session-start.sh installs
# them with `go install`) and AUTH_SECRET matching the backend (read from
# apps/backend/.env.local when unset). Backend reaches it at CODESEARCH_URL=http://127.0.0.1:3001.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$ROOT/apps/codesearch/.data"
export PATH="$(go env GOPATH 2>/dev/null)/bin:$PATH"

if [[ -z "${AUTH_SECRET:-}" && -f "$ROOT/apps/backend/.env.local" ]]; then
  AUTH_SECRET="$(sed -n 's/^AUTH_SECRET=//p' "$ROOT/apps/backend/.env.local")"
  export AUTH_SECRET
fi

export ZOEKT_INDEX_DIR="$DATA/zoekt-index"
export REPO_CACHE_DIR="$DATA/repo-cache"
export ZOEKT_WEBSERVER_URL="http://127.0.0.1:6070"
export PORT="${PORT:-3001}"
ZOEKT_HOT="$DATA/zoekt-hot"

mkdir -p "$ZOEKT_INDEX_DIR" "$REPO_CACHE_DIR"
# Restart with zero loaded shards so zoekt-webserver does not inherit stale pins.
rm -rf "$ZOEKT_HOT"
mkdir -p "$ZOEKT_HOT"

zoekt-webserver -index "$ZOEKT_HOT" -rpc -listen 127.0.0.1:6070 &
ZOEKT_PID=$!
trap 'kill -TERM "$ZOEKT_PID" 2>/dev/null || true' EXIT

cd "$ROOT/apps/codesearch"
bun run src/server.ts
