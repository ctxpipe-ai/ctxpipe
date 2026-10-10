#!/usr/bin/env bash
# Claude Code on the web: make tests, dev servers, and repo MCPs work in the cloud sandbox.
# Idempotent; the container snapshot is cached after this completes.
# Runbook: "Claude Code on the web" in AGENTS.md.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"
# SessionStart stdout becomes session context: keep tool output on stderr, one summary line on fd 3.
exec 3>&1 1>&2
log() { echo "session-start: $*" >&2; }

########################################################
# 1. Docker daemon (Docker Hub via mirror.gcr.io: the sandbox's shared egress IP
#    hits Docker Hub's anonymous pull limit)
########################################################
if ! docker info >/dev/null 2>&1; then
  mkdir -p /etc/docker
  [ -f /etc/docker/daemon.json ] || echo '{"registry-mirrors":["https://mirror.gcr.io"]}' >/etc/docker/daemon.json
  (setsid dockerd >/tmp/dockerd.log 2>&1 &)
  for _ in $(seq 1 45); do docker info >/dev/null 2>&1 && break; sleep 1; done
  docker info >/dev/null 2>&1 || { log "dockerd did not start"; tail -20 /tmp/dockerd.log >&2; exit 1; }
fi

# No IPv6 in the sandbox kernel: FalkorDB's Bolt listener (binds [::]) aborts the
# server. The backend talks Redis protocol on 6379 and never uses Bolt.
if [ ! -e /proc/net/if_inet6 ] && [ ! -f docker-compose.override.yml ]; then
  printf '%s\n' 'services:' '  falkordb:' '    environment:' '      FALKORDB_ARGS: ""' >docker-compose.override.yml
fi

docker compose --profile infra up -d --wait postgres falkordb otel-collector

########################################################
# 2. Dependencies
########################################################
pnpm install --prefer-offline
# Generated at build time and gitignored; @ctxpipe/aws-cdk tests import it.
pnpm --filter @ctxpipe/aws-cdk stamp-image-tag >/dev/null

# Zoekt for host-mode codesearch (scripts/codesearch-host-dev.sh). The codesearch
# Docker image cannot build here: container egress is TLS-intercepted by the sandbox proxy.
GOBIN_DIR="$(go env GOPATH)/bin"
if [ ! -x "$GOBIN_DIR/zoekt-webserver" ] || [ ! -x "$GOBIN_DIR/zoekt-index" ]; then
  GOTOOLCHAIN=auto go install \
    github.com/sourcegraph/zoekt/cmd/zoekt-index@latest \
    github.com/sourcegraph/zoekt/cmd/zoekt-webserver@latest
fi

# Warm the npx cache for the railway MCP server (.mcp.json).
npx -y @railway/cli@5.63.1 --version >/dev/null

########################################################
# 3. Backend env + database
########################################################
ENV_LOCAL="apps/backend/.env.local"
if [ ! -f "$ENV_LOCAL" ]; then
  cat >"$ENV_LOCAL" <<EOF
DATABASE_URL=postgresql://ctxpipe:ctxpipe@localhost:5433/ctxpipe
GRAPH_DB_URI=redis://localhost:6379
AUTH_SECRET=${AUTH_SECRET:-$(openssl rand -hex 32)}
AUTH_BASE_URL=http://localhost:3000
UI_PROXY_URL=http://localhost:3002
AUTH_ALLOWED_ORIGINS=http://localhost:3002,http://localhost:3000
CODESEARCH_URL=http://127.0.0.1:3001
EOF
  log "wrote $ENV_LOCAL"
fi
# Agent Vault (Docker chat sandboxes): a generated owner password per checkout.
grep -q '^AGENT_VAULT_ADDR=' "$ENV_LOCAL" || echo "AGENT_VAULT_ADDR=http://localhost:14321" >>"$ENV_LOCAL"
grep -q '^AGENT_VAULT_OWNER_PASSWORD=' "$ENV_LOCAL" || echo "AGENT_VAULT_OWNER_PASSWORD=$(openssl rand -hex 24)" >>"$ENV_LOCAL"
pnpm db:migrate >/dev/null

# Tests read DATABASE_URL / AUTH_SECRET from the shell (as in CI), not .env.local.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    grep -E '^(DATABASE_URL|GRAPH_DB_URI|AUTH_SECRET)=' "$ENV_LOCAL" | sed 's/^/export /'
    echo "export PATH=\"$GOBIN_DIR:\$PATH\""
  } >>"$CLAUDE_ENV_FILE"
fi

########################################################
# 4. Storybook, for the ctxpipe-storybook MCP
########################################################
if ! curl -s -o /dev/null http://127.0.0.1:6006/; then
  (cd apps/ui && setsid pnpm storybook >/tmp/storybook.log 2>&1 &)
  for _ in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:6006/ && break; sleep 1; done
fi

echo "Cloud dev env ready: postgres :5433, falkordb :6379, storybook :6006, DATABASE_URL/AUTH_SECRET exported. Start the app with: bash scripts/dev-headless.sh (see AGENTS.md, Claude Code on the web)." >&3
