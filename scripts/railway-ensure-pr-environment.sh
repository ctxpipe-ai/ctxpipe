#!/usr/bin/env bash
# Ensure a Railway PR preview environment exists and is duplicated from production.
# If the env exists but is incomplete (e.g. duplicate failed mid-flight), delete and recreate.

set -euo pipefail

usage() {
  echo "Usage: $0 <railway_project_id> <pr_environment_name> [source_environment=production]" >&2
  exit 1
}

[[ $# -ge 2 && $# -le 3 ]] || usage

RAILWAY_PROJECT_ID="$1"
PR_ENV="$2"
SOURCE_ENV="${3:-production}"

count_active_services() {
  local env_name="$1"
  railway environment config --environment "$env_name" --json \
    | jq '[.services | to_entries[] | select(.value.is_deleted != true)] | length'
}

environment_exists() {
  railway environment config --environment "$1" --json >/dev/null 2>&1
}

delete_pr_environment_if_present() {
  if environment_exists "$PR_ENV"; then
    echo "Deleting Railway environment $PR_ENV"
    railway environment delete "$PR_ENV" --yes
  fi
}

railway link --project "$RAILWAY_PROJECT_ID" --environment "$SOURCE_ENV"

PROD_SERVICE_COUNT="$(count_active_services "$SOURCE_ENV")"
echo "$SOURCE_ENV has $PROD_SERVICE_COUNT active service(s)"

if environment_exists "$PR_ENV"; then
  PR_SERVICE_COUNT="$(count_active_services "$PR_ENV")"
  echo "Railway environment $PR_ENV exists with $PR_SERVICE_COUNT active service(s)"
  if [[ "$PR_SERVICE_COUNT" -ge "$PROD_SERVICE_COUNT" ]]; then
    echo "PR environment already duplicated from $SOURCE_ENV"
    railway link --project "$RAILWAY_PROJECT_ID" --environment "$PR_ENV"
    exit 0
  fi
  echo "PR environment is incomplete ($PR_SERVICE_COUNT < $PROD_SERVICE_COUNT); recreating from $SOURCE_ENV"
  delete_pr_environment_if_present
else
  echo "Creating Railway environment $PR_ENV duplicated from $SOURCE_ENV"
fi

if ! railway environment new "$PR_ENV" --duplicate "$SOURCE_ENV"; then
  echo "railway environment new failed; removing partial environment if present" >&2
  delete_pr_environment_if_present || true
  exit 1
fi

PR_SERVICE_COUNT="$(count_active_services "$PR_ENV")"
if [[ "$PR_SERVICE_COUNT" -lt "$PROD_SERVICE_COUNT" ]]; then
  echo "PR environment still incomplete after duplicate ($PR_SERVICE_COUNT < $PROD_SERVICE_COUNT)" >&2
  delete_pr_environment_if_present || true
  exit 1
fi

echo "Railway environment $PR_ENV ready with $PR_SERVICE_COUNT active service(s)"
railway link --project "$RAILWAY_PROJECT_ID" --environment "$PR_ENV"
