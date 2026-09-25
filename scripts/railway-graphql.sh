# shellcheck shell=bash
# Railway GraphQL helpers. Source this file; it defines functions only.
# GraphQL documents are single-quoted on purpose (shellcheck SC2016).
# shellcheck disable=SC2016
#
# Caller sets TOKEN (Bearer) before railway_graphql, and PROJECT_ID plus
# ENVIRONMENT_NAME before railway_load_project. railway_load_project sets
# ENV_ID and ids_by_name.

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

railway_load_project() {
  local project_json
  project_json="$(railway_graphql \
    'query Project($id: String!) { project(id: $id) { environments { edges { node { id name } } } services { edges { node { id name } } } } }' \
    "$(jq -nc --arg id "$PROJECT_ID" '{id:$id}')")"
  # Globals for scripts that source this file.
  # shellcheck disable=SC2034
  ENV_ID="$(echo "$project_json" | jq -r --arg n "$ENVIRONMENT_NAME" '
    .data.project.environments.edges[]?.node | select(.name == $n) | .id
  ' | head -1)"
  if [[ -z "$ENV_ID" ]]; then
    echo "No Railway environment named $ENVIRONMENT_NAME in project $PROJECT_ID" >&2
    return 1
  fi
  # shellcheck disable=SC2034
  ids_by_name="$(echo "$project_json" | jq -c '
    [.data.project.services.edges[]?.node // empty | select(.name and .id) | {key: .name, value: .id}]
    | from_entries
  ')"
}

deploy_service() {
  local service_id="$1"
  railway_graphql \
    'mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }' \
    "$(jq -nc --arg env "$ENV_ID" --arg service "$service_id" '{environmentId:$env, serviceId:$service}')" >/dev/null
}

railway_list_deployments() {
  local service_id="$1"
  railway_graphql \
    'query deployments($input: DeploymentListInput!) { deployments(input: $input) { edges { node { id status createdAt } } } }' \
    "$(jq -nc --arg env "$ENV_ID" --arg service "$service_id" '{input:{environmentId:$env, serviceId:$service}}')"
}

railway_latest_deployment_created_at() {
  local service_id="$1"
  local response
  response="$(railway_list_deployments "$service_id")"
  echo "$response" | jq -r '
    [.data.deployments.edges[]?.node // empty]
    | sort_by(.createdAt) | reverse | .[0].createdAt // empty
  '
}

# wait_deploy LABEL SERVICE_ID SECONDS [NOT_BEFORE_CREATED_AT]
# NOT_BEFORE skips a deployment that was already current, so a redeploy is
# not reported done because the previous SUCCESS is still the latest row.
wait_deploy() {
  local label="$1"
  local service_id="$2"
  local wait_seconds="$3"
  local not_before="${4:-}"
  local deadline=$(( $(date +%s) + wait_seconds ))
  echo "Waiting for $label deploy (up to ${wait_seconds}s)"
  while true; do
    local response status created
    response="$(railway_list_deployments "$service_id")"
    status="$(echo "$response" | jq -r '
      [.data.deployments.edges[]?.node // empty]
      | sort_by(.createdAt) | reverse | .[0].status // empty
    ')"
    created="$(echo "$response" | jq -r '
      [.data.deployments.edges[]?.node // empty]
      | sort_by(.createdAt) | reverse | .[0].createdAt // empty
    ')"
    if [[ -n "$not_before" && ( -z "$created" || "$created" < "$not_before" || "$created" == "$not_before" ) ]]; then
      echo "$label waiting for a deployment newer than $not_before (latest ${created:-none}, status ${status:-none})"
      status=""
    else
      echo "$label status=${status:-none}"
    fi
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
