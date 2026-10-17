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
  "postgresql://ctxpipe_app:lookalike-secret@ep-preview-pooler.example.test.other.test/neondb?sslmode=require" \
  "postgresql://ctxpipe_app:broken-secret@[ep-preview-pooler.example.test/neondb" \
  "postgresql://ctxpipe_app@ep-preview-pooler.example.test/neondb"; do
  fresh="$(CURRENT="$current" run_password 2>"$err")" || fail "a new password must not fail ($current)"
  [[ "$fresh" =~ ^[0-9a-f]{48}$ ]] || fail "a URL of an other host, user or no password, or a URL that does not parse, must get a new password"
  grep -Fq "new" "$err" || fail "the step should say that it makes a new password"
  if grep -Fq "secret" "$err"; then fail "stderr must not hold a value"; fi
done

# Without a Neon branch id, OWNER_DB_URL_POOLED is the production URL, and the
# production DATABASE_URL that the duplicate copies would match its host. The
# guard must stop the job before this step reads the preview DATABASE_URL.
# The deploy job reads the Neon URLs again, so take the last guard before the
# step: the guard of that job.
step_line="$(grep -n 'name: Set preview ctxpipe_app password' "$workflow" | cut -d: -f1)"
job_line="$(grep -n '^  deploy_pr_environment:' "$workflow" | cut -d: -f1)"
guard_line="$(grep -n '\[\[ -n "$NEON_BRANCH_ID" \]\] ||' "$workflow" | cut -d: -f1 \
  | awk -v s="${step_line:-0}" '$1 < s { line = $1 } END { print line }')"
[[ -n "$guard_line" && -n "$step_line" && -n "$job_line" && "$job_line" -lt "$guard_line" && "$guard_line" -lt "$step_line" ]] \
  || fail "the deploy job must stop on an empty Neon branch id before it sets the ctxpipe_app password"

a="$(CURRENT="" run_password 2>/dev/null)"
b="$(CURRENT="" run_password 2>/dev/null)"
[[ "$a" != "$b" ]] || fail "each new password must be random"

grep -Fq 'PASSWORD="$(preview_app_db_password)"' "$workflow" \
  || fail "pr-deploy.yaml must take the ctxpipe_app password from preview_app_db_password"
grep -Fq 'PREVIEW_APP_DB_PASSWORD="$PASSWORD" psql "$OWNER_DB_URL"' "$workflow" \
  || fail "pr-deploy.yaml must set the chosen ctxpipe_app password on the Neon branch"
# Migrate runs branch code in a job without the Railway token, so it cannot
# read the chosen password. It must not set one.
if grep -Fq 'DATABASE_APP_PASSWORD=' "$workflow"; then
  fail "pr-deploy.yaml migrate must not set the ctxpipe_app password"
fi
if grep -Fq 'PASSWORD="$(openssl rand' "$workflow"; then
  fail "pr-deploy.yaml must not make a new ctxpipe_app password on each run"
fi
echo "preview-app-db-password: ok"
