#!/usr/bin/env bash
# Ensure a Railway PR preview environment exists, duplicated from production.
# On create failure, delete any partial environment so nick-fields/retry can succeed (CTX-125).

set -euo pipefail

usage() {
  echo "Usage: $0 <railway_project_id> <pr_environment_name> [source_environment=production]" >&2
  exit 1
}

[[ $# -ge 2 && $# -le 3 ]] || usage

RAILWAY_PROJECT_ID="$1"
PR_ENV="$2"
SOURCE_ENV="${3:-production}"

if [[ -z "${RAILWAY_API_TOKEN:-}" ]]; then
  echo "RAILWAY_API_TOKEN must be set" >&2
  exit 1
fi

railway_graphql() {
  local query="$1"
  local variables="$2"
  curl -fsS -X POST \
    -H "Authorization: Bearer ${RAILWAY_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc --arg q "$query" --argjson v "$variables" '{query:$q,variables:$v}')" \
    https://backboard.railway.com/graphql/v2
}

lookup_env_id() {
  local env_name="$1"
  local after="" response
  while true; do
    response="$(railway_graphql \
      'query($projectId: String!, $first: Int!, $after: String) {
        project(id: $projectId) {
          environments(first: $first, after: $after) {
            edges { node { id name } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }' \
      "$(jq -nc --arg project "$RAILWAY_PROJECT_ID" --arg after "$after" '{projectId:$project, first:100, after:($after | if . == "" then null else . end)}')")"

    local env_id
    env_id="$(jq -r --arg name "$env_name" '.data.project.environments.edges[] | select(.node.name == $name) | .node.id' <<<"$response" | head -1)"
    if [[ -n "$env_id" ]]; then
      echo "$env_id"
      return 0
    fi

    if [[ "$(jq -r '.data.project.environments.pageInfo.hasNextPage' <<<"$response")" != "true" ]]; then
      return 1
    fi
    after="$(jq -r '.data.project.environments.pageInfo.endCursor' <<<"$response")"
  done
}

delete_pr_env_if_present() {
  local env_id
  env_id="$(lookup_env_id "$PR_ENV" || true)"
  if [[ -n "$env_id" ]]; then
    railway_graphql \
      'mutation($id: String!) { environmentDelete(id: $id) }' \
      "$(jq -nc --arg id "$env_id" '{id:$id}')" >/dev/null
    echo "Deleted Railway environment $PR_ENV ($env_id)"
  fi
  railway environment delete "$PR_ENV" --yes 2>/dev/null || true
}

railway link --project "$RAILWAY_PROJECT_ID" --environment "$SOURCE_ENV"

if railway environment config --environment "$PR_ENV" --json >/dev/null 2>&1; then
  echo "Railway environment $PR_ENV already exists"
else
  if ! railway environment new "$PR_ENV" --duplicate "$SOURCE_ENV"; then
    echo "railway environment new failed; deleting partial environment so retry can succeed" >&2
    delete_pr_env_if_present || true
    exit 1
  fi
fi

railway link --project "$RAILWAY_PROJECT_ID" --environment "$PR_ENV"
