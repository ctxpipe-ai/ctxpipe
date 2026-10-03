#!/usr/bin/env bash
# Point a Railway PR preview's backend and worker at Vercel sandboxes for
# hosted chat. Hosted never runs chat unsandboxed, so a missing
# VERCEL_ACCESS_TOKEN fails the deploy. Production gets the same variables
# from Terraform (infra/module/ctxpipe/railway.tf).
# Uses the caller's railway_graphql; never prints the token.
# GraphQL documents are single-quoted on purpose.
# shellcheck disable=SC2016
set -euo pipefail

sync_preview_sandbox_variables() {
  local name service_id vars_json
  if ! declare -F railway_graphql >/dev/null; then
    echo "preview-sandbox-vars: railway_graphql is not defined" >&2
    return 1
  fi
  if [[ -z "${VERCEL_ACCESS_TOKEN:-}" ]]; then
    echo "preview-sandbox-vars: the VERCEL_ACCESS_TOKEN secret is empty; hosted chat needs it" >&2
    return 1
  fi
  for name in RAILWAY_PROJECT_ID ENV_ID BACKEND_SERVICE_ID WORKER_SERVICE_ID; do
    if [[ -z "${!name:-}" ]]; then
      echo "preview-sandbox-vars: $name is required" >&2
      return 1
    fi
  done
  vars_json="$(jq -nc --arg token "$VERCEL_ACCESS_TOKEN" '{
    SANDBOX_PROVIDER: "vercel",
    VERCEL_TOKEN: $token,
    VERCEL_TEAM_ID: "ctxpipe",
    VERCEL_PROJECT_ID: "ctxpipe"
  }')"
  for service_id in "$BACKEND_SERVICE_ID" "$WORKER_SERVICE_ID"; do
    railway_graphql \
      'mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }' \
      "$(jq -nc --arg project "$RAILWAY_PROJECT_ID" --arg env "$ENV_ID" --arg service "$service_id" --argjson vars "$vars_json" \
        '{input:{projectId:$project,environmentId:$env,serviceId:$service,skipDeploys:true,variables:$vars}}')" >/dev/null || return 1
    echo "Set Vercel sandbox variables on service $service_id"
  done
}
