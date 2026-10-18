#!/usr/bin/env bash
# The run part of the ingestion v2 Docker proof (CTX-630). The workflow
# .github/workflows/ingestion-v2-proof.yaml starts the Compose `deploy` stack,
# then runs this script. Environment: REPOS (URLs, separated by spaces, commas
# or new lines), WORKSPACE_REPO (URL), SPEND_CAP_USD, MODE (shadow),
# MODEL_PROVIDER_API_KEY (only to hash it for the credential check).
# Before any run starts, it refuses when the p90 estimate for all
# repositories is over the cap. While a run goes, it stops the run when the
# finished spend plus the reserve of each running model step reaches the cap
# (`spendGuard` in ingestionV2ProofBudget.ts). After the first step of each
# shard, it checks that the shard sandbox holds no credential.
# It writes one table row for each repository to $GITHUB_STEP_SUMMARY and
# exits 1 when any repository fails.
set -euo pipefail

proof_script=apps/backend/src/scripts/ingestionV2Proof.ts
summary=${GITHUB_STEP_SUMMARY:-/dev/stdout}
poll_seconds=5
credential_check=scripts/ci/ingestion-v2-sandbox-credential-check.sh
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

echo "::group::Estimate the cost"
estimate=$(proof ESTIMATE estimate --org-id "$org_id" --repos "$repo_list" --cap "$SPEND_CAP_USD")
echo "::endgroup::"
[ -n "$estimate" ] || { echo "::error::The estimate printed no result"; exit 1; }
estimate_line="p90 cost estimate for all repositories: $(jq -r .costUsd.high <<<"$estimate") USD (p50 $(jq -r .costUsd.low <<<"$estimate") USD), spend cap $SPEND_CAP_USD USD."
echo "$estimate_line"
if [ "$(jq -r '.refusal // empty' <<<"$estimate" | wc -c)" -gt 1 ]; then
  {
    echo "### Ingestion v2 proof (Docker, shadow mode)"
    echo
    echo "Not started. $(jq -r .refusal <<<"$estimate")"
  } >>"$summary"
  echo "::error::$(jq -r .refusal <<<"$estimate")"
  exit 1
fi

# Hashes of the secrets that must not be in a sandbox. The values are never
# printed, and only the hashes go into the sandbox.
forbidden_hashes=""
if [ -n "${MODEL_PROVIDER_API_KEY:-}" ]; then
  forbidden_hashes=$(printf '%s' "$MODEL_PROVIDER_API_KEY" | sha256sum | cut -d' ' -f1)
fi
vault_hash=$(docker compose exec -T backend sh -c 'cat "$AGENT_VAULT_OWNER_PASSWORD_FILE" 2>/dev/null' |
  tr -d '\r\n' | { read -r v || true; [ -z "$v" ] || printf '%s' "$v" | sha256sum | cut -d' ' -f1; } || true)
[ -z "$vault_hash" ] || forbidden_hashes="$forbidden_hashes $vault_hash"

# Run the credential check in each shard sandbox that has finished a first
# step and has not been checked. Sets credential_checked and credential_failed.
credential_checked=0
credential_failed=0
checked_ids=" "
credential_findings=""
check_credentials() {
  local shards=$1 cid out
  [ "$credential_checked" -lt "$shards" ] || return 0
  for cid in $(docker compose exec -T dind docker --host unix:///var/run/docker.sock ps -q 2>/dev/null | tr -d '\r'); do
    [ "$credential_checked" -lt "$shards" ] || break
    case "$checked_ids" in *" $cid "*) continue ;; esac
    out=$(docker compose exec -T dind docker --host unix:///var/run/docker.sock exec -i \
      -u ctxpipe-agent -e "FORBIDDEN_SHA256=$forbidden_hashes" "$cid" sh -s \
      <"$credential_check" 2>&1) || true
    # Names and counts only: the check prints no value. The start of each
    # step stops every process of the agent user, also this check, so a
    # check with no summary runs again at the next poll.
    if printf '%s\n' "$out" | grep -q '^SUMMARY '; then
      checked_ids="$checked_ids$cid "
      credential_checked=$((credential_checked + 1))
      echo "Credential check, sandbox ${cid:0:12}: $(printf '%s\n' "$out" | grep '^SUMMARY ')"
      if printf '%s\n' "$out" | grep -q '^FINDING '; then
        credential_failed=1
        credential_findings="$credential_findings$(printf '%s\n' "$out" | grep '^FINDING ' | sed 's/^FINDING //' | paste -sd';' -);"
        printf '%s\n' "$out" | grep '^FINDING ' | sed 's/^/::error::credential in the sandbox: /'
      fi
    else
      echo "::warning::The credential check printed no summary in sandbox ${cid:0:12}: $(printf '%s\n' "$out" | head -n 3 | tr '\n' ' ')"
    fi
  done
}

{
  echo "### Ingestion v2 proof (Docker, shadow mode)"
  echo
  echo "| Repository | Wall time | Model spend (USD) | Patches | Rejects | Result |"
  echo "| --- | --- | --- | --- | --- | --- |"
} >>"$summary"

total_spend=0
failed=0
step_tables=""
over_cap() { awk -v a="$1" -v b="$SPEND_CAP_USD" 'BEGIN { exit !(a >= b) }'; }
# The status of a run, with the spend guard of the whole proof.
run_state() { proof STATUS status --run-id "$1" --spent-before "$total_spend" --cap "$SPEND_CAP_USD" || true; }

for ((i = 0; i < count; i++)); do
  url=$(jq -r ".repositories[$i].url" <<<"$seed")
  # The Actions log and summary are public: name a repository by its position.
  name="Repository $((i + 1))"
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
  credential_checked=0
  credential_failed=0
  credential_findings=""
  checked_ids=" "
  shards_seen=0
  while :; do
    state=$(run_state "$run_id")
    [ -n "$state" ] || { sleep "$poll_seconds"; continue; }
    if [ "$(jq -r .terminal <<<"$state")" = true ]; then break; fi
    shards_seen=$(jq -r '[.shardsWithFirstStep, '"$shards_seen"'] | max' <<<"$state")
    check_credentials "$shards_seen"
    # Spent plus the reserve of each running model step reaches the cap: the
    # run starts no new step. The running steps end inside their reserve.
    if [ "$(jq -r .stop <<<"$state")" = true ]; then
      echo "Spend guard: $(jq -r .spendUsd <<<"$state") USD spent in this run, $(jq -r .reservedUsd <<<"$state") USD reserved for $(jq -r .inFlightModelSteps <<<"$state") running model step(s)"
      proof CANCEL cancel --run-id "$run_id" >/dev/null
      note="stopped at the spend cap"
      # Wait until the running steps end, so that the final spend is real.
      drain_deadline=$(($(date +%s) + 600))
      while [ "$(date +%s)" -lt "$drain_deadline" ]; do
        sleep "$poll_seconds"
        state=$(run_state "$run_id")
        [ -n "$state" ] || continue
        [ "$(jq -r .inFlightModelSteps <<<"$state")" = 0 ] && break
      done
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
      state=$(run_state "$run_id")
      break
    fi
    sleep "$poll_seconds"
  done
  echo "::endgroup::"
  # The job summary is not in the API, so the log also shows how the run ended.
  echo "Run $run_id ended: $(jq -c '{status, outputStatus, outputReason, error}' <<<"$state")"
  # Where each failed step attempt failed (the log has no error text).
  docker compose logs --no-color worker 2>/dev/null |
    grep -aF '"ingestion-v2.step-attempt-failed"' | grep -aF "$run_id" |
    jq -Rrc 'sub("^[^{]*"; "") | fromjson? | {ingestStep, attempt, stage, exitCode, errorClass, errorCode, errorKind}' || true
  # The ops, rejects and model spend of each finished step. A failed attempt
  # reports no spend.
  steps=$(proof STEPS steps --run-id "$run_id" || true)
  if [ -n "$steps" ]; then
    step_table=$(jq -r '"| Shard | Step | Ops | Rejects | Partial | Input tokens | Output tokens | Cost (USD) |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      (.[] | "| \(.shard) | \(.step) | \(.ops) | \(.rejects) | \(.partial) | \(.inputTokens) | \(.outputTokens) | \(.costUsd // (if .inputTokens + .outputTokens == 0 then "-" else "unknown" end)) |")' <<<"$steps")
    echo "Steps of $name:"
    echo "$step_table"
    step_tables="$step_tables"$'\n'"#### Steps of $name"$'\n\n'"$step_table"$'\n'
  fi

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
  output_status=$(jq -r '.outputStatus // empty' <<<"$state")
  [ "$result" != PASS ] || [ -z "$output_status" ] || [ "$output_status" = done ] ||
    result="FAIL: output $output_status ($(jq -r '.outputReason // "no reason"' <<<"$state"))"
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
  # Every shard that ran a step must have had its sandbox checked.
  shards_seen=$(jq -r '[.shardsWithFirstStep, '"$shards_seen"'] | max' <<<"$state")
  if [ "$credential_failed" -ne 0 ]; then
    result="FAIL: credential in the sandbox ($credential_findings)"
  elif [ "$credential_checked" -lt "$shards_seen" ] || [ "$credential_checked" -eq 0 ]; then
    result="FAIL: the credential check ran in $credential_checked of $shards_seen shard sandboxes"
  fi
  note="${note:+$note; }credential check: $credential_checked sandbox(es), $([ "$credential_failed" -eq 0 ] && echo 0 || echo some) finding(s); highest step cost $(jq -r .maxStepCostUsd <<<"$state") USD"
  [ "${result%%:*}" = PASS ] || failed=1
  echo "| $name | $wall | $spend | $patches | $rejects | $result${note:+ ($note)} |" >>"$summary"

  if over_cap "$total_spend"; then
    echo "::warning::The total spend passed the cap of $SPEND_CAP_USD USD; the remaining runs are skipped"
  fi
done

{
  echo
  echo "$estimate_line"
  echo "Total model spend: $total_spend USD of $SPEND_CAP_USD USD. Spend is the cost of the finished steps; a step with no reported cost counts at the token price."
  printf '%s\n' "$step_tables"
} >>"$summary"
# The job summary is not in the API: print it in the log too.
[ "$summary" = /dev/stdout ] || cat "$summary"
exit "$failed"
