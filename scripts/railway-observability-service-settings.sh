#!/usr/bin/env bash
# PROJECT_ID / ENVIRONMENT_NAME feed load_project, which sets ENV_ID and ids_by_name.
# shellcheck disable=SC2034,SC2154
# Apply the ctxpipe-observability service settings the Railway Terraform
# provider cannot manage (restart policy, healthcheck, sleep). Settings take
# effect on each service's next deployment.
#
# Required env:
#   RAILWAY_TOKEN or RAILWAY_API_TOKEN
#   RAILWAY_PROJECT_ID
set -euo pipefail

PROJECT_ID="${RAILWAY_PROJECT_ID:?Missing RAILWAY_PROJECT_ID}"
ENVIRONMENT_NAME="${RAILWAY_ENVIRONMENT:-production}"

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/railway-graphql.sh"

# ClickHouse exits when the cold bucket is unreachable at boot; 120 retries
# ride out a bucket outage (ops/observability/clickhouse/config.d/storage.xml).
settings='{
  "clickhouse": {"restartPolicyType": "ON_FAILURE", "restartPolicyMaxRetries": 120, "healthcheckPath": "/ping", "healthcheckTimeout": 120, "sleepApplication": false},
  "collector": {"restartPolicyType": "ON_FAILURE", "restartPolicyMaxRetries": 10, "sleepApplication": false},
  "railway-telemetry": {"restartPolicyType": "NEVER", "sleepApplication": false}
}'

load_project

for service in $(echo "$settings" | jq -r 'keys[]'); do
  service_id="$(echo "$ids_by_name" | jq -r --arg s "$service" '.[$s] // empty')"
  if [[ -z "$service_id" ]]; then
    echo "No Railway service named $service" >&2
    exit 1
  fi
  # shellcheck disable=SC2016
  railway_graphql \
    'mutation($environmentId: String!, $serviceId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(environmentId: $environmentId, serviceId: $serviceId, input: $input) }' \
    "$(jq -nc --arg e "$ENV_ID" --arg s "$service_id" --argjson i "$(echo "$settings" | jq -c --arg s "$service" '.[$s]')" '{environmentId: $e, serviceId: $s, input: $i}')" \
    >/dev/null
  echo "$service settings applied"
done
