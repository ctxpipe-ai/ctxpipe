#!/usr/bin/env bash
# The CTX-1217 cutover, end to end, on this machine, with made-up data. It
# runs the commands of the hosted one-off tasks (factory machines/hosted
# src/cutover.ts) in the backend and codesearch images, in the order of
# .ai/agents/aws-cutover-runbook.md, then the full rollback of AWS:
#
#   reset-database, copy-database (preflight, copy), migrate, export-indexes,
#   import-indexes, verify-graph, seed-shard-store, then reset-indexes and
#   reset-database.
#
# Each server is a container of its own: a Neon-like and an Aurora-like
# Postgres 17, a source and a target FalkorDB, and an S3 server (rclone).
# Nothing reads or writes the `pnpm dev:infra` stack. The script deletes its
# containers, volumes and network at the end (--keep keeps them).
#
#   ops/aws-cutover/local-rehearsal/run.sh <backend image> <codesearch image> [rows per table] [--keep]
#
# Build the images from the checkout:
#   docker build -f apps/backend/Dockerfile -t ctx1217-backend:rehearsal .
#   docker build -f apps/codesearch/Dockerfile -t ctx1217-codesearch:rehearsal .
#   docker build -f apps/codesearch/Dockerfile --target test -t ctxpipe-codesearch:test .
# The test image gives rclone for the S3 server.
#
# Each Postgres has TLS from a CA that the script makes. The backend tasks
# get that CA at the path of the RDS CA bundle, so that the URLs of the
# tasks (verify-full, sslrootcert, NODE_EXTRA_CA_CERTS) work as on AWS.
# Differences from AWS: the source URL names that CA too (Neon uses the
# system roots), and `vector` is in template1 of the target, because only a
# superuser can create it on a plain Postgres. On Aurora, the master user
# can (rds_superuser).
set -euo pipefail

usage="usage: run.sh <backend image> <codesearch image> [rows per table] [--keep]"
keep=0
args=()
for arg in "$@"; do
  if [[ "$arg" == --keep ]]; then keep=1; else args+=("$arg"); fi
done
backend="${args[0]:?$usage}"
codesearch="${args[1]:?$usage}"
rows="${args[2]:-1000}"
(( ${#args[@]} <= 3 )) || { echo "$usage" >&2; exit 2; }
command -v jq >/dev/null || { echo "Install jq." >&2; exit 2; }
command -v openssl >/dev/null || { echo "Install openssl." >&2; exit 2; }

root="$(cd "$(dirname "$0")/../../.." && pwd)"
pins="$root/scripts/ci/service-pins.json"
postgres="$(jq -r '.postgres | "\(.image):\(.tag)@\(.digest)"' "$pins")"
falkordb="$(jq -r '.falkordb | "\(.image)@\(.digest)"' "$pins")"
s3_image="${CTXPIPE_CODESEARCH_TEST_IMAGE:-ctxpipe-codesearch:test}"

p=ctx1217-local
net=$p
password=rehearsal-password
app_password=rehearsal-app-password
bucket=rehearsal
run_id="run-$(date +%s)"
transfer="s3://$bucket/cutover-transfer/$run_id"
shard_store="s3://$bucket/shards"
s3_env=(-e AWS_ENDPOINT_URL_S3="http://$p-s3:8080" -e AWS_ACCESS_KEY_ID=rehearsalaccess
  -e AWS_SECRET_ACCESS_KEY=rehearsalsecret -e AWS_REGION=us-east-1)

containers=("$p-source-pg" "$p-target-pg" "$p-source-falkordb" "$p-target-falkordb" "$p-s3")
volumes=("$p-source-codesearch" "$p-target-codesearch" "$p-target-falkordb")
cleanup() {
  [[ -n "${certs:-}" ]] && rm -rf "$certs"
  if (( keep )); then
    echo "--keep: the containers ${containers[*]} stay." >&2
    return
  fi
  docker rm -f -v "${containers[@]}" >/dev/null 2>&1 || true
  docker volume rm "${volumes[@]}" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
keep_requested=$keep
keep=0

step() { printf '\n== %s\n' "$*" >&2; }
fail() { echo "FAILED: $*" >&2; exit 1; }
# One task: a fresh container of the image on the network, as ECS runs it.
task() { docker run --rm --network "$net" "$@"; }
# A backend task trusts the CA of the rehearsal at the path of the RDS bundle.
backend_task() { task "${ca_mount[@]}" "$@"; }
psql_super() { docker exec -i "$1" psql -v ON_ERROR_STOP=1 -U "$2" -d "$3" -tA "${@:4}"; }
wait_pg() {
  for _ in $(seq 60); do
    docker exec "$1" pg_isready -U "$2" -q 2>/dev/null && return
    sleep 1
  done
  fail "$1 did not start"
}
timed() {
  local name="$1"
  shift
  local start=$SECONDS
  "$@"
  printf '%s\t%ss\n' "$name" "$((SECONDS - start))" >>"$times"
}
times="$(mktemp)"
# Under the home directory: a Docker VM (Colima) shares only that.
certs="$(mktemp -d "$root/node_modules/.cache/ctx1217-certs-XXXXXX")"
bundle=/app/apps/backend/certs/rds-global-bundle.pem
ca_mount=(-v "$certs/ca.pem:$bundle:ro")

step "TLS"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=ctx1217 rehearsal CA" \
  -keyout "$certs/ca.key" -out "$certs/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=$p-pg" -keyout "$certs/server.key" \
  -out "$certs/server.csr" 2>/dev/null
printf 'subjectAltName=DNS:%s,DNS:%s\n' "$p-source-pg" "$p-target-pg" >"$certs/san.ext"
openssl x509 -req -in "$certs/server.csr" -CA "$certs/ca.pem" -CAkey "$certs/ca.key" -CAcreateserial \
  -days 2 -extfile "$certs/san.ext" -out "$certs/server.pem" 2>/dev/null
chmod 644 "$certs/server.key"
# Postgres reads the key only when it has mode 0600 and the owner postgres.
pg_tls=(-v "$certs:/certs:ro" --entrypoint sh)
pg_start='install -o postgres -m 600 /certs/server.key /var/lib/postgresql/server.key &&
  exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/server.pem -c ssl_key_file=/var/lib/postgresql/server.key'

step "Servers"
docker network create "$net" >/dev/null
docker volume create "${volumes[0]}" >/dev/null
docker volume create "${volumes[1]}" >/dev/null
docker volume create "${volumes[2]}" >/dev/null
docker run -d --name "$p-source-pg" --network "$net" --shm-size=1g "${pg_tls[@]}" \
  -e POSTGRES_USER=cloud_admin -e POSTGRES_PASSWORD="$password" "$postgres" -c "$pg_start" >/dev/null
docker run -d --name "$p-target-pg" --network "$net" --shm-size=1g "${pg_tls[@]}" \
  -e POSTGRES_USER=rdsadmin -e POSTGRES_PASSWORD="$password" "$postgres" -c "$pg_start" >/dev/null
docker run -d --name "$p-source-falkordb" --network "$net" "$falkordb" >/dev/null
docker run -d --name "$p-target-falkordb" --network "$net" -e REDIS_ARGS="--appendonly no" \
  -v "$p-target-falkordb:/var/lib/falkordb/data" "$falkordb" >/dev/null
docker run -d --name "$p-s3" --network "$net" --entrypoint sh "$s3_image" -c \
  "mkdir -p /s3/$bucket && exec rclone serve s3 /s3 --addr 0.0.0.0:8080 --auth-key rehearsalaccess,rehearsalsecret --config /dev/null" >/dev/null
wait_pg "$p-source-pg" cloud_admin
wait_pg "$p-target-pg" rdsadmin

# Neon's role model: the owner login is in neon_superuser, not a superuser.
psql_super "$p-source-pg" cloud_admin postgres >/dev/null <<SQL
CREATE ROLE neon_superuser NOLOGIN BYPASSRLS CREATEDB CREATEROLE;
CREATE ROLE neondb_owner LOGIN PASSWORD '$password' CREATEDB CREATEROLE IN ROLE neon_superuser;
CREATE DATABASE neondb OWNER neondb_owner;
SQL
psql_super "$p-source-pg" cloud_admin neondb -c "CREATE EXTENSION vector" >/dev/null
# Aurora's role model: the master user is in rds_superuser, not a superuser.
# The cluster makes the database ctxpipe, owned by the master user.
psql_super "$p-target-pg" rdsadmin postgres >/dev/null <<SQL
CREATE ROLE rds_superuser NOLOGIN;
CREATE ROLE ctxpipe_admin LOGIN PASSWORD '$password' CREATEDB CREATEROLE IN ROLE rds_superuser;
SQL
psql_super "$p-target-pg" rdsadmin template1 -c "CREATE EXTENSION vector" >/dev/null
psql_super "$p-target-pg" rdsadmin postgres -c "CREATE DATABASE ctxpipe OWNER ctxpipe_admin" >/dev/null

# The URLs of the tasks: libpq tools get sslrootcert, the app URLs do not.
source_url="postgres://neondb_owner:$password@$p-source-pg:5432/neondb?sslmode=verify-full&sslrootcert=$bundle"
source_app_url="postgres://neondb_owner:$password@$p-source-pg:5432/neondb?sslmode=verify-full"
source_super_url="postgres://cloud_admin:$password@$p-source-pg:5432/neondb?sslmode=verify-full"
target_url="postgres://ctxpipe_admin@$p-target-pg:5432/ctxpipe?sslmode=verify-full"
copy_target_url="$target_url&sslrootcert=$bundle"

step "Source data (made up)"
# Production's state: migrate, synthetic rows in every table, migrate again.
backend_task -e DATABASE_URL="$source_app_url" -e DATABASE_APP_PASSWORD="$app_password" \
  "$backend" bun run apps/backend/src/db/migrate.ts >/dev/null
backend_task -e SUPER_URL="$source_super_url" -e ROWS="$rows" "$backend" bun -e '
  const { fillSyntheticRows } = await import("/app/apps/backend/src/scripts/cutover/synthetic-rows.ts")
  const tables = await fillSyntheticRows(process.env.SUPER_URL, {}, Number(process.env.ROWS))
  const failed = tables.filter((table) => table.error)
  console.log(JSON.stringify({ tables: tables.length, failed: failed.length }))
  process.exit(failed.length ? 1 : 0)' >&2
backend_task -e DATABASE_URL="$source_app_url" "$backend" bun run apps/backend/src/db/migrate.ts >/dev/null
# Made-up graphs, and a made-up repository indexed by zoekt-index.
for graph in 1 2 3; do
  docker exec "$p-source-falkordb" redis-cli GRAPH.QUERY "graph_$graph" \
    "UNWIND range(1, $((graph * 50))) AS i CREATE (:File {path: 'f' + toString(i)})-[:IMPORTS]->(:Module {name: 'm' + toString(i)})" >/dev/null
done
task -v "$p-source-codesearch:/data" --entrypoint sh "$codesearch" -c '
  set -e
  name="ctxpipe:v1:org:org_rehearsal:repo:repo_one"
  checkout=/data/repo-cache/org_rehearsal/repo_one/checkouts/default
  mkdir -p "$checkout" /data/zoekt-index
  for i in $(seq 1 200); do echo "function needle$i() { return $i }" > "$checkout/file$i.ts"; done
  printf "{\"ID\":1,\"Name\":\"%s\",\"Source\":\"%s\",\"Branches\":[{\"Name\":\"HEAD\",\"Version\":\"%s\"}]}" \
    "$name" "$checkout" "$(printf c%.0s $(seq 40))" > /tmp/meta.json
  zoekt-index -index /data/zoekt-index -meta /tmp/meta.json "$checkout" >/dev/null 2>&1
  ls /data/zoekt-index | grep -c "\.zoekt$"' >/dev/null

step "Before the window: hosted migrate ran on Aurora"
backend_task -e DATABASE_URL="$target_url" -e PGPASSWORD="$password" -e DATABASE_APP_PASSWORD="$app_password" \
  "$backend" bun run apps/backend/src/db/migrate.ts >/dev/null

copy_env=(-e SOURCE_DATABASE_URL="$source_url" -e TARGET_DATABASE_URL="$copy_target_url"
  -e TARGET_DATABASE_PASSWORD="$password")

step "G2: cutover-copy-database-preflight (expected: one problem, the target is not empty)"
preflight="$(backend_task "${copy_env[@]}" "$backend" bun run apps/backend/src/scripts/copyDatabase.ts --preflight-only || true)"
jq -se 'last | .problems | length == 1 and (.[0] | test("Restore only into an empty database"))' <<<"$preflight" >/dev/null \
  || fail "preflight: $(jq -sc 'last | .problems' <<<"$preflight")"

step "G3: the source is read-only"
psql_super "$p-source-pg" cloud_admin postgres \
  -c "ALTER DATABASE neondb SET default_transaction_read_only = on" >/dev/null

reset_database() {
  backend_task -e PGPASSWORD="$password" \
    -e ADMIN_DATABASE_URL="postgres://ctxpipe_admin@$p-target-pg:5432/postgres?sslmode=verify-full&sslrootcert=$bundle" \
    "$backend" sh -c "psql \"\$ADMIN_DATABASE_URL\" -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS ctxpipe WITH (FORCE)' -c 'CREATE DATABASE ctxpipe'" >/dev/null
}
step "T+3: cutover-reset-database"
timed reset-database reset_database

step "T+5: cutover-copy-database"
copy_report() {
  backend_task "${copy_env[@]}" --tmpfs /scratch:size=4g "$backend" \
    bun run apps/backend/src/scripts/copyDatabase.ts --work-dir /scratch/copy --jobs 8 >"$work/copy.json"
}
work="$(mktemp -d)"
timed copy-database copy_report || fail "copy: $(jq -sc 'last | .verify.problems // .' "$work/copy.json" 2>/dev/null)"
jq -se 'last | .ok and .preflight.sourceReadOnly' "$work/copy.json" >/dev/null || fail "copy report"

step "T+5: export-indexes (on the source)"
export_indexes() {
  task -v "$p-source-codesearch:/data" -e GRAPH_DB_URI="redis://$p-source-falkordb:6379" "${s3_env[@]}" \
    "$codesearch" sh -c "cd /app/apps/codesearch && exec bun run cutover:export-indexes --to \"$transfer\"" >"$work/export.json"
}
timed export-indexes export_indexes || fail "export"

step "T+40: cutover-import-indexes (target FalkorDB stopped)"
docker stop "$p-target-falkordb" >/dev/null
import_indexes() {
  task -v "$p-target-codesearch:/data" -v "$p-target-falkordb:/var/lib/falkordb/data" \
    -e CUTOVER_TRANSFER_URL="$transfer" "${s3_env[@]}" "$codesearch" sh -c \
    'cd /app/apps/codesearch && exec bun run cutover:import-indexes --from "$CUTOVER_TRANSFER_URL" --falkordb-data-file /var/lib/falkordb/data/dump.rdb --force' >"$work/import.json"
}
timed import-indexes import_indexes || fail "import: $(cat "$work/import.json")"
docker start "$p-target-falkordb" >/dev/null
for _ in $(seq 30); do
  docker exec "$p-target-falkordb" redis-cli PING 2>/dev/null | grep -q PONG && break
  sleep 1
done

step "T+40: cutover-verify-graph"
verify_graph() {
  task -e GRAPH_DB_URI="redis://$p-target-falkordb:6379" -e CUTOVER_TRANSFER_URL="$transfer" "${s3_env[@]}" \
    "$codesearch" sh -c 'cd /app/apps/codesearch && exec bun run cutover:verify-graph --from "$CUTOVER_TRANSFER_URL"' >"$work/verify-graph.json"
}
timed verify-graph verify_graph || fail "verify-graph: $(cat "$work/verify-graph.json")"

step "T+40: cutover-seed-shard-store"
seed() {
  task -v "$p-target-codesearch:/data" -e CODESEARCH_SHARD_STORE="$shard_store" "${s3_env[@]}" \
    "$codesearch" sh -c 'cd /app/apps/codesearch && exec bun run cutover:seed-shard-store' >"$work/seed.json"
}
timed seed-shard-store seed || fail "seed: $(cat "$work/seed.json")"
jq -se 'last | .published >= 1' "$work/seed.json" >/dev/null || fail "seed published nothing"

step "T+50: cutover-migrate"
migrate_check() {
  backend_task -e DATABASE_URL="$target_url" -e PGPASSWORD="$password" -e DATABASE_APP_PASSWORD="$app_password" \
    "$backend" sh -c "bun run apps/backend/src/db/migrate.ts >/dev/null && psql \"\$DATABASE_URL&sslrootcert=/app/apps/backend/certs/rds-global-bundle.pem\" -tAc \"SELECT r.rolbypassrls, (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid) FROM pg_roles r WHERE r.rolname = 'ctxpipe_app'\"" >"$work/migrate.txt"
}
timed migrate migrate_check
[[ "$(cat "$work/migrate.txt")" == "f|0" ]] || fail "role check: $(cat "$work/migrate.txt")"

step "Full rollback of AWS: cutover-reset-indexes, cutover-reset-database"
docker stop "$p-target-falkordb" >/dev/null
reset_indexes() {
  task -v "$p-target-codesearch:/data" -v "$p-target-falkordb:/var/lib/falkordb/data" \
    -e CODESEARCH_SHARD_STORE="$shard_store" "${s3_env[@]}" "$codesearch" sh -c \
    'cd /app/apps/codesearch && exec bun run cutover:reset-indexes --falkordb-data-file /var/lib/falkordb/data/dump.rdb' >"$work/reset-indexes.json"
}
timed reset-indexes reset_indexes || fail "reset-indexes: $(cat "$work/reset-indexes.json")"
left="$(docker exec "$p-s3" sh -c "find /s3/$bucket/shards -type f 2>/dev/null | wc -l")"
[[ "$left" -eq 0 ]] || fail "$left shard store objects stay"
left="$(task -v "$p-target-codesearch:/data" -v "$p-target-falkordb:/fdb" --entrypoint sh "$codesearch" \
  -c 'find /data /fdb -mindepth 2 | wc -l')"
[[ "$left" -eq 0 ]] || fail "$left entries stay on the target volumes"
timed reset-database-rollback reset_database
tables="$(psql_super "$p-target-pg" rdsadmin ctxpipe -c "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')")"
[[ "$tables" -eq 0 ]] || fail "the target has $tables tables after the reset"

step "Report"
jq -n --slurpfile copy "$work/copy.json" --slurpfile export "$work/export.json" \
  --slurpfile imported "$work/import.json" --slurpfile graph "$work/verify-graph.json" \
  --slurpfile seed "$work/seed.json" --slurpfile reset "$work/reset-indexes.json" \
  --rawfile times "$times" '{
    ok: true,
    copy: { phases: $copy[-1].phases, tables: ($copy[-1].verify.tables | length) },
    graph: $graph[-1], seed: $seed[-1], resetIndexes: $reset[-1],
    import: $imported[-1].import,
    seconds: ($times | split("\n") | map(select(length > 0) | split("\t") | {(.[0]): .[1]}) | add)
  }'
rm -rf "$work" "$times" "$certs"
keep=$keep_requested
