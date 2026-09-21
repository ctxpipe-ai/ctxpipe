#!/usr/bin/env bash
# Redeploy ctxpipe-observability from this tree. Invoked by
# .github/workflows/observability.yaml. First-time service create is manual
# (see README.md); this script only links + uploads/redeploys.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ID="${OBSERVABILITY_RAILWAY_PROJECT_ID:?set OBSERVABILITY_RAILWAY_PROJECT_ID}"
TOKEN="${OBSERVABILITY_RAILWAY_TOKEN:-${RAILWAY_TOKEN:-}}"
if [[ -z "$TOKEN" ]]; then
  echo "set OBSERVABILITY_RAILWAY_TOKEN or RAILWAY_TOKEN" >&2
  exit 1
fi
export RAILWAY_TOKEN="$TOKEN"

railway link --project "$PROJECT_ID" --environment production

railway up "$ROOT/clickhouse" --service clickhouse --detach --ci
railway up "$ROOT/collector" --service collector --detach --ci

for svc in hyperdx langfuse-web langfuse-worker redis mongo; do
  if railway status --service "$svc" >/dev/null 2>&1; then
    railway redeploy --service "$svc" --yes
  else
    echo "skip $svc (not linked yet — create it in the Railway project first)"
  fi
done
