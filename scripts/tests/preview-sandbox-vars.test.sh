#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$root/scripts/preview-sandbox-vars.sh"
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
    export BACKEND_SERVICE_ID=svc_backend WORKER_SERVICE_ID=svc_worker
    sync_preview_sandbox_variables
  )
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

out="$(VERCEL_ACCESS_TOKEN=vercel-secret-value run_sync "$tmp/ok" 2>&1)" \
  || fail "sync should succeed with a token: $out"
if printf '%s' "$out" | grep -Fq vercel-secret-value; then
  fail "sync must not print the Vercel token"
fi
jq -se '
  map(.input) as $rows
  | ($rows | map(.serviceId)) == ["svc_backend", "svc_worker"]
  and all($rows[];
    .projectId == "proj_test" and .environmentId == "env_preview"
    and .skipDeploys == true
    and .variables == {
      SANDBOX_PROVIDER: "vercel",
      VERCEL_TOKEN: "vercel-secret-value",
      VERCEL_TEAM_ID: "ctxpipe",
      VERCEL_PROJECT_ID: "ctxpipe"
    })
' "$tmp/ok/upserts" >/dev/null || fail "backend and worker should get the four sandbox variables"

if VERCEL_ACCESS_TOKEN="" run_sync "$tmp/empty" >/dev/null 2>&1; then
  fail "sync should fail when VERCEL_ACCESS_TOKEN is empty"
fi
[[ ! -s "$tmp/empty/upserts" ]] || fail "nothing should be written without a token"

for workflow in \
  "$root/.github/workflows/pr-deploy.yaml" \
  "$root/.github/workflows/pr-preview-roll-existing.yaml"
do
  grep -Fq 'scripts/preview-sandbox-vars.sh' "$workflow" || fail "$workflow must source scripts/preview-sandbox-vars.sh"
  grep -Fq 'VERCEL_ACCESS_TOKEN: ${{ secrets.VERCEL_ACCESS_TOKEN }}' "$workflow" \
    || fail "$workflow must pass the VERCEL_ACCESS_TOKEN secret"
  [[ "$(grep -c 'sync_preview_sandbox_variables$' "$workflow")" == 1 ]] \
    || fail "$workflow must invoke sync_preview_sandbox_variables once"
done

echo "preview-sandbox-vars tests passed"
