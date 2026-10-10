#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$root/scripts/preview-github-app-vars.sh"
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

run_sync() {
  local tmp="$1"
  mkdir -p "$tmp"
  : >"$tmp/upserts"
  (
    # shellcheck disable=SC1090
    source "$script"
    # shellcheck disable=SC2329 # the sourced script calls it
    railway_graphql() {
      case "$1" in
        *variableCollectionUpsert*)
          printf '%s\n' "$2" >>"$tmp/upserts"
          echo '{"data":{"variableCollectionUpsert":true}}'
          ;;
        *) echo "unexpected query: $1" >&2; return 1 ;;
      esac
    }
    export RAILWAY_PROJECT_ID=proj_test ENV_ID=env_preview
    export BACKEND_SERVICE_ID=svc_backend
    export WORKER_SERVICE_ID=svc_worker
    sync_preview_github_app_variables
  )
}

private_key=$'-----BEGIN RSA PRIVATE KEY-----\nline-one+/=\nline-two "quoted" \\back\n-----END RSA PRIVATE KEY-----'
export GH_APP_ID=123456 GH_APP_SLUG=preview-app GH_CLIENT_ID=Iv1.preview \
  GH_CLIENT_SECRET=client-secret-value GH_PRIVATE_KEY="$private_key" \
  GH_WEBHOOK_SECRET=webhook-secret-value

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

out="$(run_sync "$tmp/ok" 2>&1)" || fail "sync should succeed with every secret: $out"
for secret in client-secret-value webhook-secret-value line-one; do
  if printf '%s' "$out" | grep -Fq "$secret"; then
    fail "sync must not print a secret value ($secret)"
  fi
done
jq -se --arg key "$private_key" '
  map(.input) as $rows
  | ($rows | map(.serviceId)) == ["svc_backend", "svc_worker"]
  and all($rows[];
    .projectId == "proj_test" and .environmentId == "env_preview"
    and .skipDeploys == true
    and .variables == {
      GITHUB_APP_ID: "123456",
      GITHUB_APP_SLUG: "preview-app",
      GITHUB_CLIENT_ID: "Iv1.preview",
      GITHUB_CLIENT_SECRET: "client-secret-value",
      GITHUB_PRIVATE_KEY: $key,
      GITHUB_WEBHOOK_SECRET: "webhook-secret-value"
    })
' "$tmp/ok/upserts" >/dev/null \
  || fail "backend and worker should get the six preview App variables, with the multi-line key intact"

for name in GH_APP_ID GH_APP_SLUG GH_CLIENT_ID GH_CLIENT_SECRET GH_PRIVATE_KEY GH_WEBHOOK_SECRET; do
  if out="$(export "$name="; run_sync "$tmp/empty-$name" 2>&1)"; then
    fail "sync should fail when $name is empty"
  fi
  printf '%s' "$out" | grep -Fq "PREVIEW_$name" || fail "the error should name the secret PREVIEW_$name: $out"
  [[ ! -s "$tmp/empty-$name/upserts" ]] || fail "nothing should be written when $name is empty"
done

echo "preview-github-app-vars tests passed"
