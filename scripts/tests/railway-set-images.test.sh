#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# deploy <tmp> <latest deployment image> <deploy response> [meta JSON] [status]
# The optional meta JSON replaces the default {"image":"<repo>:<image>"}.
# Runs railway-set-images.sh against a fake curl. Every service has source
# image ...:new. The latest deployment of every service runs <image>.
deploy() {
  local tmp="$1" running="$2" deploy_response="$3" meta="${4:-}" status="${5:-SUCCESS}"
  [[ -n "$meta" ]] || meta="{\"image\":\"ghcr.io/ctxpipe-ai/REPO:$running\"}"
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
    meta='$meta'
    meta="\${meta//REPO/\$repo}"
    body="{\"data\":{\"serviceInstance\":{\"source\":{\"image\":\"ghcr.io/ctxpipe-ai/\$repo:new\"},\"latestDeployment\":{\"status\":\"$status\",\"meta\":\$meta}}}}" ;;
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

# Railway may record the image with a digest. The tag inside the meta still matches.
deploy "$tmp/digest" new "$deployed" '{"image":"ghcr.io/ctxpipe-ai/REPO:new@sha256:abc123"}' >"$tmp/digest.out" 2>&1 || fail "a digest deploy should succeed: $(cat "$tmp/digest.out")"
if grep -q '^serviceInstanceDeployV2 ' "$tmp/digest/calls"; then
  fail "should skip a service whose meta image is repo:tag@sha256"
fi

# A meta with only a digest does not name the tag. Deploy.
deploy "$tmp/onlydigest" new "$deployed" '{"imageDigest":"sha256:abc123"}' >"$tmp/onlydigest.out" 2>&1 || fail "an imageDigest-only deploy should succeed: $(cat "$tmp/onlydigest.out")"
[[ "$(grep -c '^serviceInstanceDeployV2 ' "$tmp/onlydigest/calls")" -eq 4 ]] \
  || fail "should deploy every service whose meta has only an imageDigest"

# The right tag with a status that is not SUCCESS or SLEEPING. Deploy.
deploy "$tmp/failed" new "$deployed" "" FAILED >"$tmp/failed.out" 2>&1 || fail "a failed-status deploy should succeed: $(cat "$tmp/failed.out")"
[[ "$(grep -c '^serviceInstanceDeployV2 ' "$tmp/failed/calls")" -eq 4 ]] \
  || fail "should deploy every service whose latest deployment is not SUCCESS or SLEEPING"

# The synced variables changed. A service that already runs the new image deploys again.
FORCE_DEPLOY=1 deploy "$tmp/forced" new "$deployed" >"$tmp/forced.out" 2>&1 || fail "a forced deploy should succeed: $(cat "$tmp/forced.out")"
[[ "$(grep -c '^serviceInstanceDeployV2 ' "$tmp/forced/calls")" -eq 4 ]] \
  || fail "FORCE_DEPLOY=1 should deploy every service, also one that already runs the new image"

refused='{"errors":[{"message":"Problem processing request","traceId":"1"}]}'
if deploy "$tmp/refused" old "$refused" >"$tmp/refused.out" 2>&1; then
  fail "a refused deploy must fail"
fi
grep -q "did not start a deployment of codesearch (svc_codesearch) in production (env_prod) at new" "$tmp/refused.out" \
  || fail "the failure should name the service and the environment: $(cat "$tmp/refused.out")"
grep -q "status.railway.com" "$tmp/refused.out" || fail "the failure should name the cause"
grep -q "re-run the failed jobs" "$tmp/refused.out" || fail "the failure should name the fix"
[[ "$(grep -c '^serviceInstanceDeployV2 ' "$tmp/refused/calls")" -eq 1 ]] || fail "should stop at the first refused deploy"

echo "railway-set-images tests passed"
