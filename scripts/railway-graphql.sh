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
  raw="$(curl -sS -w '\n%{http_code}' \
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
