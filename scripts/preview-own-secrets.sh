#!/usr/bin/env bash
# Give a Railway PR preview its own secrets. A preview runs branch code that
# nobody has reviewed, so it must not hold a production secret or the Railway
# account token of the deploy job. `environment new --duplicate production`
# copies the production AUTH_SECRET and CONNECTION_SECRETS_ENCRYPTION_KEY.
#
# - AUTH_SECRET and CONNECTION_SECRETS_ENCRYPTION_KEY: new random values on
#   backend, worker, ui and codesearch (codesearch checks backend JWTs with
#   AUTH_SECRET). Connection secrets copied from production do not decrypt on
#   the preview.
# - RAILWAY_TOKEN on the backend (worker wake): a Railway project token that
#   Railway scopes to this preview environment only. The script never writes
#   the account token RAILWAY_API_TOKEN into a service variable.
#
# - The `jwkss` rows: the Neon branch copies the production JWKS keys, whose
#   private keys the production AUTH_SECRET encrypted. The step deletes them in
#   the preview database (OWNER_DB_URL, the owner URL of the preview Neon
#   branch, never production), so the backend makes a key with its own secret.
#   Without OWNER_DB_URL (pr-preview-roll-existing.yaml), the backend ignores
#   keys that it cannot decrypt and makes a new key.
#
# The backend variable PREVIEW_OWN_SECRETS records that the preview has these
# values, so later rolls keep them for the life of the preview. Production does
# not have it, so the duplicate never copies it. The backend gets its values
# last, so the marker means every service has them.
#
# Uses the caller's railway_graphql. Never prints a value.
set -euo pipefail
# shellcheck source=scripts/preview-service-vars.sh
source "$(dirname "${BASH_SOURCE[0]}")/preview-service-vars.sh"

preview_own_secrets_mask() {
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    echo "::add-mask::$1"
  fi
}

sync_preview_own_secrets() {
  local name marker auth_secret connection_key wake_token
  for name in RAILWAY_PROJECT_ID ENV_ID PR_ENV BACKEND_SERVICE_ID WORKER_SERVICE_ID UI_SERVICE_ID CODESEARCH_SERVICE_ID; do
    if [[ -z "${!name:-}" ]]; then
      echo "preview-own-secrets: $name is required" >&2
      return 1
    fi
  done
  marker="$(service_vars "$ENV_ID" "$BACKEND_SERVICE_ID" PREVIEW_OWN_SECRETS \
    | jq -r '.PREVIEW_OWN_SECRETS // ""')" || return 1
  if [[ "$marker" == "v1" ]]; then
    echo "Preview $PR_ENV keeps its own AUTH_SECRET, connection-secrets key and wake token"
    return 0
  fi

  auth_secret="$(openssl rand -hex 32)"
  connection_key="$(openssl rand -hex 32)"
  preview_own_secrets_mask "$auth_secret"
  preview_own_secrets_mask "$connection_key"
  wake_token="$(railway_graphql \
    'mutation projectTokenCreate($input: ProjectTokenCreateInput!) { projectTokenCreate(input: $input) }' \
    "$(jq -nc --arg project "$RAILWAY_PROJECT_ID" --arg env "$ENV_ID" --arg name "$PR_ENV worker wake" \
      '{input:{projectId:$project, environmentId:$env, name:$name}}')" \
    | jq -r '.data.projectTokenCreate // empty')" || wake_token=""
  if [[ -z "$wake_token" ]]; then
    echo "preview-own-secrets: Railway did not create a project token for $PR_ENV (projectTokenCreate)." >&2
    echo "preview-own-secrets: the backend must not wake the worker with the account token RAILWAY_API_TOKEN, so the deploy stops." >&2
    return 1
  fi
  preview_own_secrets_mask "$wake_token"

  if [[ -n "${OWNER_DB_URL:-}" ]]; then
    psql "$OWNER_DB_URL" -v ON_ERROR_STOP=1 -qc 'DELETE FROM jwkss' >/dev/null || {
      echo "preview-own-secrets: could not delete the JWKS keys copied from production" >&2
      return 1
    }
    echo "Deleted the JWKS keys that the Neon branch copied from production"
  else
    echo "No preview database URL: the backend ignores the JWKS keys copied from production"
  fi

  upsert_service_vars "own AUTH_SECRET and connection-secrets key" \
    "$(jq -nc --arg auth "$auth_secret" --arg key "$connection_key" \
      '{AUTH_SECRET:$auth, CONNECTION_SECRETS_ENCRYPTION_KEY:$key}')" \
    "$WORKER_SERVICE_ID" "$UI_SERVICE_ID" "$CODESEARCH_SERVICE_ID" || return 1
  upsert_service_vars "own AUTH_SECRET, connection-secrets key and environment-scoped wake token" \
    "$(jq -nc --arg auth "$auth_secret" --arg key "$connection_key" --arg token "$wake_token" \
      '{AUTH_SECRET:$auth, CONNECTION_SECRETS_ENCRYPTION_KEY:$key, RAILWAY_TOKEN:$token, PREVIEW_OWN_SECRETS:"v1"}')" \
    "$BACKEND_SERVICE_ID" || return 1
  echo "Preview $PR_ENV now has its own AUTH_SECRET and connection-secrets key. Connection secrets copied from production do not decrypt on it."
}
