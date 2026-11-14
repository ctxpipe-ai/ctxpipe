#!/usr/bin/env bash
# Give a Railway PR preview its own secrets. A preview runs branch code that
# nobody has reviewed, so it must not hold a production secret or the Railway
# workspace token of the deploy job. `environment new --duplicate production`
# copies the production AUTH_SECRET and CONNECTION_SECRETS_ENCRYPTION_KEY.
#
# - AUTH_SECRET and CONNECTION_SECRETS_ENCRYPTION_KEY: new random values on
#   backend, worker, ui and codesearch (codesearch checks backend JWTs with
#   AUTH_SECRET). Connection secrets copied from production do not decrypt on
#   the preview.
# - No Railway token goes into a service variable: the backend has no use for
#   one (the worker no longer needs a wake), and branch code runs there.
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

# drop_preview_wake_token: a preview made before the removal of the worker wake can
# have a Railway token in its backend variable RAILWAY_TOKEN (a project token,
# or on the oldest previews another token). Revoke each project token of this
# preview environment; this starts no deploy. empty_preview_wake_token_var
# then empties the variable, also with no deploy. No value enters a shell variable.
drop_preview_wake_token() {
  local has_token token_ids id after page
  has_token="$(service_vars "$ENV_ID" "$BACKEND_SERVICE_ID" RAILWAY_TOKEN \
    | jq -r 'has("RAILWAY_TOKEN")')" || return 1
  # The variable decides only the delete: a token of this environment is
  # revoked even when an earlier run already deleted the variable.
  PREVIEW_HAD_WAKE_TOKEN="$has_token"
  # Read every page of project tokens, so no token of this environment stays.
  token_ids="" after="" page=""
  while :; do
    page="$(railway_graphql \
      'query projectTokens($projectId: String!, $after: String) { projectTokens(projectId: $projectId, first: 100, after: $after) { edges { node { id environmentId } } pageInfo { hasNextPage endCursor } } }' \
      "$(jq -nc --arg p "$RAILWAY_PROJECT_ID" --arg a "$after" '{projectId:$p} + (if $a == "" then {} else {after:$a} end)')")" || return 1
    token_ids+="$(jq -r --arg env "$ENV_ID" '.data.projectTokens.edges[]?.node | select(.environmentId == $env) | .id' <<<"$page")"$'\n'
    [[ "$(jq -r '.data.projectTokens.pageInfo.hasNextPage // false' <<<"$page")" == "true" ]] || break
    after="$(jq -r '.data.projectTokens.pageInfo.endCursor // empty' <<<"$page")"
    [[ -n "$after" ]] || break
  done
  for id in $token_ids; do
    railway_graphql 'mutation projectTokenDelete($id: String!) { projectTokenDelete(id: $id) }' \
      "$(jq -nc --arg id "$id" '{id:$id}')" >/dev/null || return 1
    echo "Revoked Railway project token $id of $PR_ENV"
  done
}

# empty_preview_wake_token_var: empty RAILWAY_TOKEN on the backend after
# drop_preview_wake_token found it. Railway redeploys a service on a variable
# delete, so the value is written empty with skipDeploys instead: no deploy
# starts, and no token stays in the variable.
empty_preview_wake_token_var() {
  [[ "${PREVIEW_HAD_WAKE_TOKEN:-}" == "true" ]] || return 0
  upsert_service_vars "an empty RAILWAY_TOKEN" '{"RAILWAY_TOKEN":""}' "$BACKEND_SERVICE_ID" || return 1
}

sync_preview_own_secrets() {
  local name marker auth_secret connection_key
  for name in RAILWAY_PROJECT_ID ENV_ID PR_ENV BACKEND_SERVICE_ID WORKER_SERVICE_ID UI_SERVICE_ID CODESEARCH_SERVICE_ID; do
    if [[ -z "${!name:-}" ]]; then
      echo "preview-own-secrets: $name is required" >&2
      return 1
    fi
  done
  marker="$(service_vars "$ENV_ID" "$BACKEND_SERVICE_ID" PREVIEW_OWN_SECRETS \
    | jq -r '.PREVIEW_OWN_SECRETS // ""')" || return 1
  drop_preview_wake_token || return 1
  if [[ "$marker" == "v1" ]]; then
    empty_preview_wake_token_var || return 1
    echo "Preview $PR_ENV keeps its own AUTH_SECRET and connection-secrets key"
    return 0
  fi

  auth_secret="$(openssl rand -hex 32)"
  connection_key="$(openssl rand -hex 32)"
  preview_own_secrets_mask "$auth_secret"
  preview_own_secrets_mask "$connection_key"

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
  upsert_service_vars "own AUTH_SECRET and connection-secrets key" \
    "$(jq -nc --arg auth "$auth_secret" --arg key "$connection_key" \
      '{AUTH_SECRET:$auth, CONNECTION_SECRETS_ENCRYPTION_KEY:$key, PREVIEW_OWN_SECRETS:"v1"}')" \
    "$BACKEND_SERVICE_ID" || return 1
  empty_preview_wake_token_var || return 1
  echo "Preview $PR_ENV now has its own AUTH_SECRET and connection-secrets key. Connection secrets copied from production do not decrypt on it."
}
