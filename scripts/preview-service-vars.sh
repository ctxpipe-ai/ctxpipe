# shellcheck shell=bash
# upsert_service_vars <label> <variables-json> <service-id>...
# Set variables on Railway services in $RAILWAY_PROJECT_ID / $ENV_ID without
# deploying. Uses the caller's railway_graphql; never prints the values.
# GraphQL documents are single-quoted on purpose.
# shellcheck disable=SC2016

upsert_service_vars() {
  local label="$1" vars_json="$2" service_id
  shift 2
  if ! declare -F railway_graphql >/dev/null; then
    echo "upsert_service_vars: railway_graphql is not defined" >&2
    return 1
  fi
  if [[ -z "${RAILWAY_PROJECT_ID:-}" || -z "${ENV_ID:-}" ]]; then
    echo "upsert_service_vars: RAILWAY_PROJECT_ID and ENV_ID are required" >&2
    return 1
  fi
  for service_id in "$@"; do
    if [[ -z "$service_id" ]]; then
      echo "upsert_service_vars: a service id for $label is empty" >&2
      return 1
    fi
  done
  for service_id in "$@"; do
    railway_graphql \
      'mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }' \
      "$(jq -nc --arg project "$RAILWAY_PROJECT_ID" --arg env "$ENV_ID" --arg service "$service_id" --argjson vars "$vars_json" \
        '{input:{projectId:$project,environmentId:$env,serviceId:$service,skipDeploys:true,variables:$vars}}')" >/dev/null || return 1
    echo "Set $label on service $service_id"
  done
}

# service_vars <environment-id> <service-id> <name>...
# Print a JSON object with only the named variables of one Railway service in
# $RAILWAY_PROJECT_ID. jq drops every other variable inside the pipe, so no
# shell variable holds them. Uses the caller's railway_graphql.
service_vars() {
  local env_id="$1" service_id="$2"
  shift 2
  if ! declare -F railway_graphql >/dev/null; then
    echo "service_vars: railway_graphql is not defined" >&2
    return 1
  fi
  if [[ -z "${RAILWAY_PROJECT_ID:-}" || -z "$env_id" || -z "$service_id" ]]; then
    echo "service_vars: RAILWAY_PROJECT_ID, the environment id and the service id are required" >&2
    return 1
  fi
  railway_graphql \
    'query variables($projectId: String!, $environmentId: String!, $serviceId: String) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) }' \
    "$(jq -nc --arg project "$RAILWAY_PROJECT_ID" --arg env "$env_id" --arg service "$service_id" \
      '{projectId:$project, environmentId:$env, serviceId:$service}')" \
    | jq -c '(.data.variables // {}) as $v
      | [$ARGS.positional[] | select($v[.] != null) | {key: ., value: ($v[.] | tostring)}]
      | from_entries' --args "$@"
}

# production_backend_vars <name>...
# Print a JSON object with only the named variables of the production backend
# ($BACKEND_SERVICE_ID). Fails when the production environment is not found.
production_backend_vars() {
  local prod_env_id
  if ! declare -F railway_graphql >/dev/null; then
    echo "production_backend_vars: railway_graphql is not defined" >&2
    return 1
  fi
  if [[ -z "${RAILWAY_PROJECT_ID:-}" || -z "${BACKEND_SERVICE_ID:-}" ]]; then
    echo "production_backend_vars: RAILWAY_PROJECT_ID and BACKEND_SERVICE_ID are required" >&2
    return 1
  fi
  prod_env_id="$(railway_graphql \
    'query($id: String!) { project(id: $id) { environments { edges { node { id name } } } } }' \
    "$(jq -nc --arg id "$RAILWAY_PROJECT_ID" '{id:$id}')" \
    | jq -r '.data.project.environments.edges[]?.node | select(.name == "production") | .id' | head -1)" || return 1
  if [[ -z "$prod_env_id" ]]; then
    echo "production_backend_vars: could not resolve the production Railway environment id" >&2
    return 1
  fi
  service_vars "$prod_env_id" "$BACKEND_SERVICE_ID" "$@"
}
