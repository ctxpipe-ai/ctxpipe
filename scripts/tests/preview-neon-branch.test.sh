#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$root/scripts/preview-neon-branch.sh"
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

bash -n "$script" || fail "preview-neon-branch.sh must pass bash -n"

# BRANCHES is the branch list that the fake Neon API returns. DEFAULT is the
# id of the default branch. CALLS gets one line for each API call.
calls="$(mktemp)"
err="$(mktemp)"
trap 'rm -f "$calls" "$err"' EXIT

with_fake_neon() {
  (
    # shellcheck disable=SC1090
    source "$script"
    # shellcheck disable=SC2329 # the sourced script calls it
    neon_api() {
      echo "$1 $2" >>"$calls"
      case "$1 $2" in
        "GET /branches") jq -nc --argjson b "$BRANCHES" '{branches:$b}' ;;
        "GET /branches/"*)
          jq -nc --argjson b "$BRANCHES" --arg id "${2#/branches/}" --arg d "$DEFAULT" \
            '{branch:($b[] | select(.id == $id) | . + {default:(.id == $d)})}'
          ;;
        "POST /branches/"*"/roles/neondb_owner/reset_password") echo '{"operations":[{"id":"op1"}]}' ;;
        "GET /operations/op1") echo '{"operation":{"status":"finished"}}' ;;
        "GET /connection_uri?"*) echo '{"uri":"postgresql://neondb_owner:new@ep.example.test/neondb"}' ;;
        *)
          echo "unexpected call: $1 $2" >&2
          return 1
          ;;
      esac
    }
    "$@"
  )
}

export NEON_API_KEY=key_test NEON_PROJECT_ID=proj_test DEFAULT=br-prod
export BRANCHES='[{"id":"br-prod","name":"production"},{"id":"br-pr7","name":"preview/pr-7"}]'

id="$(with_fake_neon neon_preview_branch_id 7)"
[[ "$id" == "br-pr7" ]] || fail "the preview branch id comes from its name, got '$id'"

if with_fake_neon neon_preview_branch_id 8 2>"$err"; then fail "a missing preview branch must fail"; fi
grep -Fq "no branch preview/pr-8" "$err" || fail "a missing branch should say so"

DEFAULT=br-pr7 with_fake_neon neon_preview_branch_id 7 2>"$err" && fail "the default branch must be refused"
grep -Fq "default branch" "$err" || fail "the refusal should name the default branch"

BRANCHES='[{"id":"br-prod","name":"production"},{"id":"br-prod","name":"preview/pr-7"}]' DEFAULT=other \
  with_fake_neon neon_preview_branch_id 7 2>"$err" && fail "the production branch id must be refused"
grep -Fq "not the preview branch" "$err" || fail "the refusal should name the preview branch"

with_fake_neon neon_preview_branch_id "7 || true" 2>"$err" && fail "a PR number that is not a number must fail"

: >"$calls"
with_fake_neon neon_reset_owner_password br-pr7 || fail "the reset should wait for its operation"
grep -Fxq "POST /branches/br-pr7/roles/neondb_owner/reset_password" "$calls" || fail "the reset must use the preview branch"
grep -Fxq "GET /operations/op1" "$calls" || fail "the reset must wait for its operation"

url="$(with_fake_neon neon_owner_url br-pr7 false)"
[[ "$url" == "postgresql://neondb_owner:new@ep.example.test/neondb" ]] || fail "the owner URL comes from the API"
with_fake_neon neon_owner_url "br-pr7&branch_id=br-prod" false 2>/dev/null && fail "a branch id with other characters must fail"

echo "preview-neon-branch tests passed"
