#!/usr/bin/env bash
# Create a Postgres database for the current linked git worktree and set DATABASE_URL.
# Does not read or write any .env file.
#
# - Run directly: prints `export DATABASE_URL=…` on stdout for: eval "$(./scripts/worktree-db.sh)"
# - Sourced (recommended from apps/backend): assigns export DATABASE_URL in the current shell.
#
# Requires: psql, Postgres (e.g. Compose) on PGHOST:PGPORT.

set -euo pipefail

# Sourced vs executed: must use `return` when sourced so we do not exit the parent shell.
_wt_sourced=0
[[ "${BASH_SOURCE[0]}" != "${0}" ]] && _wt_sourced=1

if [[ $# -gt 0 ]]; then
  echo "usage: $0 (no arguments)" >&2
  if [[ "$_wt_sourced" -eq 1 ]]; then return 1; else exit 1; fi
fi

GIT_DIR="$(git rev-parse --path-format=absolute --git-dir 2>/dev/null)" || GIT_DIR=""
GIT_COMMON="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || GIT_COMMON=""
if [[ -z "$GIT_DIR" || -z "$GIT_COMMON" || "$GIT_DIR" == "$GIT_COMMON" ]]; then
  echo "Not a linked git worktree — no DATABASE_URL export (use apps/backend/.env.local or your shell; default DB name: ctxpipe)." >&2
  if [[ "$_wt_sourced" -eq 1 ]]; then return 0; else exit 0; fi
fi

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-${CTXPIPE_POSTGRES_HOST_PORT:-5433}}"
PGUSER="${POSTGRES_USER:-ctxpipe}"
PGPASSWORD="${POSTGRES_PASSWORD:-ctxpipe}"
export PGPASSWORD

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
s="$(echo "$branch" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/_/g' | cut -c1-48)"
if [[ -z "$s" || "$s" == "_" ]]; then
  s="worktree"
fi
db_name="ctxpipe_${s}"

exists="$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db_name'" 2>/dev/null | tr -d '[:space:]' || true)"
if [[ "$exists" == "1" ]]; then
  echo "Database $db_name already exists (skipped CREATE DATABASE)." >&2
else
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$db_name\";"
  echo "Created database $db_name." >&2
fi

encoded="$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$PGPASSWORD")"
url="postgresql://${PGUSER}:${encoded}@${PGHOST}:${PGPORT}/${db_name}"

if [[ "$_wt_sourced" -eq 1 ]]; then
  export DATABASE_URL="$url"
else
  printf 'export DATABASE_URL=%q\n' "$url"
fi
