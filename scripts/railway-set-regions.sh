#!/usr/bin/env bash
# Pin Railway services in one environment to a single region, then deploy
# when the latest deployment is not already on that region.
#
# Railway provider 0.6.1/0.6.2 never sends multiRegionConfig on Update
# (https://github.com/terraform-community-providers/terraform-provider-railway/issues/77).
# This script is the write path for region changes. Terraform still sets
# regions on create and documents the desired region; ignore_changes skips
# the broken Update.
#
# Required env:
#   RAILWAY_TOKEN or RAILWAY_API_TOKEN
#   RAILWAY_PROJECT_ID
# Optional env:
#   RAILWAY_ENVIRONMENT  (default: production)
#   RAILWAY_REGION       (default: us-east4-eqdc4a)
#   RAILWAY_NUM_REPLICAS (default: 1)
#   RAILWAY_SERVICE_SET  (default: product)
#     product         — ctxpipe (backend, openworkflow, ui, otelcollector, codesearch, falkordb)
#     observability   — ctxpipe-observability (collector, hyperdx, redis,
#                       langfuse-web, langfuse-worker, railway-telemetry,
#                       clickhouse, mongo)
#   STATELESS_WAIT_SECONDS (default: 600)
#   VOLUME_WAIT_SECONDS    (default: 2700)  # 50GB volume copy
#
# Both hosted Railway projects use the same Virginia region as Neon
# (ADR-029 / ADR-038). Terraform ignore_changes + provider issue #77
# never correct a create that landed in the workspace preferred region
# (Singapore). Run this after apply. Volume-backed services copy the
# volume during the redeploy and go down for that copy.
set -euo pipefail

TOKEN="${RAILWAY_TOKEN:-${RAILWAY_API_TOKEN:-}}"
PROJECT_ID="${RAILWAY_PROJECT_ID:-}"
ENVIRONMENT_NAME="${RAILWAY_ENVIRONMENT:-production}"
REGION="${RAILWAY_REGION:-us-east4-eqdc4a}"
NUM_REPLICAS="${RAILWAY_NUM_REPLICAS:-1}"
SERVICE_SET="${RAILWAY_SERVICE_SET:-product}"
STATELESS_WAIT_SECONDS="${STATELESS_WAIT_SECONDS:-600}"
VOLUME_WAIT_SECONDS="${VOLUME_WAIT_SECONDS:-2700}"

if [[ -z "$TOKEN" ]]; then
  echo "Missing RAILWAY_TOKEN (or RAILWAY_API_TOKEN)" >&2
  exit 1
fi
if [[ -z "$PROJECT_ID" ]]; then
  echo "Missing RAILWAY_PROJECT_ID" >&2
  exit 1
fi
if (( NUM_REPLICAS < 1 )); then
  echo "RAILWAY_NUM_REPLICAS must be >= 1 (Railway rejects 0)" >&2
  exit 1
fi

# Terraform service names. Stateless first; volume-backed last (serial copy).
case "$SERVICE_SET" in
  product)
    STATELESS_NAMES=(backend openworkflow ui otelcollector)
    VOLUME_NAMES=(codesearch falkordb)
    ;;
  observability)
    STATELESS_NAMES=(collector hyperdx redis langfuse-web langfuse-worker railway-telemetry)
    VOLUME_NAMES=(clickhouse mongo)
    ;;
  *)
    echo "Unknown RAILWAY_SERVICE_SET=$SERVICE_SET (expected product or observability)" >&2
    exit 1
    ;;
esac

railway_graphql() {
  local query="$1"
  local variables="$2"
  local raw http_code body
  raw="$(curl -sS -w '\n%{http_code}' \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc --arg q "$query" --argjson v "$variables" '{query:$q,variables:$v}')" \
    https://backboard.railway.com/graphql/v2)" || return $?
  http_code="$(printf '%s' "$raw" | tail -n1)"
  body="$(printf '%s' "$raw" | sed '$d')"
  if [[ "$http_code" != "200" ]]; then
    echo "Railway GraphQL HTTP $http_code for query: ${query:0:120}…" >&2
    echo "$body" >&2
    return 22
  fi
  if echo "$body" | jq -e '.errors | type == "array" and length > 0' >/dev/null 2>&1; then
    echo "Railway GraphQL errors for query: ${query:0:120}…" >&2
    echo "$body" | jq -c '.errors' >&2
    return 22
  fi
  printf '%s' "$body"
}

current_regions_json() {
  local service_id="$1"
  local response
  response="$(railway_graphql \
    'query serviceInstanceMeta($environmentId: String!, $serviceId: String!) { serviceInstance(environmentId: $environmentId, serviceId: $serviceId) { latestDeployment { id status meta } } }' \
    "$(jq -nc --arg env "$ENV_ID" --arg service "$service_id" '{environmentId:$env, serviceId:$service}')")"
  echo "$response" | jq -c '
    .data.serviceInstance.latestDeployment.meta.serviceManifest.deploy.multiRegionConfig // {}
    | to_entries
    | map(select((.value.numReplicas // 0) >= 1) | .key)
    | sort
  '
}

already_on_region() {
  local service_id="$1"
  local regions
  regions="$(current_regions_json "$service_id")"
  [[ "$regions" == "$(jq -nc --arg r "$REGION" '[$r]')" ]]
}

pin_region() {
  local service_id="$1"
  railway_graphql \
    'mutation serviceInstanceUpdate($environmentId: String, $serviceId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(environmentId: $environmentId, serviceId: $serviceId, input: $input) }' \
    "$(jq -nc --arg env "$ENV_ID" --arg service "$service_id" --arg region "$REGION" --argjson replicas "$NUM_REPLICAS" '{
      environmentId: $env,
      serviceId: $service,
      input: {
        multiRegionConfig: {
          ($region): {"numReplicas": $replicas}
        }
      }
    }')" >/dev/null
}

deploy_service() {
  local service_id="$1"
  railway_graphql \
    'mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }' \
    "$(jq -nc --arg env "$ENV_ID" --arg service "$service_id" '{environmentId:$env, serviceId:$service}')" >/dev/null
}

wait_deploy() {
  local label="$1"
  local service_id="$2"
  local wait_seconds="$3"
  local deadline=$(( $(date +%s) + wait_seconds ))
  echo "Waiting for $label deploy (up to ${wait_seconds}s)"
  while true; do
    local response status
    response="$(railway_graphql \
      'query deployments($input: DeploymentListInput!) { deployments(input: $input) { edges { node { id status createdAt } } } }' \
      "$(jq -nc --arg env "$ENV_ID" --arg service "$service_id" '{input:{environmentId:$env, serviceId:$service}}')")"
    status="$(echo "$response" | jq -r '
      [.data.deployments.edges[]?.node // empty]
      | sort_by(.createdAt) | reverse | .[0].status // empty
    ')"
    echo "$label status=${status:-none}"
    case "$status" in
      SUCCESS|SLEEPING) return 0 ;;
      FAILED|CRASHED|REMOVED)
        echo "$response" | jq -c '.data.deployments.edges[0].node // .' >&2
        return 1
        ;;
    esac
    if (( $(date +%s) >= deadline )); then
      echo "timeout waiting for $label" >&2
      return 1
    fi
    sleep 10
  done
}

pin_and_maybe_deploy() {
  local label="$1"
  local service_id="$2"
  local wait_seconds="$3"

  if already_on_region "$service_id"; then
    echo "Skipping $label ($service_id): latest deployment already on $REGION"
    return 0
  fi

  echo "Pinning $label ($service_id) to $REGION x$NUM_REPLICAS"
  pin_region "$service_id"
  echo "Deploying $label"
  deploy_service "$service_id"
  wait_deploy "$label" "$service_id" "$wait_seconds"
}

project_json="$(railway_graphql \
  'query Project($id: String!) { project(id: $id) { environments { edges { node { id name } } } services { edges { node { id name } } } } }' \
  "$(jq -nc --arg id "$PROJECT_ID" '{id:$id}')")"

ENV_ID="$(echo "$project_json" | jq -r --arg n "$ENVIRONMENT_NAME" '
  .data.project.environments.edges[]?.node | select(.name == $n) | .id
' | head -1)"
if [[ -z "$ENV_ID" ]]; then
  echo "No Railway environment named $ENVIRONMENT_NAME in project $PROJECT_ID" >&2
  exit 1
fi

ids_by_name="$(echo "$project_json" | jq -c '
  [.data.project.services.edges[]?.node // empty | select(.name and .id) | {key: .name, value: .id}]
  | from_entries
')"

echo "Pinning Railway $ENVIRONMENT_NAME ($ENV_ID) to $REGION"

resolve_id() {
  local name="$1"
  echo "$ids_by_name" | jq -r --arg name "$name" '.[$name] // empty'
}

for name in "${STATELESS_NAMES[@]}"; do
  sid="$(resolve_id "$name")"
  if [[ -z "$sid" ]]; then
    echo "Warning: no Railway service named $name; skipping" >&2
    continue
  fi
  pin_and_maybe_deploy "$name" "$sid" "$STATELESS_WAIT_SECONDS"
done

for name in "${VOLUME_NAMES[@]}"; do
  sid="$(resolve_id "$name")"
  if [[ -z "$sid" ]]; then
    echo "Warning: no Railway service named $name; skipping" >&2
    continue
  fi
  pin_and_maybe_deploy "$name" "$sid" "$VOLUME_WAIT_SECONDS"
done

echo "Railway $ENVIRONMENT_NAME region pin complete ($REGION)"
