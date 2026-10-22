#!/usr/bin/env bash
# Give a Railway PR preview the secrets of the GitHub Environment `Preview`.
# `environment new --duplicate production` copies every production variable.
# railway-sync-variables.py --preview writes each Preview value and deletes
# each one that Preview does not set, so no production secret stays. The other
# preview scripts own AUTH_SECRET, CONNECTION_SECRETS_ENCRYPTION_KEY, the
# GitHub App, Vercel and the OTLP header.
#
# Uses the caller's railway_graphql. Writes with skipDeploys: the roll deploys
# each service after this. Never prints a value.
set -euo pipefail

sync_preview_secrets() {
  local name falkordb_service_id
  for name in RAILWAY_PROJECT_ID ENV_ID BACKEND_SERVICE_ID WORKER_SERVICE_ID UI_SERVICE_ID CODESEARCH_SERVICE_ID; do
    if [[ -z "${!name:-}" ]]; then
      echo "preview-secrets: $name is required" >&2
      return 1
    fi
  done
  # shellcheck disable=SC2016
  falkordb_service_id="$(railway_graphql \
    'query Project($id: String!) { project(id: $id) { services { edges { node { id name } } } } }' \
    "$(jq -nc --arg id "$RAILWAY_PROJECT_ID" '{id:$id}')" \
    | jq -er '.data.project.services.edges[].node | select(.name == "falkordb") | .id')"
  local script
  script="$(dirname "${BASH_SOURCE[0]}")/railway-sync-variables.py"
  local pair service service_id
  for pair in "falkordb:$falkordb_service_id" "backend:$BACKEND_SERVICE_ID" \
    "openworkflow:$WORKER_SERVICE_ID" "codesearch:$CODESEARCH_SERVICE_ID" "ui:$UI_SERVICE_ID"; do
    service="${pair%%:*}"
    service_id="${pair#*:}"
    PROJECT_ID="$RAILWAY_PROJECT_ID" ENVIRONMENT_ID="$ENV_ID" SERVICE_ID="$service_id" \
      python3 -I "$script" --service "$service" --preview
  done
}
