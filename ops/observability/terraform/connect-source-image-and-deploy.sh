#!/usr/bin/env bash
# Connect a Railway service instance to a Docker image, then deploy once
# and wait for a terminal Railway status.
# Same mutations as .github/workflows/pr-deploy.yaml (source image on
# serviceInstanceUpdate, then serviceInstanceDeployV2). Runs after
# restartPolicyType=NEVER is already set; does not write the policy.
#
# serviceInstanceDeployV2 is a GraphQL String scalar (the deployment id),
# not an object — same document as scripts/railway-set-regions.sh and
# pr-deploy.yaml. A non-string payload is treated as "no id".
set -euo pipefail

# Image pull + start for cost-telemetry. Matches STATELESS_WAIT_SECONDS
# in scripts/railway-set-regions.sh.
DEPLOY_WAIT_SECONDS=600
POLL_SLEEP_SECONDS=10

# Mutation body is a String scalar, not { id }.
deploy_id_from_mutation() {
  jq -r '
    .data.serviceInstanceDeployV2
    | if type == "string" and length > 0 then . else empty end
  '
}

deployment_node_by_id() {
  jq -c --arg id "$1" '
    [.data.deployments.edges[]?.node // empty | select(.id == $id)][0] // empty
  '
}

newest_unseen_deployment() {
  jq -c --argjson seen "$1" '
    [.data.deployments.edges[]?.node // empty | select(.id as $nid | ($seen | index($nid)) == null)]
    | sort_by(.createdAt) | reverse | .[0] // empty
  '
}

deployment_ids() {
  jq -c '[.data.deployments.edges[]?.node.id // empty]'
}

deployment_status() {
  local input
  input="$(cat)"
  if [[ -z "$input" ]]; then
    printf '\n'
    return 0
  fi
  printf '%s' "$input" | jq -r '.status // empty'
}

# Prints ok | fail | wait. SUCCESS/SLEEPING match scripts/railway-set-regions.sh.
classify_deploy_status() {
  case "$1" in
    SUCCESS|SLEEPING) printf '%s\n' ok ;;
    FAILED|CRASHED) printf '%s\n' fail ;;
    *) printf '%s\n' wait ;;
  esac
}

list_deployments() {
  # shellcheck disable=SC2016
  railway_graphql \
    'query deployments($input: DeploymentListInput!) { deployments(input: $input) { edges { node { id status createdAt } } } }' \
    "$(jq -nc --arg env "$ENVIRONMENT_ID" --arg service "$SERVICE_ID" '{input:{environmentId:$env, serviceId:$service}}')"
}

wait_for_terminal_deploy() {
  local deployment_id="$1"
  local seen_ids="$2"
  local deadline=$(( $(date +%s) + DEPLOY_WAIT_SECONDS ))
  local response node status outcome

  if [[ -n "$deployment_id" ]]; then
    echo "Waiting for deploy $deployment_id (up to ${DEPLOY_WAIT_SECONDS}s)"
  else
    echo "Waiting for a new deploy (up to ${DEPLOY_WAIT_SECONDS}s)"
  fi

  while true; do
    response="$(list_deployments)"

    if [[ -n "$deployment_id" ]]; then
      node="$(printf '%s' "$response" | deployment_node_by_id "$deployment_id")"
    else
      node="$(printf '%s' "$response" | newest_unseen_deployment "$seen_ids")"
    fi

    status="$(printf '%s' "$node" | deployment_status)"
    echo "status=${status:-none}"
    outcome="$(classify_deploy_status "$status")"
    case "$outcome" in
      ok) return 0 ;;
      fail)
        echo "Railway deploy ${status}" >&2
        printf '%s\n' "${node:-$response}" >&2
        return 1
        ;;
    esac

    if (( $(date +%s) >= deadline )); then
      echo "timeout waiting for $SERVICE_ID deploy" >&2
      printf '%s\n' "$response" >&2
      return 1
    fi
    sleep "$POLL_SLEEP_SECONDS"
  done
}

connect_source_image_and_deploy() {
  if [[ -z "${RAILWAY_TOKEN:-${RAILWAY_API_TOKEN:-}}" ]]; then
    echo "Missing RAILWAY_TOKEN (or RAILWAY_API_TOKEN)" >&2
    return 1
  fi
  if [[ -z "${SERVICE_ID:-}" ]]; then
    echo "Missing SERVICE_ID" >&2
    return 1
  fi
  if [[ -z "${ENVIRONMENT_ID:-}" ]]; then
    echo "Missing ENVIRONMENT_ID" >&2
    return 1
  fi
  if [[ -z "${SOURCE_IMAGE:-}" ]]; then
    echo "Missing SOURCE_IMAGE" >&2
    return 1
  fi

  # shellcheck disable=SC1091
  source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../scripts/railway-graphql.sh"

  # shellcheck disable=SC2016
  railway_graphql \
    'mutation serviceInstanceUpdate($environmentId: String, $serviceId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(environmentId: $environmentId, serviceId: $serviceId, input: $input) }' \
    "$(jq -nc --arg env "$ENVIRONMENT_ID" --arg service "$SERVICE_ID" --arg img "$SOURCE_IMAGE" '{environmentId:$env, serviceId:$service, input:{source:{image:$img}}}')" \
    >/dev/null

  local response connected
  # shellcheck disable=SC2016
  response="$(railway_graphql \
    'query serviceInstanceSourceImage($environmentId: String!, $serviceId: String!) { serviceInstance(environmentId: $environmentId, serviceId: $serviceId) { source { image } } }' \
    "$(jq -nc --arg env "$ENVIRONMENT_ID" --arg service "$SERVICE_ID" '{environmentId:$env, serviceId:$service}')")"

  connected="$(printf '%s' "$response" | jq -r '.data.serviceInstance.source.image // empty')"
  if [[ "$connected" != "$SOURCE_IMAGE" ]]; then
    echo "Expected source.image=$SOURCE_IMAGE, got ${connected:-empty}" >&2
    printf '%s\n' "$response" >&2
    return 1
  fi

  local seen_ids deploy_response deployment_id
  seen_ids="$(list_deployments | deployment_ids)"
  [[ -n "$seen_ids" ]] || seen_ids='[]'
  # shellcheck disable=SC2016
  deploy_response="$(railway_graphql \
    'mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }' \
    "$(jq -nc --arg env "$ENVIRONMENT_ID" --arg service "$SERVICE_ID" '{environmentId:$env, serviceId:$service}')")"

  deployment_id="$(printf '%s' "$deploy_response" | deploy_id_from_mutation)"
  wait_for_terminal_deploy "$deployment_id" "$seen_ids"

  echo "Connected $SERVICE_ID to $SOURCE_IMAGE and deployed"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  connect_source_image_and_deploy
fi
