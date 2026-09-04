#!/usr/bin/env bash
# Operator-gated Neon US East → Singapore production cutover.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Minimal terminal UI.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""
fi

TOTAL_STAGES=0

_STAGE_INDEX=0
WRITTEN_SECRET=()

# _clear — wipe the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

# banner "Title" — opening frame: what this wizard does.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C; a rerun\n'
  printf '  asks for them again and validates completed database stages.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" — clear the screen, then announce a stage and show progress.
# Clearing keeps only the current step on screen.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

# say "..." — a plain instruction line.
say()  { printf '  %s\n' "$1"; }
# step "..." — a numbered-feeling action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

# open_url URL — open in the human's browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser — visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser — visit it manually: $url"
}

# pause "msg" — wait for the human to confirm they've done the manual part.
pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" — y/N gate; returns success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_SECRET[@]} )) && note "set ${#WRITTEN_SECRET[@]} GitHub secret(s): ${WRITTEN_SECRET[*]}"
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES — Neon US East → Singapore production cutover.
# ──────────────────────────────────────────────────────────────────────────

TOTAL_STAGES=8

RAILWAY_PROJECT_ID="119e3cc3-ef73-43aa-895a-8c8ccff73ff8"
RAILWAY_ENVIRONMENT="production"
RAILWAY_REGION="southeast-asia"
PUBLICATION="ctxpipe_singapore_publication"
SUBSCRIPTION="ctxpipe_singapore_subscription"
WRITER_SERVICES=(backend openworkflow codesearch)
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

abort() {
  warn "$1"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || abort "required command not found: $1"
}

terraform_output_required() {
  local output_name="$1" destination="$2" value
  if ! value=$(
    terraform -chdir="$REPO_ROOT/infra" output -raw "$output_name"
  ); then
    abort "could not read Terraform output $output_name; apply the reviewed Singapore target first"
  fi
  [[ -n "$value" && "$value" != "null" ]] \
    || abort "Terraform output $output_name is empty; apply the reviewed Singapore target first"
  printf -v "$destination" '%s' "$value"
}

set_repo_secret_required() {
  local name="$1" value="$2"
  if printf '%s' "$value" | gh secret set "$name" >/dev/null 2>&1; then
    WRITTEN_SECRET+=("$name")
    printf '  %s✓ set%s GitHub secret %s\n' "$GREEN" "$RESET" "$name"
    return
  fi
  abort "could not set GitHub secret $name"
}

set_repo_var_required() {
  local name="$1" value="$2"
  if gh variable set "$name" --body "$value" >/dev/null 2>&1; then
    printf '  %s✓ set%s GitHub variable %s\n' "$GREEN" "$RESET" "$name"
    return
  fi
  abort "could not set GitHub variable $name"
}

database_scalar() {
  local url="$1" sql="$2"
  psql "$url" -X -qAt -v ON_ERROR_STOP=1 -c "$sql"
}

write_schema_dump() {
  local url="$1" output="$2"
  pg_dump "$url" \
    --schema-only \
    --no-owner \
    --no-privileges \
    --no-publications \
    --no-subscriptions \
    --exclude-schema=neon_auth \
    --exclude-schema=neon_migration \
    --file "$output.raw"
  # PostgreSQL 17 emits a random \restrict token on every dump. Remove only
  # non-schema metadata before comparing source and target.
  awk '
    /^\\(un)?restrict / { next }
    /^-- Dumped (from database version|by pg_dump version)/ { next }
    { print }
  ' "$output.raw" > "$output"
}

write_table_counts() {
  local url="$1" output="$2"
  psql "$url" -X -qAt -v ON_ERROR_STOP=1 > "$output" <<'SQL'
SELECT format(
  'SELECT %L || E''\t'' || count(*) FROM %I.%I;',
  n.nspname || '.' || c.relname,
  n.nspname,
  c.relname
)
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('information_schema', 'neon_auth', 'neon_migration')
  AND n.nspname NOT LIKE 'pg_%'
ORDER BY n.nspname, c.relname
\gexec
SQL
  LC_ALL=C sort -o "$output" "$output"
}

writer_status_json() {
  local writer_services_json
  writer_services_json=$(
    printf '%s\n' "${WRITER_SERVICES[@]}" | jq -R . | jq -s .
  )
  railway status \
    --project "$RAILWAY_PROJECT_ID" \
    --environment "$RAILWAY_ENVIRONMENT" \
    --json |
    jq --arg environment "$RAILWAY_ENVIRONMENT" \
      --argjson writerServices "$writer_services_json" '
      [
        .environments.edges[].node
        | select(.name == $environment)
        | .serviceInstances.edges[].node
        | .serviceName as $service
        | select($writerServices | index($service))
        | {
            serviceName: $service,
            instances: ([.activeDeployments[]?.instances[]?] | length)
          }
      ]
    '
}

wait_for_writers_to_stop() {
  local deadline expected observed_services running_instances status
  deadline=$(( $(date +%s) + 300 ))
  expected=${#WRITER_SERVICES[@]}
  while true; do
    status=$(writer_status_json)
    observed_services=$(jq '[.[].serviceName] | unique | length' <<< "$status")
    running_instances=$(jq '[.[].instances] | add // 0' <<< "$status")
    if [[ "$observed_services" == "$expected" && "$running_instances" == "0" ]]; then
      return
    fi
    note "Waiting for writer services to stop ($observed_services/$expected observed, $running_instances instance(s) running)."
    (( $(date +%s) < deadline )) \
      || abort "Railway did not report every writer stopped within five minutes"
    sleep 5
  done
}

wait_for_writers_to_start() {
  local deadline expected observed_services running_services stable_checks status
  deadline=$(( $(date +%s) + 600 ))
  expected=${#WRITER_SERVICES[@]}
  stable_checks=0
  while true; do
    status=$(writer_status_json)
    observed_services=$(jq '[.[].serviceName] | unique | length' <<< "$status")
    running_services=$(
      jq '[.[] | select(.instances > 0) | .serviceName] | unique | length' \
        <<< "$status"
    )
    if [[ "$observed_services" == "$expected" && "$running_services" == "$expected" ]]; then
      stable_checks=$((stable_checks + 1))
      [[ "$stable_checks" == "3" ]] && return
    else
      stable_checks=0
    fi
    note "Waiting for writer services to stay running ($observed_services/$expected observed, $running_services/$expected running)."
    (( $(date +%s) < deadline )) \
      || abort "Railway writer services did not stay running within ten minutes"
    sleep 5
  done
}

verify_service_database_url() {
  local service="$1" expected="$2" actual
  actual=$(
    railway variable list \
      --project "$RAILWAY_PROJECT_ID" \
      --environment "$RAILWAY_ENVIRONMENT" \
      --service "$service" \
      --json |
      jq -r '.DATABASE_URL // empty'
  )
  [[ "$actual" == "$expected" ]] \
    || abort "Railway did not persist DATABASE_URL for $service"
  unset actual
}

redeploy_with_current_variables() {
  local service="$1" previous_id deadline deployment_id status
  previous_id=$(
    railway deployment list \
      --project "$RAILWAY_PROJECT_ID" \
      --environment "$RAILWAY_ENVIRONMENT" \
      --service "$service" \
      --limit 1 \
      --json |
      jq -r '.[0].id // empty'
  )
  railway redeploy \
    --project "$RAILWAY_PROJECT_ID" \
    --environment "$RAILWAY_ENVIRONMENT" \
    --service "$service" \
    --yes >/dev/null

  deadline=$(( $(date +%s) + 600 ))
  while true; do
    IFS=$'\t' read -r deployment_id status < <(
      railway deployment list \
        --project "$RAILWAY_PROJECT_ID" \
        --environment "$RAILWAY_ENVIRONMENT" \
        --service "$service" \
        --limit 1 \
        --json |
        jq -r '.[0] | [.id, .status] | @tsv'
    )
    if [[ -n "$deployment_id" && "$deployment_id" != "$previous_id" ]]; then
      [[ "$status" == "SUCCESS" ]] && return
      case "$status" in
        FAILED|CRASHED|REMOVED)
          abort "$service deployment failed with status $status"
          ;;
      esac
    fi
    (( $(date +%s) < deadline )) \
      || abort "$service deployment did not succeed within ten minutes"
    sleep 5
  done
}

banner "Neon production cutover · US East → Singapore"

stage "Preflight and connection details"
say "This procedure causes a short production write outage. It does not claim zero downtime."
warn "Pause production deploys and schema changes until the cutover finishes."
for command in psql pg_dump railway gh curl diff jq awk terraform; do
  require_command "$command"
done
railway whoami >/dev/null
gh auth status >/dev/null
step "Loading source and target identities and URLs from the reviewed Terraform state."
terraform_output_required "neon_project_id" SOURCE_PROJECT_ID
terraform_output_required "neon_connection_uri" SOURCE_DIRECT_URL
terraform_output_required "neon_migration_target_project_id" TARGET_PROJECT_ID
terraform_output_required \
  "neon_migration_target_connection_uri" TARGET_DIRECT_URL
terraform_output_required \
  "neon_migration_target_connection_uri_pooler" TARGET_POOLER_URL
[[ "$SOURCE_DIRECT_URL" != *"-pooler"* ]] || abort "source replication URL is pooled"
[[ "$TARGET_DIRECT_URL" != *"-pooler"* ]] || abort "target replication URL is pooled"
[[ "$TARGET_POOLER_URL" == *"-pooler"* ]] || abort "application URL is not pooled"
[[ "$SOURCE_DIRECT_URL" != "$TARGET_DIRECT_URL" ]] || abort "source and target URLs are identical"
[[ "$SOURCE_PROJECT_ID" != "$TARGET_PROJECT_ID" ]] \
  || abort "source and target Terraform project IDs are identical"
[[ "$TARGET_PROJECT_ID" =~ ^[a-z][a-z0-9-]+$ ]] \
  || abort "target project ID has an unexpected format"
SOURCE_VERSION=$(database_scalar "$SOURCE_DIRECT_URL" "SHOW server_version_num")
TARGET_VERSION=$(database_scalar "$TARGET_DIRECT_URL" "SHOW server_version_num")
[[ "${SOURCE_VERSION:0:2}" == "17" && "${TARGET_VERSION:0:2}" == "17" ]] \
  || abort "both projects must run PostgreSQL 17"
SOURCE_LARGE_OBJECTS=$(database_scalar "$SOURCE_DIRECT_URL" \
  "SELECT count(*) FROM pg_largeobject_metadata")
[[ "$SOURCE_LARGE_OBJECTS" == "0" ]] \
  || abort "source has $SOURCE_LARGE_OBJECTS large object(s), which logical replication will not copy"
SOURCE_UNLOGGED_TABLES=$(database_scalar "$SOURCE_DIRECT_URL" "
  SELECT count(*)
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND c.relpersistence <> 'p'
    AND n.nspname NOT IN ('information_schema', 'neon_auth', 'neon_migration')
    AND n.nspname NOT LIKE 'pg_%'
")
[[ "$SOURCE_UNLOGGED_TABLES" == "0" ]] \
  || abort "source has $SOURCE_UNLOGGED_TABLES non-permanent table(s), which logical replication will not copy"
NO_IDENTITY=$(database_scalar "$SOURCE_DIRECT_URL" "
  SELECT count(*)
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND n.nspname NOT IN ('information_schema', 'neon_auth', 'neon_migration')
    AND n.nspname NOT LIKE 'pg_%'
    AND (
      c.relreplident = 'n'
      OR (
        c.relreplident = 'd'
        AND NOT EXISTS (
          SELECT 1 FROM pg_index AS i
          WHERE i.indrelid = c.oid AND i.indisprimary
        )
      )
      OR (
        c.relreplident = 'i'
        AND NOT EXISTS (
          SELECT 1 FROM pg_index AS i
          WHERE i.indrelid = c.oid AND i.indisreplident
        )
      )
    )
")
[[ "$NO_IDENTITY" == "0" ]] || {
  psql "$SOURCE_DIRECT_URL" -X -P pager=off -c "
    SELECT
      n.nspname AS schema,
      c.relname AS table,
      c.relreplident AS replica_identity
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('information_schema', 'neon_auth', 'neon_migration')
      AND n.nspname NOT LIKE 'pg_%'
      AND (
        c.relreplident = 'n'
        OR (
          c.relreplident = 'd'
          AND NOT EXISTS (
            SELECT 1 FROM pg_index AS i
            WHERE i.indrelid = c.oid AND i.indisprimary
          )
        )
        OR (
          c.relreplident = 'i'
          AND NOT EXISTS (
            SELECT 1 FROM pg_index AS i
            WHERE i.indrelid = c.oid AND i.indisreplident
          )
        )
      )
    ORDER BY 1, 2
  "
  abort "tables above need a valid primary key, REPLICA IDENTITY USING INDEX, or REPLICA IDENTITY FULL"
}
TARGET_TABLES=$(database_scalar "$TARGET_DIRECT_URL" "
  SELECT count(*)
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND n.nspname NOT IN ('information_schema', 'neon_auth', 'neon_migration')
    AND n.nspname NOT LIKE 'pg_%'
")
write_schema_dump "$SOURCE_DIRECT_URL" "$WORK_DIR/source-schema.sql"
if [[ "$TARGET_TABLES" == "0" ]]; then
  step "Copying schema only; table data will be copied by the subscription."
  psql "$TARGET_DIRECT_URL" -X -v ON_ERROR_STOP=1 \
    --file "$WORK_DIR/source-schema.sql.raw"
else
  note "The target has $TARGET_TABLES user tables from an earlier run; validating them exactly."
fi
write_schema_dump "$TARGET_DIRECT_URL" "$WORK_DIR/target-schema.sql"
if ! diff -u \
  "$WORK_DIR/source-schema.sql" \
  "$WORK_DIR/target-schema.sql"; then
  abort "source and target schemas differ; do not enable logical replication"
fi
note "Both projects and the complete replication schema passed preflight."

stage "Enable logical replication on the source"
SOURCE_WAL_LEVEL=$(database_scalar "$SOURCE_DIRECT_URL" "SHOW wal_level")
if [[ "$SOURCE_WAL_LEVEL" != "logical" ]]; then
  warn "Neon will restart all source computes and drop active connections."
  warn "wal_level=logical cannot be reverted."
  confirm "Enable logical replication on the US East source now?" \
    || abort "cutover cancelled before the irreversible step"
  open_url "https://console.neon.tech/app/projects"
  step "Select ctxpipe in US East → Settings → Logical Replication → Enable."
  pause "Press Enter only after Neon reports logical replication enabled."
  SOURCE_WAL_LEVEL=$(database_scalar "$SOURCE_DIRECT_URL" "SHOW wal_level")
  [[ "$SOURCE_WAL_LEVEL" == "logical" ]] || abort "source wal_level is not logical"
  set_repo_var_required "NEON_SOURCE_LOGICAL_REPLICATION" "true"
else
  set_repo_var_required "NEON_SOURCE_LOGICAL_REPLICATION" "true"
  note "Source wal_level is already logical."
fi

stage "Create the source publication"
PUBLICATION_EXISTS=$(database_scalar "$SOURCE_DIRECT_URL" \
  "SELECT count(*) FROM pg_publication WHERE pubname = '$PUBLICATION'")
if [[ "$PUBLICATION_EXISTS" == "0" ]]; then
  psql "$SOURCE_DIRECT_URL" -X -v ON_ERROR_STOP=1 \
    -c "CREATE PUBLICATION $PUBLICATION FOR ALL TABLES"
fi
PUBLICATION_VALID=$(database_scalar "$SOURCE_DIRECT_URL" "
  SELECT count(*)
  FROM pg_publication
  WHERE pubname = '$PUBLICATION'
    AND puballtables
    AND pubinsert
    AND pubupdate
    AND pubdelete
    AND pubtruncate
")
[[ "$PUBLICATION_VALID" == "1" ]] \
  || abort "existing publication does not publish all table changes"
note "Source publication is ready."

stage "Start replication and wait for the initial copy"
SUBSCRIPTION_EXISTS=$(database_scalar "$TARGET_DIRECT_URL" \
  "SELECT count(*) FROM pg_subscription WHERE subname = '$SUBSCRIPTION'")
if [[ "$SUBSCRIPTION_EXISTS" == "0" ]]; then
  psql "$TARGET_DIRECT_URL" -X -v ON_ERROR_STOP=1 \
    -v source_url="$SOURCE_DIRECT_URL" <<SQL
SELECT format(
  'CREATE SUBSCRIPTION $SUBSCRIPTION CONNECTION %L PUBLICATION $PUBLICATION WITH (copy_data = true, create_slot = true, enabled = true)',
  :'source_url'
)
\gexec
SQL
fi
SUBSCRIPTION_VALID=$(database_scalar "$TARGET_DIRECT_URL" "
  SELECT count(*)
  FROM pg_subscription
  WHERE subname = '$SUBSCRIPTION'
    AND subenabled
    AND subslotname = '$SUBSCRIPTION'
    AND subpublications = ARRAY['$PUBLICATION']::name[]
")
[[ "$SUBSCRIPTION_VALID" == "1" ]] \
  || abort "existing subscription has the wrong publication, slot, or enabled state"
DEADLINE=$(( $(date +%s) + 7200 ))
while true; do
  REMAINING=$(database_scalar "$TARGET_DIRECT_URL" "
    SELECT count(*)
    FROM pg_subscription_rel AS r
    JOIN pg_subscription AS s ON s.oid = r.srsubid
    WHERE s.subname = '$SUBSCRIPTION' AND r.srsubstate <> 'r'
  ")
  note "$REMAINING table(s) still copying."
  [[ "$REMAINING" == "0" ]] && break
  (( $(date +%s) < DEADLINE )) || abort "initial copy did not finish within two hours"
  sleep 10
done
RECEIVER_PID=$(database_scalar "$TARGET_DIRECT_URL" "
  SELECT COALESCE(max(pid), 0)
  FROM pg_stat_subscription
  WHERE subname = '$SUBSCRIPTION'
")
[[ "$RECEIVER_PID" != "0" ]] || abort "subscription receiver is not running"
SOURCE_SLOT_ACTIVE=$(database_scalar "$SOURCE_DIRECT_URL" "
  SELECT count(*)
  FROM pg_replication_slots
  WHERE slot_name = '$SUBSCRIPTION'
    AND slot_type = 'logical'
    AND active
")
[[ "$SOURCE_SLOT_ACTIVE" == "1" ]] \
  || abort "source logical replication slot is missing or inactive"
SOURCE_SENDER_ACTIVE=$(database_scalar "$SOURCE_DIRECT_URL" "
  SELECT count(*)
  FROM pg_stat_replication
  WHERE application_name = '$SUBSCRIPTION'
    AND state = 'streaming'
")
[[ "$SOURCE_SENDER_ACTIVE" == "1" ]] \
  || abort "the target subscription is not streaming from the Terraform source"
note "Initial copy is complete and the replication receiver is running."

stage "Validate replicated data"
step "Comparing exact row counts for every user table on source and target."
COUNTS_MATCH=false
for _ in {1..5}; do
  write_table_counts "$SOURCE_DIRECT_URL" "$WORK_DIR/source-counts.tsv"
  write_table_counts "$TARGET_DIRECT_URL" "$WORK_DIR/target-counts.tsv"
  if diff -q "$WORK_DIR/source-counts.tsv" "$WORK_DIR/target-counts.tsv" >/dev/null; then
    COUNTS_MATCH=true
    break
  fi
  sleep 2
done
if [[ "$COUNTS_MATCH" != "true" ]]; then
  diff -u "$WORK_DIR/source-counts.tsv" "$WORK_DIR/target-counts.tsv" || true
  abort "row counts differ; do not cut over"
fi
LAST_RECEIPT=$(database_scalar "$TARGET_DIRECT_URL" "
  SELECT COALESCE(max(last_msg_receipt_time)::text, '')
  FROM pg_stat_subscription
  WHERE subname = '$SUBSCRIPTION'
")
[[ -n "$LAST_RECEIPT" ]] || abort "subscriber has not received a replication message"
note "All table counts match. Last replication receipt: $LAST_RECEIPT"

stage "Quiesce writers and synchronise final state"
warn "The production write outage starts when the next confirmation is accepted."
confirm "Scale backend, openworkflow, and codesearch to zero replicas?" \
  || abort "cutover cancelled before the write outage"
for service in "${WRITER_SERVICES[@]}"; do
  railway scale \
    --project "$RAILWAY_PROJECT_ID" \
    --environment "$RAILWAY_ENVIRONMENT" \
    --service "$service" \
    "$RAILWAY_REGION=0"
done
wait_for_writers_to_stop
note "All Railway writer instances are stopped."
step "Waiting for the logical slot to catch up completely."
DEADLINE=$(( $(date +%s) + 600 ))
while true; do
  LAG_BYTES=$(database_scalar "$SOURCE_DIRECT_URL" "
    SELECT COALESCE(
      max(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)),
      -1
    )::bigint
    FROM pg_replication_slots
    WHERE slot_name = '$SUBSCRIPTION'
  ")
  note "Replication lag: $LAG_BYTES byte(s)."
  [[ "$LAG_BYTES" == "0" ]] && break
  (( $(date +%s) < DEADLINE )) || abort "replication did not reach zero lag within ten minutes"
  sleep 5
done
write_table_counts "$SOURCE_DIRECT_URL" "$WORK_DIR/source-final-counts.tsv"
write_table_counts "$TARGET_DIRECT_URL" "$WORK_DIR/target-final-counts.tsv"
diff -u "$WORK_DIR/source-final-counts.tsv" "$WORK_DIR/target-final-counts.tsv" \
  || abort "final row counts differ; leave writers stopped and investigate"
step "Synchronising sequence state, which logical replication does not copy."
database_scalar "$SOURCE_DIRECT_URL" "
  SELECT format('%I.%I', n.nspname, c.relname)
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE c.relkind = 'S'
    AND n.nspname NOT IN ('information_schema', 'neon_auth', 'neon_migration')
    AND n.nspname NOT LIKE 'pg_%'
  ORDER BY 1
" > "$WORK_DIR/sequences.txt"
: > "$WORK_DIR/sequences.sql"
while IFS= read -r sequence; do
  [[ -n "$sequence" ]] || continue
  pg_dump "$SOURCE_DIRECT_URL" \
    --data-only \
    --no-owner \
    --no-privileges \
    --table "$sequence" >> "$WORK_DIR/sequences.sql"
done < "$WORK_DIR/sequences.txt"
psql "$TARGET_DIRECT_URL" -X -v ON_ERROR_STOP=1 \
  --file "$WORK_DIR/sequences.sql"
note "Writers are stopped, row counts match, lag is zero, and sequences are synchronised."

stage "Switch production and restore services"
warn "After Singapore accepts writes, US East is not a safe rollback target."
confirm "Switch DATABASE_URL to Singapore and restore production services?" \
  || abort "writers remain stopped; resume only after choosing rollback or cutover"
set_repo_secret_required "PRODUCTION_DATABASE_URL" "$TARGET_POOLER_URL"
set_repo_var_required "NEON_DATABASE_TARGET" "singapore"
set_repo_var_required "NEON_PROJECT_ID" "$TARGET_PROJECT_ID"
for service in "${WRITER_SERVICES[@]}"; do
  printf '%s' "$TARGET_POOLER_URL" | railway variable set DATABASE_URL \
    --stdin \
    --skip-deploys \
    --project "$RAILWAY_PROJECT_ID" \
    --environment "$RAILWAY_ENVIRONMENT" \
    --service "$service"
  verify_service_database_url "$service" "$TARGET_POOLER_URL"
  redeploy_with_current_variables "$service"
done
for service in "${WRITER_SERVICES[@]}"; do
  railway scale \
    --project "$RAILWAY_PROJECT_ID" \
    --environment "$RAILWAY_ENVIRONMENT" \
    --service "$service" \
    "$RAILWAY_REGION=1"
done
wait_for_writers_to_start
note "All Railway writer services are running on the Singapore database."
step "Waiting for the integrated backend health endpoint."
HEALTH_ATTEMPT=0
while (( HEALTH_ATTEMPT < 30 )); do
  HEALTH_ATTEMPT=$((HEALTH_ATTEMPT + 1))
  STATUS=$(curl -sS -o /dev/null -w '%{http_code}' \
    "https://app.ctxpipe.ai/.status" || true)
  [[ "$STATUS" == "200" ]] && break
  sleep 5
done
[[ "${STATUS:-}" == "200" ]] || abort "backend did not become healthy; keep source intact and investigate"
ROOT_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' \
  "https://app.ctxpipe.ai/" || true)
MCP_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' \
  "https://app.ctxpipe.ai/mcp?orgSlug=trurecai-wc4" || true)
AUTH_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"client_id":"ctxpipe-cli","scope":"openid profile email"}' \
  "https://app.ctxpipe.ai/.auth/api/v1/auth/device/code" || true)
[[ "$ROOT_STATUS" == "200" ]] || abort "application root returned HTTP $ROOT_STATUS"
[[ "$MCP_STATUS" == "401" ]] || abort "unauthenticated MCP probe returned HTTP $MCP_STATUS instead of 401"
[[ "$AUTH_STATUS" == "200" ]] || abort "CLI device-code probe returned HTTP $AUTH_STATUS"
database_scalar "$TARGET_DIRECT_URL" "SELECT 1" >/dev/null
note "Production is healthy on Singapore. Keep US East and the subscription intact for validation."

stage "Validation-window handoff"
say "Do not destroy US East or drop replication in this run."
step "Run authenticated ctx_advisor, CodeRabbit, npx ctxpipe init, webhook, and background-workflow smoke tests."
step "Monitor Railway database errors, HTTP 5xx, advisor latency, and Neon replication for at least 24 hours."
step "Then drop $SUBSCRIPTION on Singapore and $PUBLICATION on US East."
step "Retire the source in a reviewed Terraform follow-up after the agreed backup/retention window."
warn "Rollback after target writes requires data reconciliation or reverse replication."
pause "Press Enter after recording the validation and cleanup owners."

finish
