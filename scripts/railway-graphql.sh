# shellcheck shell=bash
# Railway GraphQL helpers. Source this file; it defines functions only.
# GraphQL documents are single-quoted on purpose.
# shellcheck disable=SC2016

railway_graphql() {
  local query="$1"
  local variables="$2"
  local token="${RAILWAY_TOKEN:-${RAILWAY_API_TOKEN:-}}"
  local raw http_code body
  if [[ -z "$token" ]]; then
    echo "railway_graphql: RAILWAY_TOKEN or RAILWAY_API_TOKEN is not set" >&2
    return 1
  fi
  # A Railway call that never answers hung a production Deploy for 90
  # minutes. Stop each call after 2 minutes, so the step fails with a cause.
  raw="$(curl -sS --connect-timeout 20 --max-time 120 -w '\n%{http_code}' \
    -H "Authorization: Bearer $token" \
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

# railway_service_instance_update <environment-id> <service-id> <input-json>
# Send one serviceInstanceUpdate with the given ServiceInstanceUpdateInput.
railway_service_instance_update() {
  local env_id="$1" service_id="$2" input="$3"
  railway_graphql \
    'mutation serviceInstanceUpdate($environmentId: String, $serviceId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(environmentId: $environmentId, serviceId: $serviceId, input: $input) }' \
    "$(jq -nc --arg env "$env_id" --arg service "$service_id" --argjson input "$input" '{environmentId:$env, serviceId:$service, input:$input}')"
}

load_project() {
  local project_json
  project_json="$(railway_graphql \
    'query Project($id: String!) { project(id: $id) { environments { edges { node { id name } } } services { edges { node { id name } } } } }' \
    "$(jq -nc --arg id "$PROJECT_ID" '{id:$id}')")"
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

# railway_environment_id <project-id> <environment-name>
# Print the id of the named environment, or nothing when it does not exist.
# Fail when Railway does not return the environment list after 5 attempts, so
# a caller never reads an API error as "the environment does not exist". The
# waits add up to 150 seconds: a Railway rate limit (HTTP 429) asks for up to
# about 70 seconds, and many PR Deploy runs share one workspace token.
railway_environment_id() {
  local project="$1" name="$2" attempt body
  for attempt in 1 2 3 4 5; do
    if body="$(railway_graphql \
        'query Environments($id: String!) { project(id: $id) { environments { edges { node { id name } } } } }' \
        "$(jq -nc --arg id "$project" '{id:$id}')")" \
      && printf '%s' "$body" | jq -e '.data.project.environments.edges | type == "array"' >/dev/null; then
      printf '%s' "$body" | jq -r --arg n "$name" '[.data.project.environments.edges[].node | select(.name == $n) | .id][0] // empty'
      return 0
    fi
    echo "railway_environment_id: the environment list query failed (attempt $attempt of 5)" >&2
    [[ "$attempt" -eq 5 ]] || sleep $((attempt * 15))
  done
  echo "::error::Railway did not list the environments after 5 attempts. Cause: a Railway rate limit or outage, not a removed environment. Fix: re-run the failed jobs of this run in a few minutes." >&2
  return 1
}
