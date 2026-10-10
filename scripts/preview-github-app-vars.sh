#!/usr/bin/env bash
# Point a Railway PR preview's backend and worker at the preview GitHub App.
# A preview runs branch code that nobody has reviewed, so it must never hold
# the production GitHub App credentials that `environment new --duplicate
# production` copies. The job runs in the GitHub environment Preview. Its
# secrets GH_APP_ID, GH_APP_SLUG, GH_CLIENT_ID, GH_CLIENT_SECRET,
# GH_PRIVATE_KEY and GH_WEBHOOK_SECRET belong to the preview App (GitHub
# rejects secret names that start with GITHUB_). An empty secret fails the
# deploy, because the preview would otherwise keep the production App.
set -euo pipefail
# shellcheck source=scripts/preview-service-vars.sh
source "$(dirname "${BASH_SOURCE[0]}")/preview-service-vars.sh"

sync_preview_github_app_variables() {
  local name missing=()
  for name in GH_APP_ID GH_APP_SLUG GH_CLIENT_ID GH_CLIENT_SECRET GH_PRIVATE_KEY GH_WEBHOOK_SECRET; do
    if [[ -z "${!name:-}" ]]; then
      missing+=("$name")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "preview-github-app-vars: these Preview environment secrets are empty: ${missing[*]}." >&2
    echo "preview-github-app-vars: a preview must not keep the production GitHub App; set the preview App secrets." >&2
    return 1
  fi
  upsert_service_vars "preview GitHub App variables" \
    "$(jq -nc \
      --arg app_id "$GH_APP_ID" \
      --arg slug "$GH_APP_SLUG" \
      --arg client_id "$GH_CLIENT_ID" \
      --arg client_secret "$GH_CLIENT_SECRET" \
      --arg private_key "$GH_PRIVATE_KEY" \
      --arg webhook_secret "$GH_WEBHOOK_SECRET" \
      '{
        GITHUB_APP_ID: $app_id,
        GITHUB_APP_SLUG: $slug,
        GITHUB_CLIENT_ID: $client_id,
        GITHUB_CLIENT_SECRET: $client_secret,
        GITHUB_PRIVATE_KEY: $private_key,
        GITHUB_WEBHOOK_SECRET: $webhook_secret
      }')" \
    "${BACKEND_SERVICE_ID:-}" "${WORKER_SERVICE_ID:-}"
}
