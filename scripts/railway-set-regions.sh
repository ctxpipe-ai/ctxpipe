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
#     product         — ctxpipe (backend, openworkflow, ui, codesearch, falkordb)
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

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/railway-graphql.sh"

# Terraform service names. Stateless first; volume-backed last (serial copy).
case "$SERVICE_SET" in
  product)
    STATELESS_NAMES=(backend openworkflow ui)
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

current_regions_json() {
  local service_id="$1"
  local response
  # shellcheck disable=SC2016
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
  # shellcheck disable=SC2016
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

railway_load_project

echo "Pinning Railway $ENVIRONMENT_NAME ($ENV_ID) to $REGION"

resolve_id() {
  local name="$1"
  # ids_by_name is set by railway_load_project.
  # shellcheck disable=SC2154
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
