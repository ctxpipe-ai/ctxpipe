# shellcheck shell=bash
# gh_retry runs `gh "$@"`. When GitHub refuses the call because of a rate
# limit, it waits until the reset time that GitHub gives, and runs the call one
# more time. The wait is at most 5 minutes. It writes the output only when the
# call passes, so a paginated call that stops halfway writes no part twice.
# Exit code: 0 when the call passes, 2 when the rate limit stays, 1 on another
# error (with the gh error text on stderr).
#
# The Merge gate job sources this file. The jobs Merge gate critics (it runs
# no repository script) and Merge gate starts PR Deploy (no checkout) hold the
# same function in the text of their step; a test checks that the text is the
# same (scripts/tests/ci-terraform-plan-pr.test.mjs).
# gh_retry begin
gh_retry() {
  local out err try remaining reset wait code=1
  out="$(mktemp)"
  err="$(mktemp)"
  for try in 1 2; do
    if gh "$@" > "$out" 2> "$err"; then
      cat "$out"
      rm -f "$out" "$err"
      return 0
    fi
    grep -qi 'rate limit' "$err" || break
    code=2
    [ "$try" = 1 ] || break
    # No calls left: wait until the reset. Calls left (a secondary limit):
    # GitHub tells the client to wait one minute.
    read -r remaining reset < <(gh api rate_limit \
      --jq '.resources.core | "\(.remaining) \(.reset)"' 2> /dev/null) || break
    wait=60
    [ "$remaining" -gt 0 ] || wait=$((reset - $(date +%s) + 1))
    [ "$wait" -le 300 ] || break
    [ "$wait" -ge 1 ] || wait=1
    echo "::notice::GitHub API rate limit: the call runs again in ${wait}s" >&2
    sleep "$wait"
    code=1
  done
  cat "$err" >&2
  rm -f "$out" "$err"
  return "$code"
}
# gh_retry end
