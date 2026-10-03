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
