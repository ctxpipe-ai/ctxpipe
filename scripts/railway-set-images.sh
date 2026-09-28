#!/usr/bin/env bash
# Deploy GHCR image tags to one Railway environment.
#
# Railway provider 0.6.x Update() calls serviceConnect, which sets the image
# on the whole project, then serviceInstanceRedeploy for every environment
# (including pr-* forks). A preview redeploy error fails the production
# apply, and the production tag replaces preview images. See ADR-039.
#
# This script is the write path for SHA-tagged app services. Terraform still
# sets source_image on create and ignore_changes skips the provider Update.
# Repositories match the defaults in infra/module/ctxpipe/variables.tf.
#
# serviceInstanceUpdate on a non-fork environment also writes other non-fork
# environments. Production is the only non-fork. Deploy is scoped to this
# environment via serviceInstanceDeployV2. Do not call serviceInstanceRedeploy.
#
# Required env:
#   RAILWAY_TOKEN or RAILWAY_API_TOKEN
#   RAILWAY_PROJECT_ID
#   IMAGE_TAG
# Optional env:
#   RAILWAY_ENVIRONMENT (default: production)
#   DEPLOY_WAIT_SECONDS (default: 600)
set -euo pipefail

TOKEN="${RAILWAY_TOKEN:-${RAILWAY_API_TOKEN:-}}"
PROJECT_ID="${RAILWAY_PROJECT_ID:-}"
ENVIRONMENT_NAME="${RAILWAY_ENVIRONMENT:-production}"
IMAGE_TAG="${IMAGE_TAG:-}"
DEPLOY_WAIT_SECONDS="${DEPLOY_WAIT_SECONDS:-600}"

if [[ -z "$TOKEN" ]]; then
  echo "Missing RAILWAY_TOKEN (or RAILWAY_API_TOKEN)" >&2
  exit 1
fi
if [[ -z "$PROJECT_ID" ]]; then
  echo "Missing RAILWAY_PROJECT_ID" >&2
  exit 1
fi
if [[ -z "$IMAGE_TAG" || "$IMAGE_TAG" == *[[:space:]:]* ]]; then
  echo "IMAGE_TAG must be a non-empty tag without spaces or ':'" >&2
  exit 1
fi

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/railway-graphql.sh"

# Railway service name -> image repository (no tag).
image_repo_for() {
  case "$1" in
    backend) echo "ghcr.io/ctxpipe-ai/backend" ;;
    openworkflow) echo "ghcr.io/ctxpipe-ai/worker" ;;
    ui) echo "ghcr.io/ctxpipe-ai/ui" ;;
    codesearch) echo "ghcr.io/ctxpipe-ai/codesearch" ;;
    *)
      echo "Unknown service $1" >&2
      return 1
      ;;
  esac
}

instance_state() {
  local service_id="$1"
  # shellcheck disable=SC2016
  railway_graphql \
    'query serviceInstanceSource($environmentId: String!, $serviceId: String!) { serviceInstance(environmentId: $environmentId, serviceId: $serviceId) { source { image } latestDeployment { status } } }' \
    "$(jq -nc --arg env "$ENV_ID" --arg service "$service_id" '{environmentId:$env, serviceId:$service}')"
}

set_image() {
  local service_id="$1"
  local image="$2"
  # shellcheck disable=SC2016
  railway_graphql \
    'mutation serviceInstanceUpdate($environmentId: String, $serviceId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(environmentId: $environmentId, serviceId: $serviceId, input: $input) }' \
    "$(jq -nc --arg env "$ENV_ID" --arg service "$service_id" --arg img "$image" '{environmentId:$env, serviceId:$service, input:{source:{image:$img}}}')" >/dev/null
}

deploy_service() {
  local service_id="$1"
  local response
  # shellcheck disable=SC2016
  response="$(railway_graphql \
    'mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }' \
    "$(jq -nc --arg env "$ENV_ID" --arg service "$service_id" '{environmentId:$env, serviceId:$service}')")"
  echo "$response" | jq -er '.data.serviceInstanceDeployV2'
}

wait_deploy() {
  local label="$1"
  local deployment_id="$2"
  local deadline=$(( $(date +%s) + DEPLOY_WAIT_SECONDS ))
  echo "Waiting for $label deployment $deployment_id (up to ${DEPLOY_WAIT_SECONDS}s)"
  while true; do
    local response status
    # shellcheck disable=SC2016
    response="$(railway_graphql \
      'query deploymentStatus($id: String!) { deployment(id: $id) { id status } }' \
      "$(jq -nc --arg id "$deployment_id" '{id:$id}')")"
    status="$(echo "$response" | jq -r '.data.deployment.status // empty')"
    echo "$label status=${status:-none}"
    case "$status" in
      SUCCESS|SLEEPING) return 0 ;;
      FAILED|CRASHED|REMOVED)
        echo "$response" | jq -c '.data.deployment // .' >&2
        return 1
        ;;
    esac
    if (( $(date +%s) >= deadline )); then
      echo "timeout waiting for $label ($deployment_id status=${status:-none})" >&2
      return 1
    fi
    sleep 10
  done
}

deploy_image() {
  local name="$1"
  local service_id image desired state current status deployment_id
  service_id="$(echo "$ids_by_name" | jq -r --arg name "$name" '.[$name] // empty')"
  if [[ -z "$service_id" ]]; then
    echo "No Railway service named $name in project $PROJECT_ID" >&2
    return 1
  fi
  image="$(image_repo_for "$name")"
  desired="${image}:${IMAGE_TAG}"
  state="$(instance_state "$service_id")"
  current="$(echo "$state" | jq -r '.data.serviceInstance.source.image // empty')"
  status="$(echo "$state" | jq -r '.data.serviceInstance.latestDeployment.status // empty')"
  if [[ "$current" == "$desired" && ( "$status" == "SUCCESS" || "$status" == "SLEEPING" ) ]]; then
    echo "Skipping $name ($service_id): source image already $desired ($status)"
    return 0
  fi
  if [[ "$current" != "$desired" ]]; then
    echo "Setting $name ($service_id) image ${current:-none} -> $desired"
    set_image "$service_id" "$desired"
  else
    echo "Redeploying $name ($service_id): image is $desired but latest deployment is ${status:-none}"
  fi
  deployment_id="$(deploy_service "$service_id")"
  echo "Deploying $name as $deployment_id"
  wait_deploy "$name" "$deployment_id"
}

load_project

echo "Deploying Railway $ENVIRONMENT_NAME ($ENV_ID) images at $IMAGE_TAG"

# Stateless services first. Codesearch has a volume; an image change does not
# copy it, but it still restarts the single replica.
for name in backend ui openworkflow codesearch; do
  deploy_image "$name"
done

echo "Railway $ENVIRONMENT_NAME image deploy complete ($IMAGE_TAG)"
