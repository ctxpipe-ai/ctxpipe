#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$root/scripts/preview-app-db-password.sh"
workflow="$root/.github/workflows/pr-deploy.yaml"
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

bash -n "$script" || fail "preview-app-db-password.sh must pass bash -n"

# CURRENT is the DATABASE_URL on the preview backend ("" when it has none).
run_password() {
  (
    # shellcheck disable=SC1090
    source "$script"
    # shellcheck disable=SC2329 # the sourced script calls it
    railway_graphql() {
      case "$1" in
        *"query variables"*)
          jq -nc --arg u "$CURRENT" '{data:{variables:(if $u == "" then {} else {DATABASE_URL:$u, AUTH_SECRET:"other"} end)}}'
          ;;
        *) echo "unexpected query: $1" >&2; return 1 ;;
      esac
    }
    export RAILWAY_PROJECT_ID=proj_test ENV_ID=env_preview BACKEND_SERVICE_ID=svc_backend
    export OWNER_DB_URL_POOLED="postgresql://neondb_owner:owner-secret@ep-preview-pooler.example.test/neondb?sslmode=require"
    preview_app_db_password
  )
}

err="$(mktemp)"
trap 'rm -f "$err"' EXIT

kept="$(CURRENT="postgresql://ctxpipe_app:kept%2Fsecret@ep-preview-pooler.example.test/neondb?sslmode=require" run_password 2>"$err" || true)"
[[ "$kept" == "kept/secret" ]] || fail "a preview URL on this branch must keep its password"
grep -Fq "keeps" "$err" || fail "the step should say that it keeps the password"
if grep -Fq "secret" "$err"; then fail "stderr must not hold a value"; fi

for current in \
  "" \
  "postgresql://ctxpipe_app:production-secret@ep-production-pooler.example.test/neondb?sslmode=require" \
  "postgresql://neondb_owner:owner-secret@ep-preview-pooler.example.test/neondb?sslmode=require" \
  "postgresql://ctxpipe_app@ep-preview-pooler.example.test/neondb"; do
  fresh="$(CURRENT="$current" run_password 2>"$err")" || fail "a new password must not fail ($current)"
  [[ "$fresh" =~ ^[0-9a-f]{48}$ ]] || fail "a URL of an other host, user or no password must get a new password"
  grep -Fq "new" "$err" || fail "the step should say that it makes a new password"
done

a="$(CURRENT="" run_password 2>/dev/null)"
b="$(CURRENT="" run_password 2>/dev/null)"
[[ "$a" != "$b" ]] || fail "each new password must be random"

grep -Fq 'PASSWORD="$(preview_app_db_password)"' "$workflow" \
  || fail "pr-deploy.yaml migrate must take its password from preview_app_db_password"
if grep -Fq 'PASSWORD="$(openssl rand' "$workflow"; then
  fail "pr-deploy.yaml must not make a new ctxpipe_app password on each run"
fi
echo "preview-app-db-password: ok"
