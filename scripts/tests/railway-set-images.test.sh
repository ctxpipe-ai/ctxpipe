#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# deploy <tmp> <latest deployment image> <deploy response>
# Runs railway-set-images.sh against a fake curl. Every service has source
# image ...:new. The latest deployment of every service runs <image>.
deploy() {
  local tmp="$1" running="$2" deploy_response="$3"
  mkdir -p "$tmp/bin"
  : >"$tmp/calls"
  cat >"$tmp/bin/curl" <<FAKE
#!/usr/bin/env bash
while [[ \$# -gt 0 && "\$1" != "-d" ]]; do shift; done
op="\$(printf '%s' "\$2" | jq -r '.query' | awk '{print \$2}' | cut -d'(' -f1)"
service="\$(printf '%s' "\$2" | jq -r '.variables.serviceId // empty')"
echo "\$op \$service" >>"$tmp/calls"
case "\$op" in
  Project) body='{"data":{"project":{"environments":{"edges":[{"node":{"id":"env_prod","name":"production"}}]},"services":{"edges":[{"node":{"id":"svc_backend","name":"backend"}},{"node":{"id":"svc_ui","name":"ui"}},{"node":{"id":"svc_openworkflow","name":"openworkflow"}},{"node":{"id":"svc_codesearch","name":"codesearch"}}]}}}}' ;;
  serviceInstanceSource)
    repo="\${service#svc_}"
    [[ "\$repo" != openworkflow ]] || repo=worker
    body="{\"data\":{\"serviceInstance\":{\"source\":{\"image\":\"ghcr.io/ctxpipe-ai/\$repo:new\"},\"latestDeployment\":{\"status\":\"SUCCESS\",\"meta\":{\"image\":\"ghcr.io/ctxpipe-ai/\$repo:$running\"}}}}}" ;;
  serviceInstanceDeployV2) body='$deploy_response' ;;
  deploymentStatus) body='{"data":{"deployment":{"id":"dep_1","status":"SUCCESS"}}}' ;;
  *) body='{"errors":[{"message":"unexpected call"}]}' ;;
esac
printf '%s\n200' "\$body"
FAKE
  chmod +x "$tmp/bin/curl"
  PATH="$tmp/bin:$PATH" RAILWAY_TOKEN=token RAILWAY_PROJECT_ID=proj_test IMAGE_TAG=new \
    bash "$root/scripts/railway-set-images.sh"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
deployed='{"data":{"serviceInstanceDeployV2":"dep_1"}}'

# A failed deploy left the source image at the new tag. The old image runs.
deploy "$tmp/stale" old "$deployed" >"$tmp/stale.out" 2>&1 || fail "a stale deploy should succeed: $(cat "$tmp/stale.out")"
[[ "$(grep -c '^serviceInstanceDeployV2 ' "$tmp/stale/calls")" -eq 4 ]] \
  || fail "should deploy every service whose latest deployment runs the old image"

deploy "$tmp/current" new "$deployed" >"$tmp/current.out" 2>&1 || fail "a current deploy should succeed: $(cat "$tmp/current.out")"
if grep -q '^serviceInstanceDeployV2 ' "$tmp/current/calls"; then
  fail "should skip a service whose latest deployment already runs the new image"
fi

refused='{"errors":[{"message":"Problem processing request","traceId":"1"}]}'
if deploy "$tmp/refused" old "$refused" >"$tmp/refused.out" 2>&1; then
  fail "a refused deploy must fail"
fi
grep -q "did not start a deployment of backend (svc_backend) in production (env_prod) at new" "$tmp/refused.out" \
  || fail "the failure should name the service and the environment: $(cat "$tmp/refused.out")"
grep -q "status.railway.com" "$tmp/refused.out" || fail "the failure should name the cause"
grep -q "re-run the failed jobs" "$tmp/refused.out" || fail "the failure should name the fix"
[[ "$(grep -c '^serviceInstanceDeployV2 ' "$tmp/refused/calls")" -eq 1 ]] || fail "should stop at the first refused deploy"

echo "railway-set-images tests passed"
