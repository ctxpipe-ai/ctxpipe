#!/usr/bin/env bash
# Optional escape hatch. Preferred path is the Railway GitHub integration
# (terraform source_repo on clickhouse + collector). Use this only when you
# need to push local Docker contexts with the Railway CLI.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ID="${OBSERVABILITY_RAILWAY_PROJECT_ID:-305aa114-c6f3-4aca-b883-0faa9c331aa2}"
TOKEN="${RAILWAY_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  echo "set RAILWAY_TOKEN (workspace token used by infra/; no separate project token)" >&2
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
    echo "skip $svc (not linked yet — apply ops/observability/terraform first)"
  fi
done
