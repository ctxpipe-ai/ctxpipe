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
#   RAILWAY_REGION (default: us-east4-eqdc4a)
#   RAILWAY_NUM_REPLICAS (default: 1)
#   DEPLOY_WAIT_SECONDS (default: 600)
#   STALE_DEPLOY_SECONDS (default: 180)
#
# serviceInstanceUpdate can start a deployment before serviceInstanceDeployV2.
# A second deploy then returns "Problem processing request". If the update
# already started one, this script waits for that deployment. A deployment
# still INITIALIZING with no region is cancelled once it is stale, then a
# deploy is started. The region is sent with the image so that deployment
# can be placed.
set -euo pipefail

TOKEN="${RAILWAY_TOKEN:-${RAILWAY_API_TOKEN:-}}"
PROJECT_ID="${RAILWAY_PROJECT_ID:-}"
ENVIRONMENT_NAME="${RAILWAY_ENVIRONMENT:-production}"
IMAGE_TAG="${IMAGE_TAG:-}"
REGION="${RAILWAY_REGION:-us-east4-eqdc4a}"
NUM_REPLICAS="${RAILWAY_NUM_REPLICAS:-1}"
DEPLOY_WAIT_SECONDS="${DEPLOY_WAIT_SECONDS:-600}"
STALE_DEPLOY_SECONDS="${STALE_DEPLOY_SECONDS:-180}"

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
    'query serviceInstanceSource($environmentId: String!, $serviceId: String!) { serviceInstance(environmentId: $environmentId, serviceId: $serviceId) { source { image } latestDeployment { id status createdAt } } }' \
    "$(jq -nc --arg env "$ENV_ID" --arg service "$service_id" '{environmentId:$env, serviceId:$service}')" || return $?
}

set_image() {
  local service_id="$1"
  local image="$2"
  # shellcheck disable=SC2016
  railway_graphql \
    'mutation serviceInstanceUpdate($environmentId: String, $serviceId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(environmentId: $environmentId, serviceId: $serviceId, input: $input) }' \
    "$(jq -nc --arg env "$ENV_ID" --arg service "$service_id" --arg img "$image" --arg region "$REGION" --argjson replicas "$NUM_REPLICAS" '{
      environmentId:$env,
      serviceId:$service,
      input:{
        source:{image:$img},
        multiRegionConfig:{($region):{numReplicas:$replicas}}
      }
    }')" >/dev/null
}

deploy_service() {
  local service_id="$1"
  local response
  # shellcheck disable=SC2016
  response="$(railway_graphql \
    'mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }' \
    "$(jq -nc --arg env "$ENV_ID" --arg service "$service_id" '{environmentId:$env, serviceId:$service}')")" || return $?
  echo "$response" | jq -er '.data.serviceInstanceDeployV2'
}

cancel_deployment() {
  local deployment_id="$1"
  # shellcheck disable=SC2016
  railway_graphql \
    'mutation deploymentCancel($id: String!) { deploymentCancel(id: $id) }' \
    "$(jq -nc --arg id "$deployment_id" '{id:$id}')" >/dev/null
}

deployment_age_seconds() {
  local created_at="$1"
  local created now
  if [[ -z "$created_at" ]]; then
    echo "$STALE_DEPLOY_SECONDS"
    return 0
  fi
  created="$(date -d "$created_at" +%s)"
  now="$(date +%s)"
  echo $(( now - created ))
}

# INITIALIZING with no forward progress blocks the next deploy. BUILDING and
# DEPLOYING are left alone; those are doing work.
stale_initializing() {
  local status="$1"
  local created_at="$2"
  local age
  case "$status" in
    INITIALIZING|WAITING|QUEUED) ;;
    *) return 1 ;;
  esac
  age="$(deployment_age_seconds "$created_at")"
  (( age >= STALE_DEPLOY_SECONDS ))
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

read_deployment() {
  local state="$1"
  CURRENT_IMAGE="$(echo "$state" | jq -r '.data.serviceInstance.source.image // empty')"
  DEPLOYMENT_ID="$(echo "$state" | jq -r '.data.serviceInstance.latestDeployment.id // empty')"
  DEPLOYMENT_STATUS="$(echo "$state" | jq -r '.data.serviceInstance.latestDeployment.status // empty')"
  DEPLOYMENT_CREATED="$(echo "$state" | jq -r '.data.serviceInstance.latestDeployment.createdAt // empty')"
}

deploy_image() {
  local name="$1"
  local service_id image desired state before_id
  service_id="$(echo "$ids_by_name" | jq -r --arg name "$name" '.[$name] // empty')"
  if [[ -z "$service_id" ]]; then
    echo "No Railway service named $name in project $PROJECT_ID" >&2
    return 1
  fi
  image="$(image_repo_for "$name")"
  desired="${image}:${IMAGE_TAG}"
  state="$(instance_state "$service_id")" || return $?
  read_deployment "$state"

  if [[ "$CURRENT_IMAGE" == "$desired" && ( "$DEPLOYMENT_STATUS" == "SUCCESS" || "$DEPLOYMENT_STATUS" == "SLEEPING" ) ]]; then
    echo "Skipping $name ($service_id): source image already $desired ($DEPLOYMENT_STATUS)"
    return 0
  fi

  if stale_initializing "$DEPLOYMENT_STATUS" "$DEPLOYMENT_CREATED"; then
    echo "Cancelling stale $name deployment $DEPLOYMENT_ID ($DEPLOYMENT_STATUS since $DEPLOYMENT_CREATED)"
    cancel_deployment "$DEPLOYMENT_ID"
  elif [[ "$CURRENT_IMAGE" == "$desired" && ( "$DEPLOYMENT_STATUS" == "INITIALIZING" || "$DEPLOYMENT_STATUS" == "WAITING" || "$DEPLOYMENT_STATUS" == "QUEUED" || "$DEPLOYMENT_STATUS" == "BUILDING" || "$DEPLOYMENT_STATUS" == "DEPLOYING" ) ]]; then
    echo "Waiting for in-progress $name deployment $DEPLOYMENT_ID ($DEPLOYMENT_STATUS)"
    wait_deploy "$name" "$DEPLOYMENT_ID"
    return 0
  fi

  if [[ "$CURRENT_IMAGE" != "$desired" ]]; then
    before_id="$DEPLOYMENT_ID"
    echo "Setting $name ($service_id) image ${CURRENT_IMAGE:-none} -> $desired"
    set_image "$service_id" "$desired"
    state="$(instance_state "$service_id")" || return $?
    read_deployment "$state"
    if [[ -n "$DEPLOYMENT_ID" && "$DEPLOYMENT_ID" != "$before_id" ]]; then
      echo "Image update started $name deployment $DEPLOYMENT_ID"
      wait_deploy "$name" "$DEPLOYMENT_ID"
      return 0
    fi
  else
    echo "Redeploying $name ($service_id): image is $desired but latest deployment is ${DEPLOYMENT_STATUS:-none}"
  fi

  DEPLOYMENT_ID="$(deploy_service "$service_id")" || return $?
  echo "Deploying $name as $DEPLOYMENT_ID"
  wait_deploy "$name" "$DEPLOYMENT_ID"
}

load_project

echo "Deploying Railway $ENVIRONMENT_NAME ($ENV_ID) images at $IMAGE_TAG"

# Stateless services first. Codesearch has a volume; an image change does not
# copy it, but it still restarts the single replica.
for name in backend ui openworkflow codesearch; do
  deploy_image "$name"
done

echo "Railway $ENVIRONMENT_NAME image deploy complete ($IMAGE_TAG)"
