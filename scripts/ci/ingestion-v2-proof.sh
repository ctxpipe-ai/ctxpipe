#!/usr/bin/env bash
# The run part of the ingestion v2 Docker proof (CTX-630). The workflow
# .github/workflows/ingestion-v2-proof.yaml starts the Compose `deploy` stack,
# then runs this script. Environment: REPOS (URLs, separated by spaces, commas
# or new lines), WORKSPACE_REPO (URL), SPEND_CAP_USD, MODE (shadow).
# It writes one table row for each repository to $GITHUB_STEP_SUMMARY and
# exits 1 when any repository fails.
set -euo pipefail

proof_script=apps/backend/src/scripts/ingestionV2Proof.ts
summary=${GITHUB_STEP_SUMMARY:-/dev/stdout}
poll_seconds=15
run_timeout_minutes=150

[ "${MODE:-}" = shadow ] || { echo "::error::Only the shadow mode is built"; exit 1; }

# Run one script command in the backend container. The command prints one
# `PROOF_<KIND> <json>` line; this function prints that JSON.
proof() {
  local kind=$1
  shift
  docker compose exec -T backend bun run "$proof_script" "$@" |
    sed -n "s/^PROOF_${kind} //p" | tail -n 1
}

repos=$(printf '%s' "$REPOS" | tr ',[:space:]' '\n\n' | sed '/^$/d')
repo_list=$(printf '%s' "$repos" | paste -sd, -)

echo "::group::Seed the test org"
seed=$(proof SEED seed --workspace-repo "$WORKSPACE_REPO" --repos "$repo_list")
echo "::endgroup::"
[ -n "$seed" ] || { echo "::error::The seed printed no result"; exit 1; }
org_id=$(jq -r .orgId <<<"$seed")
count=$(jq '.repositories | length' <<<"$seed")

{
  echo "### Ingestion v2 proof (Docker, shadow mode)"
  echo
  echo "| Repository | Wall time | Model spend (USD) | Patches | Rejects | Result |"
  echo "| --- | --- | --- | --- | --- | --- |"
} >>"$summary"

total_spend=0
failed=0
over_cap() { awk -v a="$1" -v b="$SPEND_CAP_USD" 'BEGIN { exit !(a > b) }'; }

for ((i = 0; i < count; i++)); do
  url=$(jq -r ".repositories[$i].url" <<<"$seed")
  name=$(jq -r ".repositories[$i].name" <<<"$seed")
  sha=$(jq -r ".repositories[$i].sha" <<<"$seed")
  # The worker-kill test runs in the last repository: it is the largest one
  # when the list is ordered small to large.
  kill_here=0
  [ "$i" -eq $((count - 1)) ] && kill_here=1

  if over_cap "$total_spend"; then
    echo "| $name | - | - | - | - | FAIL: not run, the spend cap was reached |" >>"$summary"
    failed=1
    continue
  fi

  echo "::group::Run $name"
  run_id=$(proof START start --org-id "$org_id" --repo-url "$url" --sha "$sha" | jq -r .runId)
  [ -n "$run_id" ] || { echo "::error::No run started for $name"; exit 1; }
  started=$(date +%s)
  deadline=$((started + run_timeout_minutes * 60))
  killed=0
  note=""
  state=""
  while :; do
    state=$(proof STATUS status --run-id "$run_id" || true)
    [ -n "$state" ] || { sleep "$poll_seconds"; continue; }
    run_spend=$(jq -r .spendUsd <<<"$state")
    if [ "$(jq -r .terminal <<<"$state")" = true ]; then break; fi
    if over_cap "$(awk -v a="$total_spend" -v b="$run_spend" 'BEGIN { print a + b }')"; then
      proof CANCEL cancel --run-id "$run_id" >/dev/null
      note="stopped at the spend cap"
      sleep "$poll_seconds"
      state=$(proof STATUS status --run-id "$run_id" || true)
      break
    fi
    if [ "$kill_here" -eq 1 ] && [ "$killed" -eq 0 ] &&
      [ "$(jq -r .completedSteps <<<"$state")" -ge 2 ]; then
      echo "Killing the worker after $(jq -r .completedSteps <<<"$state") completed steps"
      docker compose kill -s SIGKILL worker
      docker compose up -d worker
      killed=1
    fi
    if [ "$(date +%s)" -gt "$deadline" ]; then
      proof CANCEL cancel --run-id "$run_id" >/dev/null
      note="timed out after $run_timeout_minutes minutes"
      state=$(proof STATUS status --run-id "$run_id" || true)
      break
    fi
    sleep "$poll_seconds"
  done
  echo "::endgroup::"

  status=$(jq -r .status <<<"$state")
  spend=$(jq -r .spendUsd <<<"$state")
  total_spend=$(awk -v a="$total_spend" -v b="$spend" 'BEGIN { print a + b }')
  patches=$(jq -r .patches <<<"$state")
  rejects=$(jq -r .rejects <<<"$state")
  partial=$(jq -r .partial <<<"$state")
  unknown=$(jq -r .unknownSteps <<<"$state")
  start_ms=$(jq -r '.startedAtMs // empty' <<<"$state")
  end_ms=$(jq -r '.finishedAtMs // empty' <<<"$state")
  if [ -n "$start_ms" ] && [ -n "$end_ms" ]; then
    wall="$(((end_ms - start_ms) / 1000)) s"
  else
    wall="$(($(date +%s) - started)) s"
  fi

  result=PASS
  case "$status" in completed | succeeded) ;; *) result="FAIL: run $status" ;; esac
  [ -z "$note" ] || result="FAIL: $note"
  if [ "$kill_here" -eq 1 ]; then
    if [ "$killed" -eq 0 ]; then
      result="FAIL: the run ended before the worker could be killed"
    else
      note="worker killed once and restarted"
      docker compose ps --status running --services | grep -qx worker ||
        result="FAIL: the worker is not running after the restart"
    fi
  fi
  [ "$partial" = 0 ] || note="${note:+$note; }$partial partial step(s)"
  [ "$unknown" = 0 ] || note="${note:+$note; }$unknown step(s) with unknown usage"
  [ "${result%%:*}" = PASS ] || failed=1
  echo "| $name | $wall | $spend | $patches | $rejects | $result${note:+ ($note)} |" >>"$summary"

  if over_cap "$total_spend"; then
    echo "::warning::The total spend passed the cap of $SPEND_CAP_USD USD; the remaining runs are skipped"
  fi
done

{
  echo
  echo "Total model spend: $total_spend USD of $SPEND_CAP_USD USD. Spend counts only the steps that reported usage."
} >>"$summary"
exit "$failed"
