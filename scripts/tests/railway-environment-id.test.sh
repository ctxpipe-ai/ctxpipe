#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# lookup <tmp> <response>... : each fake curl call prints the next response
# ("<body>|<http code>"), then the function looks up pr-7.
lookup() {
  local tmp="$1"
  shift
  mkdir -p "$tmp"
  printf '%s\n' "$@" >"$tmp/responses"
  : >"$tmp/calls"
  (
    # shellcheck disable=SC1091
    source "$root/scripts/railway-graphql.sh"
    # shellcheck disable=SC2329 # railway_graphql calls it
    curl() {
      local line
      echo call >>"$tmp/calls"
      line="$(sed -n "$(wc -l <"$tmp/calls")p" "$tmp/responses")"
      printf '%s\n%s' "${line%|*}" "${line##*|}"
    }
    # shellcheck disable=SC2329 # railway_environment_id calls it between attempts
    sleep() { :; }
    export RAILWAY_API_TOKEN=token
    railway_environment_id proj_test pr-7
  )
}

listed='{"data":{"project":{"environments":{"edges":[{"node":{"id":"env_prod","name":"production"}},{"node":{"id":"env_7","name":"pr-7"}}]}}}}|200'
absent='{"data":{"project":{"environments":{"edges":[{"node":{"id":"env_prod","name":"production"}}]}}}}|200'
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

[[ "$(lookup "$tmp/found" "$listed")" == env_7 ]] || fail "should print the id of a listed environment"

out="$(lookup "$tmp/absent" "$absent")" || fail "an absent environment is not an error"
[[ -z "$out" ]] || fail "should print nothing for an absent environment, got: $out"

[[ "$(lookup "$tmp/retry" 'bad gateway|502' '{"errors":[{"message":"x"}]}|200' "$listed" 2>/dev/null)" == env_7 ]] \
  || fail "should retry an HTTP error and a GraphQL error"

rate='Rate limit exceeded, please try again in 53.348 seconds.|429'
[[ "$(lookup "$tmp/rate" "$rate" "$rate" "$rate" "$rate" "$listed" 2>/dev/null)" == env_7 ]] \
  || fail "should keep retrying a rate limit until the fifth attempt"

if lookup "$tmp/down" "$rate" "$rate" "$rate" "$rate" "$rate" "$absent" >/dev/null 2>"$tmp/down.err"; then
  fail "five failed queries must fail, not report the environment as absent"
fi
[[ "$(wc -l <"$tmp/down/calls")" -eq 5 ]] || fail "should stop after 5 attempts"
grep -q "rate limit or outage" "$tmp/down.err" || fail "the failure should name the cause"
grep -q "re-run the failed jobs" "$tmp/down.err" || fail "the failure should name the fix"

echo "railway-environment-id tests passed"
