#!/usr/bin/env bash
# Headless dev stack without portless: codesearch (host), backend, OpenWorkflow worker, UI.
# Browse http://localhost:3000 (backend proxies the UI on :3002). Expects infra up and
# migrations applied (`pnpm dev:infra && pnpm db:migrate`, or .claude/hooks/session-start.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# A busy port leaves `bun --hot` alive after its bind error, so concurrently -k never exits.
for port in 3000 3001 3002 6070; do
  if (echo >"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "dev-headless: port $port is already in use; stop that process first." >&2
    exit 1
  fi
done

exec pnpm exec concurrently -k -n codesearch,backend,worker,ui \
  "bash scripts/codesearch-host-dev.sh" \
  "cd apps/backend && bun --env-file=.env.local run --hot src/server.ts" \
  "cd apps/backend && bun --env-file=.env.local x @openworkflow/cli worker start" \
  "cd apps/ui && VITE_PUBLIC_API_URL=http://localhost:3000 pnpm exec vite dev --host 0.0.0.0 --port 3002"
