#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$root/scripts/preview-github-app-vars.sh"
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Production backend variables that the mock Railway returns.
PROD_VARS='{"GITHUB_APP_ID":"999","GITHUB_CLIENT_ID":"Iv1.production","GITHUB_CLIENT_SECRET":"prod-secret"}'

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
        *environments*)
          jq -n '{data:{project:{environments:{edges:[{node:{id:"env_prod",name:"production"}}]}}}}'
          ;;
        *"query variables"*)
          [[ "$PROD_VARS" != "fail" ]] || return 22
          printf '%s\n' "$2" >"$tmp/prod_read"
          jq -nc --argjson vars "$PROD_VARS" '{data:{variables:$vars}}'
          ;;
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
  printf '%s' "$out" | grep -Fq "$name" || fail "the error should name $name: $out"
  [[ ! -s "$tmp/empty-$name/upserts" ]] || fail "nothing should be written when $name is empty"
done

jq -e '.environmentId == "env_prod" and .serviceId == "svc_backend"' "$tmp/ok/prod_read" >/dev/null \
  || fail "the guard should read the production backend"

expect_production_failure() {
  local label="$1" prod_vars="$2" want="$3" out
  shift 3
  if out="$(PROD_VARS="$prod_vars"; export "$@"; run_sync "$tmp/$label" 2>&1)"; then
    fail "sync should fail: $label"
  fi
  printf '%s' "$out" | grep -Fq "$want" || fail "$label: the error should say '$want': $out"
  if printf '%s' "$out" | grep -Fq "prod-secret"; then
    fail "$label: the guard must not print a production value"
  fi
  [[ ! -s "$tmp/$label/upserts" ]] || fail "$label: nothing should be written"
}

expect_production_failure same-app-id "$PROD_VARS" "equal to the production GitHub App: GH_APP_ID." GH_APP_ID=999
expect_production_failure same-client-id "$PROD_VARS" "equal to the production GitHub App: GH_CLIENT_ID." "GH_CLIENT_ID= Iv1.production "
expect_production_failure same-both "$PROD_VARS" "GH_APP_ID GH_CLIENT_ID." GH_APP_ID=999 GH_CLIENT_ID=Iv1.production
expect_production_failure no-production-ids '{"OTHER":"x"}' "cannot prove that the preview App is different" GH_APP_ID=123456
expect_production_failure read-error fail "cannot read the production GitHub App id" GH_APP_ID=123456

echo "preview-github-app-vars tests passed"
