#!/usr/bin/env bash
# Fixtures for jq helpers in connect-source-image-and-deploy.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/connect-source-image-and-deploy.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_eq() {
  local got="$1" want="$2" label="$3"
  if [[ "$got" != "$want" ]]; then
    fail "$label: got $(printf %q "$got"), want $(printf %q "$want")"
  fi
}

# Scalar String is the Railway GraphQL convention in this repo.
assert_eq \
  "$(printf '%s' '{"data":{"serviceInstanceDeployV2":"dpl_abc"}}' | deploy_id_from_mutation)" \
  "dpl_abc" \
  "scalar deploy id"

assert_eq \
  "$(printf '%s' '{"data":{"serviceInstanceDeployV2":""}}' | deploy_id_from_mutation)" \
  "" \
  "empty string is not an id"

assert_eq \
  "$(printf '%s' '{"data":{"serviceInstanceDeployV2":null}}' | deploy_id_from_mutation)" \
  "" \
  "null is not an id"

assert_eq \
  "$(printf '%s' '{"data":{}}' | deploy_id_from_mutation)" \
  "" \
  "missing field is not an id"

# Object { id } is not what serviceInstanceDeployV2 returns here.
assert_eq \
  "$(printf '%s' '{"data":{"serviceInstanceDeployV2":{"id":"dpl_abc"}}}' | deploy_id_from_mutation)" \
  "" \
  "object payload is not an id"

LIST='{
  "data": {
    "deployments": {
      "edges": [
        {"node": {"id": "dpl_old", "status": "SUCCESS", "createdAt": "2026-09-27T10:00:00Z"}},
        {"node": {"id": "dpl_new", "status": "BUILDING", "createdAt": "2026-09-27T11:00:00Z"}},
        {"node": {"id": "dpl_mid", "status": "FAILED", "createdAt": "2026-09-27T10:30:00Z"}}
      ]
    }
  }
}'

assert_eq \
  "$(printf '%s' "$LIST" | deployment_node_by_id "dpl_mid" | jq -r '.id')" \
  "dpl_mid" \
  "select node by id"

assert_eq \
  "$(printf '%s' "$LIST" | deployment_node_by_id "dpl_missing")" \
  "" \
  "missing id is empty"

assert_eq \
  "$(printf '%s' "$LIST" | newest_unseen_deployment '["dpl_old"]' | jq -r '.id')" \
  "dpl_new" \
  "newest unseen"

assert_eq \
  "$(printf '%s' "$LIST" | newest_unseen_deployment '["dpl_old","dpl_new","dpl_mid"]')" \
  "" \
  "all seen is empty"

assert_eq \
  "$(printf '%s' "$LIST" | deployment_ids)" \
  '["dpl_old","dpl_new","dpl_mid"]' \
  "snapshot ids"

assert_eq \
  "$(printf '%s' '{"id":"dpl_new","status":"BUILDING"}' | deployment_status)" \
  "BUILDING" \
  "status from node"

assert_eq \
  "$(printf '%s' '' | deployment_status)" \
  "" \
  "empty node has no status"

assert_eq "$(classify_deploy_status SUCCESS)" ok "SUCCESS is ok"
assert_eq "$(classify_deploy_status SLEEPING)" ok "SLEEPING is ok"
assert_eq "$(classify_deploy_status FAILED)" fail "FAILED is fail"
assert_eq "$(classify_deploy_status CRASHED)" fail "CRASHED is fail"
assert_eq "$(classify_deploy_status BUILDING)" wait "BUILDING waits"
assert_eq "$(classify_deploy_status QUEUED)" wait "QUEUED waits"
assert_eq "$(classify_deploy_status "")" wait "empty waits"

EMPTY_LIST='{"data":{"deployments":{"edges":[]}}}'
assert_eq \
  "$(printf '%s' "$EMPTY_LIST" | deployment_ids)" \
  '[]' \
  "empty list snapshot"
assert_eq \
  "$(printf '%s' "$EMPTY_LIST" | newest_unseen_deployment '[]')" \
  "" \
  "empty list has no unseen"

echo "ok"
