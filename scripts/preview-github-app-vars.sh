#!/usr/bin/env bash
# Point a Railway PR preview's backend and worker at the preview GitHub App.
# A preview runs branch code that nobody has reviewed, so it must never hold
# the production GitHub App credentials that `environment new --duplicate
# production` copies. The job runs in the GitHub environment Preview. Its
# secrets GH_* belong to the preview App (GitHub rejects secret names that
# start with GITHUB_). Every environment uses the same names. A missing Preview
# secret falls back to a repository secret with the same name, if one exists.
# An empty secret fails the deploy, because the preview would otherwise keep
# the production App.
set -euo pipefail
# shellcheck source=scripts/preview-service-vars.sh
source "$(dirname "${BASH_SOURCE[0]}")/preview-service-vars.sh"

# Railway variable <- Preview environment secret. The only list of the names.
preview_github_app_vars_json() {
  jq -nc 'env | {
    GITHUB_APP_ID: .GH_APP_ID,
    GITHUB_APP_SLUG: .GH_APP_SLUG,
    GITHUB_CLIENT_ID: .GH_CLIENT_ID,
    GITHUB_CLIENT_SECRET: .GH_CLIENT_SECRET,
    GITHUB_PRIVATE_KEY: .GH_PRIVATE_KEY,
    GITHUB_WEBHOOK_SECRET: .GH_WEBHOOK_SECRET
  }'
}

check_preview_github_app_secrets() {
  local missing
  missing="$(preview_github_app_vars_json \
    | jq -r '[to_entries[] | select((.value // "") == "") | .key | sub("^GITHUB_"; "GH_")] | join(" ")')"
  if [[ -n "$missing" ]]; then
    echo "preview-github-app-vars: these Preview environment secrets are empty: $missing." >&2
    echo "preview-github-app-vars: a preview must not keep the production GitHub App; set the preview App secrets." >&2
    return 1
  fi
}

sync_preview_github_app_variables() {
  check_preview_github_app_secrets || return 1
  upsert_service_vars "preview GitHub App variables" "$(preview_github_app_vars_json)" \
    "${BACKEND_SERVICE_ID:-}" "${WORKER_SERVICE_ID:-}"
}
