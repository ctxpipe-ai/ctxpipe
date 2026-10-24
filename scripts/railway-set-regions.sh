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
#     observability   — every service in the project; clickhouse and mongo
#                       are volume-backed
#   STATELESS_WAIT_SECONDS (default: 600)
#   VOLUME_WAIT_SECONDS    (default: 2700)  # 50GB volume copy
#
# In the product set it also sets restartPolicyType ALWAYS on falkordb, in
# the same update as the region pin. Railway applies a policy change only
# when a new deployment starts, so FalkorDB redeploys when either is wrong.
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

deploy_service() {
  local service_id="$1"
  # shellcheck disable=SC2016
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
    # shellcheck disable=SC2016
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

# Terraform service names. Stateless first; volume-backed last (serial copy).
# The observability set is every service load_project returns. Only the
# volume-backed names are listed here.
STATELESS_NAMES=()
VOLUME_NAMES=()
case "$SERVICE_SET" in
  product)
    STATELESS_NAMES=(backend openworkflow ui)
    VOLUME_NAMES=(codesearch falkordb)
    ;;
  observability)
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

# pin_region <service-id> [extra-input-json]
# The optional second argument merges into the same serviceInstanceUpdate input.
pin_region() {
  local service_id="$1"
  local extra='{}'
  [[ $# -ge 2 ]] && extra="$2"
  railway_service_instance_update "$ENV_ID" "$service_id" \
    "$(jq -nc --arg region "$REGION" --argjson replicas "$NUM_REPLICAS" --argjson extra "$extra" \
      '{multiRegionConfig: {($region): {"numReplicas": $replicas}}} + $extra')" >/dev/null
}

current_restart_policy() {
  local service_id="$1"
  local response
  # shellcheck disable=SC2016
  response="$(railway_graphql \
    'query serviceInstanceMeta($environmentId: String!, $serviceId: String!) { serviceInstance(environmentId: $environmentId, serviceId: $serviceId) { latestDeployment { id status meta } } }' \
    "$(jq -nc --arg env "$ENV_ID" --arg service "$service_id" '{environmentId:$env, serviceId:$service}')")"
  echo "$response" | jq -r '.data.serviceInstance.latestDeployment.meta.serviceManifest.deploy.restartPolicyType // empty'
}

# Read the stored policy back from the service instance and fail when it is
# not ALWAYS.
verify_restart_always() {
  local label="$1"
  local service_id="$2"
  local response policy
  # shellcheck disable=SC2016
  response="$(railway_graphql \
    'query serviceInstanceRestartPolicy($environmentId: String!, $serviceId: String!) { serviceInstance(environmentId: $environmentId, serviceId: $serviceId) { restartPolicyType } }' \
    "$(jq -nc --arg env "$ENV_ID" --arg service "$service_id" '{environmentId:$env, serviceId:$service}')")"
  policy="$(printf '%s' "$response" | jq -r '.data.serviceInstance.restartPolicyType // empty')"
  if [[ "$policy" != "ALWAYS" ]]; then
    echo "::error::Expected restartPolicyType=ALWAYS on $label, got ${policy:-empty}. Cause: Railway did not keep the update. Fix: re-run the deploy, or set the restart policy to Always on the $label service in the Railway dashboard." >&2
    printf '%s\n' "$response" >&2
    return 1
  fi
}

pin_and_maybe_deploy() {
  local label="$1"
  local service_id="$2"
  local wait_seconds="$3"
  local extra='{}'
  local want_always=0 suffix=''
  local region_ok=0 policy_ok=1

  if [[ "$label" == "falkordb" && "$SERVICE_SET" == "product" ]]; then
    want_always=1
    suffix=' with restart policy ALWAYS'
    extra='{"restartPolicyType":"ALWAYS"}'
    [[ "$(current_restart_policy "$service_id")" == "ALWAYS" ]] || policy_ok=0
  fi
  already_on_region "$service_id" && region_ok=1

  if (( region_ok == 1 && policy_ok == 1 )); then
    echo "Skipping $label ($service_id): latest deployment already on $REGION$suffix"
    return 0
  fi

  echo "Pinning $label ($service_id) to $REGION x$NUM_REPLICAS$suffix"
  pin_region "$service_id" "$extra"
  if (( want_always == 1 )); then
    verify_restart_always "$label" "$service_id"
  fi
  echo "Deploying $label"
  deploy_service "$service_id"
  wait_deploy "$label" "$service_id" "$wait_seconds"
}

load_project

if [[ "$SERVICE_SET" == "observability" ]]; then
  # ids_by_name is set by load_project.
  # shellcheck disable=SC2154
  service_ids="$ids_by_name"
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    volume=0
    for volume_name in "${VOLUME_NAMES[@]}"; do
      if [[ "$name" == "$volume_name" ]]; then
        volume=1
        break
      fi
    done
    if (( volume == 0 )); then
      STATELESS_NAMES+=("$name")
    fi
  done < <(echo "$service_ids" | jq -r 'keys[]')
fi

echo "Pinning Railway $ENVIRONMENT_NAME ($ENV_ID) to $REGION"

resolve_id() {
  local name="$1"
  # ids_by_name is set by load_project.
  # shellcheck disable=SC2154
  echo "$ids_by_name" | jq -r --arg name "$name" '.[$name] // empty'
}

if [[ "$SERVICE_SET" == "product" && "$ENVIRONMENT_NAME" == "production" ]]; then
  if [[ -z "$(resolve_id falkordb)" ]]; then
    echo "::error::No Railway service named falkordb in production. Cause: the service was renamed or removed, so the restart policy ALWAYS cannot be set. Fix: restore the falkordb service name in Railway, or update scripts/railway-set-regions.sh." >&2
    exit 1
  fi
fi

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
