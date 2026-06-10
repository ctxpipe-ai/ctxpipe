#!/usr/bin/env bash
# Ensure a Railway PR preview environment exists and is duplicated from production.
# GraphQL lookup/delete handles broken envs where CLI delete by name fails (CTX-125).

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
  railway_graphql \
    'query($projectId: String!) { project(id: $projectId) { environments { edges { node { id name } } } } }' \
    "$(jq -nc --arg project "$RAILWAY_PROJECT_ID" '{projectId:$project}')" \
    | jq -r --arg name "$env_name" '.data.project.environments.edges[] | select(.node.name == $name) | .node.id' \
    | head -1
}

delete_env_by_id() {
  local env_id="$1"
  railway_graphql \
    'mutation($id: String!) { environmentDelete(id: $id) }' \
    "$(jq -nc --arg id "$env_id" '{id:$id}')" >/dev/null
  echo "Deleted Railway environment $env_id"
}

delete_pr_env_if_present() {
  local env_id
  env_id="$(lookup_env_id "$PR_ENV" || true)"
  if [[ -n "$env_id" ]]; then
    delete_env_by_id "$env_id"
  fi
  railway environment delete "$PR_ENV" --yes 2>/dev/null || true
}

wait_for_pr_env_absent() {
  local attempt
  for attempt in $(seq 1 30); do
    if [[ -z "$(lookup_env_id "$PR_ENV" || true)" ]] \
      && ! env_config_readable "$PR_ENV"; then
      return 0
    fi
    echo "Waiting for Railway environment $PR_ENV to finish deleting (attempt $attempt/30)..."
    sleep 2
  done
  echo "Warning: Railway environment $PR_ENV may still be deleting" >&2
  return 1
}

env_config_readable() {
  railway environment config --environment "$1" --json >/dev/null 2>&1
}

count_active_services() {
  local env_name="$1"
  local config
  config="$(railway environment config --environment "$env_name" --json 2>/dev/null)" || return 1
  jq '[(.services // {}) | to_entries[] | select(.value.is_deleted != true)] | length' <<<"$config"
}

env_needs_recreate() {
  if ! env_config_readable "$PR_ENV"; then
    echo "Railway environment $PR_ENV exists but config is not readable"
    return 0
  fi

  local prod_count pr_count
  if ! prod_count="$(count_active_services "$SOURCE_ENV")"; then
    echo "Warning: could not count $SOURCE_ENV services; treating readable $PR_ENV as complete" >&2
    return 1
  fi

  if ! pr_count="$(count_active_services "$PR_ENV")"; then
    echo "Railway environment $PR_ENV config is readable but service list is unavailable"
    return 0
  fi

  if [[ "$pr_count" -lt "$prod_count" ]]; then
    echo "Railway environment $PR_ENV is incomplete ($pr_count < $prod_count active services)"
    return 0
  fi

  return 1
}

create_duplicated_env() {
  railway environment new "$PR_ENV" --duplicate "$SOURCE_ENV"
}

railway link --project "$RAILWAY_PROJECT_ID" --environment "$SOURCE_ENV"

ENV_ID="$(lookup_env_id "$PR_ENV" || true)"

if [[ -n "$ENV_ID" ]] && ! env_needs_recreate; then
  echo "Railway environment $PR_ENV already exists and is duplicated from $SOURCE_ENV"
else
  if [[ -n "$ENV_ID" ]]; then
    echo "Recreating Railway environment $PR_ENV from $SOURCE_ENV"
    delete_pr_env_if_present
    wait_for_pr_env_absent || true
  else
    echo "Creating Railway environment $PR_ENV duplicated from $SOURCE_ENV"
  fi

  if ! create_duplicated_env; then
    echo "railway environment new failed; cleaning up so retry can succeed" >&2
    delete_pr_env_if_present || true
    wait_for_pr_env_absent || true
    exit 1
  fi
fi

railway link --project "$RAILWAY_PROJECT_ID" --environment "$PR_ENV"
