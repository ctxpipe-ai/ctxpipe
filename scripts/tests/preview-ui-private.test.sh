#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$root/scripts/preview-ui-private.sh"
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

bash -n "$script" || fail "preview-ui-private.sh must pass bash -n"

# Runs one function from the script against a fake Railway API.
# $1: work dir. $2: JSON for the UI service domains. $3: function name.
# The fake records each upsert and each domain delete in the work dir.
run_with_fake_railway() {
  local tmp="$1" domains="$2" fn="$3"
  mkdir -p "$tmp"
  : >"$tmp/upserts"
  : >"$tmp/deletes"
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
        *serviceInstance*)
          jq -nc --argjson d "$domains" '{data:{serviceInstance:{domains:{serviceDomains:$d,customDomains:[]}}}}'
          ;;
        *serviceDomainDelete*)
          if [[ "${FAKE_DELETE_FAILS:-}" == 1 ]]; then
            return 22
          fi
          printf '%s\n' "$2" >>"$tmp/deletes"
          echo '{"data":{"serviceDomainDelete":true}}'
          ;;
        *) echo "unexpected query: $1" >&2; return 1 ;;
      esac
    }
    export RAILWAY_PROJECT_ID=proj_test ENV_ID=env_preview
    export BACKEND_SERVICE_ID=svc_backend UI_SERVICE_ID=svc_ui
    "$fn"
  )
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# The backend proxies to the UI over this environment's private network.
run_with_fake_railway "$tmp/proxy" '[]' point_preview_backend_at_private_ui >/dev/null \
  || fail "point_preview_backend_at_private_ui should succeed"
jq -se '
  length == 1
  and .[0].input.projectId == "proj_test"
  and .[0].input.environmentId == "env_preview"
  and .[0].input.serviceId == "svc_backend"
  and .[0].input.skipDeploys == true
  and .[0].input.variables == {UI_PROXY_URL: "http://${{ui.RAILWAY_PRIVATE_DOMAIN}}:3002"}
' "$tmp/proxy/upserts" >/dev/null \
  || fail "backend UI_PROXY_URL should be the UI private domain on port 3002: $(cat "$tmp/proxy/upserts")"

# Each public domain on the preview UI is deleted, in this environment only.
run_with_fake_railway "$tmp/remove" \
  '[{"id":"dom_one","domain":"ui-pr-1.up.railway.app"},{"id":"dom_two","domain":"ui-pr-1-x.up.railway.app"}]' \
  remove_preview_ui_public_domains >/dev/null \
  || fail "remove_preview_ui_public_domains should succeed"
jq -se 'map(.id) == ["dom_one", "dom_two"]' "$tmp/remove/deletes" >/dev/null \
  || fail "each UI service domain should be deleted: $(cat "$tmp/remove/deletes")"
[[ ! -s "$tmp/remove/upserts" ]] || fail "domain removal must not change variables"

# A UI without a public domain needs no change.
run_with_fake_railway "$tmp/none" '[]' remove_preview_ui_public_domains >/dev/null \
  || fail "remove_preview_ui_public_domains should succeed with no domains"
[[ ! -s "$tmp/none/deletes" ]] || fail "no domain means no delete call"

# A failed delete fails the step, so a public UI domain cannot stay quietly.
if FAKE_DELETE_FAILS=1 run_with_fake_railway "$tmp/fails" \
  '[{"id":"dom_one","domain":"ui-pr-1.up.railway.app"}]' \
  remove_preview_ui_public_domains >/dev/null 2>&1; then
  fail "a failed domain delete should fail the function"
fi

echo "preview-ui-private tests passed"
