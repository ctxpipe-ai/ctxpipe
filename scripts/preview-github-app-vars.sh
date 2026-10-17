#!/usr/bin/env bash
# Point a Railway PR preview's backend and worker at the preview GitHub App.
# A preview runs branch code that nobody has reviewed, so it must never hold
# the production GitHub App credentials that `environment new --duplicate
# production` copies. The job runs in the GitHub environment Preview. Its
# secrets GH_* belong to the preview App (GitHub rejects secret names that
# start with GITHUB_). Every environment uses the same names. A missing Preview
# secret falls back to a repository secret with the same name, if one exists,
# and a repository secret can hold a production value. Thus the deploy fails
# when a secret is empty, and also when GH_APP_ID or GH_CLIENT_ID is equal to
# the value on the production backend.
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
  check_preview_github_app_differs_from_production
}

# Compare the preview App id and client id with the production backend. Read
# only those two variables. Fail closed when Railway gives neither value.
check_preview_github_app_differs_from_production() {
  local prod prod_app_id prod_client_id same=""
  if ! prod="$(production_backend_vars GITHUB_APP_ID GITHUB_CLIENT_ID)"; then
    echo "preview-github-app-vars: cannot read the production GitHub App id and client id to compare." >&2
    return 1
  fi
  prod_app_id="$(printf '%s' "$prod" | jq -r '.GITHUB_APP_ID // "" | gsub("^\\s+|\\s+$"; "")')"
  prod_client_id="$(printf '%s' "$prod" | jq -r '.GITHUB_CLIENT_ID // "" | gsub("^\\s+|\\s+$"; "")')"
  if [[ -z "$prod_app_id" && -z "$prod_client_id" ]]; then
    echo "preview-github-app-vars: the production backend has no GITHUB_APP_ID or GITHUB_CLIENT_ID, so the deploy cannot prove that the preview App is different." >&2
    return 1
  fi
  [[ -n "$prod_app_id" && "$(preview_trim "$GH_APP_ID")" == "$prod_app_id" ]] && same+=" GH_APP_ID"
  [[ -n "$prod_client_id" && "$(preview_trim "$GH_CLIENT_ID")" == "$prod_client_id" ]] && same+=" GH_CLIENT_ID"
  if [[ -n "$same" ]]; then
    echo "preview-github-app-vars: these Preview secrets are equal to the production GitHub App:${same}." >&2
    echo "preview-github-app-vars: a missing Preview environment secret falls back to the repository secret. Set the preview App values in the GitHub environment Preview." >&2
    return 1
  fi
}

preview_trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  printf '%s' "${value%"${value##*[![:space:]]}"}"
}

sync_preview_github_app_variables() {
  check_preview_github_app_secrets || return 1
  upsert_service_vars "preview GitHub App variables" "$(preview_github_app_vars_json)" \
    "${BACKEND_SERVICE_ID:-}" "${WORKER_SERVICE_ID:-}"
}
