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
      "$(jq -nc --arg project "$RAILWAY_PROJECT_ID" --arg after "$after" \
        '{projectId:$project, first:100, after:($after | if . == "" then null else . end)}')")"

    local env_id
    env_id="$(jq -r --arg name "$env_name" \
      '.data.project.environments.edges[]? | select(.node.name == $name) | .node.id' \
      <<<"$response" | head -1)"
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

link_environment() {
  railway link --project "$RAILWAY_PROJECT_ID" --environment "$1" >/dev/null 2>&1
}

pr_env_usable() {
  railway environment config --environment "$PR_ENV" --json >/dev/null 2>&1
}

delete_pr_env_by_id() {
  local env_id="$1"
  railway_graphql \
    'mutation($id: String!) { environmentDelete(id: $id) }' \
    "$(jq -nc --arg id "$env_id" '{id:$id}')" >/dev/null
  echo "Deleted Railway environment $PR_ENV via GraphQL ($env_id)"
}

delete_pr_env_best_effort() {
  local env_id deleted=false

  env_id="$(lookup_env_id "$PR_ENV" || true)"
  if [[ -n "$env_id" ]]; then
    delete_pr_env_by_id "$env_id"
    deleted=true
  fi

  if link_environment "$PR_ENV"; then
    if railway environment delete "$PR_ENV" --yes; then
      echo "Deleted Railway environment $PR_ENV via CLI (linked)"
      deleted=true
    fi
    link_environment "$SOURCE_ENV" || true
  elif railway environment delete "$PR_ENV" --yes 2>/dev/null; then
    echo "Deleted Railway environment $PR_ENV via CLI"
    deleted=true
  fi

  if [[ "$deleted" == "false" ]]; then
    echo "Could not find Railway environment $PR_ENV to delete; waiting for name release" >&2
    return 1
  fi

  return 0
}

create_duplicated_env_with_cleanup() {
  local attempt
  for attempt in $(seq 1 5); do
    if railway environment new "$PR_ENV" --duplicate "$SOURCE_ENV"; then
      return 0
    fi

    echo "railway environment new failed (attempt $attempt/5); cleaning up before retry" >&2
    if delete_pr_env_best_effort; then
      sleep 10
    else
      # Name may be reserved without a deletable env object after manual deletes.
      sleep 30
    fi
  done

  return 1
}

link_environment "$SOURCE_ENV"

if pr_env_usable; then
  echo "Railway environment $PR_ENV already exists"
else
  env_id="$(lookup_env_id "$PR_ENV" || true)"
  if [[ -n "$env_id" ]]; then
    echo "Railway environment $PR_ENV exists but is not usable; deleting before recreate"
    delete_pr_env_by_id "$env_id"
    link_environment "$SOURCE_ENV"
    sleep 10
  fi

  if ! create_duplicated_env_with_cleanup; then
    echo "Failed to create Railway environment $PR_ENV after retries" >&2
    exit 1
  fi
fi

link_environment "$PR_ENV"
