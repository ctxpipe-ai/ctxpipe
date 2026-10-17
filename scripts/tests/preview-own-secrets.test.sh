#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$root/scripts/preview-own-secrets.sh"
workflow="$root/.github/workflows/pr-deploy.yaml"
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

bash -n "$script" || fail "preview-own-secrets.sh must pass bash -n"

# MARKER is the PREVIEW_OWN_SECRETS value on the preview backend.
# TOKEN is the value that projectTokenCreate returns ("" for an error).
run_sync() {
  local tmp="$1"
  mkdir -p "$tmp"
  : >"$tmp/upserts"
  : >"$tmp/mints"
  : >"$tmp/psql"
  (
    # shellcheck disable=SC1090
    source "$script"
    # shellcheck disable=SC2329 # the sourced script calls it
    railway_graphql() {
      case "$1" in
        *"query variables"*)
          printf '%s\n' "$2" >"$tmp/read"
          jq -nc --arg m "$MARKER" '{data:{variables:({AUTH_SECRET:"production-auth"} + (if $m == "" then {} else {PREVIEW_OWN_SECRETS:$m} end))}}'
          ;;
        *projectTokenCreate*)
          printf '%s\n' "$2" >>"$tmp/mints"
          [[ -n "$TOKEN" ]] || return 22
          jq -nc --arg t "$TOKEN" '{data:{projectTokenCreate:$t}}'
          ;;
        *variableCollectionUpsert*)
          printf '%s\n' "$2" >>"$tmp/upserts"
          echo '{"data":{"variableCollectionUpsert":true}}'
          ;;
        *) echo "unexpected query: $1" >&2; return 1 ;;
      esac
    }
    # shellcheck disable=SC2329 # the sourced script calls it
    psql() {
      printf '%s\n' "$*" >>"$tmp/psql"
    }
    export RAILWAY_PROJECT_ID=proj_test ENV_ID=env_preview PR_ENV=pr-7
    export BACKEND_SERVICE_ID=svc_backend WORKER_SERVICE_ID=svc_worker
    export UI_SERVICE_ID=svc_ui CODESEARCH_SERVICE_ID=svc_codesearch
    export RAILWAY_API_TOKEN=account-token-value
    export OWNER_DB_URL="${DB_URL:-}"
    # Outside Actions, so the ::add-mask:: lines (which hold values) stay off.
    export GITHUB_ACTIONS=false
    sync_preview_own_secrets
  )
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

out="$(MARKER="" TOKEN=scoped-token-value DB_URL=postgresql://owner@preview-branch/neondb run_sync "$tmp/new" 2>&1)" \
  || fail "a new preview should get its own secrets: $out"
for secret in scoped-token-value account-token-value production-auth; do
  if printf '%s' "$out" | grep -Fq "$secret"; then
    fail "sync must not print a secret value ($secret)"
  fi
done
printf '%s' "$out" | grep -Fq "do not decrypt" || fail "sync should say that production connection secrets do not decrypt"
jq -e '.input == {projectId:"proj_test", environmentId:"env_preview", name:"pr-7 worker wake"}' "$tmp/new/mints" >/dev/null \
  || fail "the wake token must be scoped to the preview environment"
jq -se '
  map(.input) as $rows
  | ($rows | map(.serviceId)) == ["svc_worker", "svc_ui", "svc_codesearch", "svc_backend"]
  and all($rows[]; .projectId == "proj_test" and .environmentId == "env_preview" and .skipDeploys == true)
  and ($rows | map(.variables.AUTH_SECRET) | unique | length) == 1
  and ($rows | map(.variables.CONNECTION_SECRETS_ENCRYPTION_KEY) | unique | length) == 1
  and ($rows[0].variables.AUTH_SECRET | test("^[0-9a-f]{64}$"))
  and ($rows[0].variables.CONNECTION_SECRETS_ENCRYPTION_KEY | test("^[0-9a-f]{64}$"))
  and $rows[0].variables.AUTH_SECRET != $rows[0].variables.CONNECTION_SECRETS_ENCRYPTION_KEY
  and ($rows[0:3] | all(.variables | keys == ["AUTH_SECRET", "CONNECTION_SECRETS_ENCRYPTION_KEY"]))
  and $rows[3].variables.RAILWAY_TOKEN == "scoped-token-value"
  and $rows[3].variables.PREVIEW_OWN_SECRETS == "v1"
' "$tmp/new/upserts" >/dev/null \
  || fail "every service should get one new AUTH_SECRET and key; the backend last, with the scoped token and the marker"
if grep -Fq "account-token-value" "$tmp/new/upserts"; then
  fail "the account token must never reach a service variable"
fi
jq -e '.environmentId == "env_preview" and .serviceId == "svc_backend"' "$tmp/new/read" >/dev/null \
  || fail "the marker read should target the preview backend"

[[ "$(cat "$tmp/new/psql")" == "postgresql://owner@preview-branch/neondb -v ON_ERROR_STOP=1 -qc DELETE FROM jwkss" ]] \
  || fail "a new preview should delete the JWKS keys copied from production, in the preview database only"

out="$(MARKER="" TOKEN=scoped-token-value run_sync "$tmp/no-db" 2>&1)" || fail "a preview without a database URL should pass: $out"
[[ ! -s "$tmp/no-db/psql" ]] || fail "without OWNER_DB_URL, sync must not run psql"

out="$(MARKER=v1 TOKEN=scoped-token-value DB_URL=postgresql://owner@preview-branch/neondb run_sync "$tmp/kept" 2>&1)" || fail "a marked preview should pass: $out"
[[ ! -s "$tmp/kept/upserts" && ! -s "$tmp/kept/mints" && ! -s "$tmp/kept/psql" ]] \
  || fail "a preview that has its own secrets keeps them for its life"

if out="$(MARKER="" TOKEN="" run_sync "$tmp/no-token" 2>&1)"; then
  fail "sync should fail when Railway does not create the scoped token"
fi
printf '%s' "$out" | grep -Fq "projectTokenCreate" || fail "the error should name projectTokenCreate: $out"
[[ ! -s "$tmp/no-token/upserts" ]] || fail "nothing should be written without the scoped token"

# The deploy job must not give the account token to steps that run branch code
# (pnpm install, migrations), and must not write it into a service variable.
python3 - "$workflow" <<'PY' || fail "pr-deploy.yaml must scope RAILWAY_API_TOKEN to Railway steps"
import re, sys
text = open(sys.argv[1]).read()
deploy = text.split("\n  deploy_pr_environment:", 1)
if len(deploy) != 2:
    raise SystemExit("deploy_pr_environment job not found")
job = deploy[1].split("\n  cleanup_pr_environment:", 1)[0]
head = job.split("\n    steps:", 1)[0]
if "RAILWAY_API_TOKEN:" in head:
    raise SystemExit("job-level env must not hold RAILWAY_API_TOKEN")
for step in re.split(r"\n      - ", job)[1:]:
    if ("pnpm install" in step or "migrate.ts" in step) and "RAILWAY_API_TOKEN:" in step:
        raise SystemExit("a step that runs branch code must not get RAILWAY_API_TOKEN")
if re.search(r"RAILWAY_TOKEN:\s*\$(wake_token|RAILWAY_API_TOKEN|\{?RAILWAY_API_TOKEN)", text):
    raise SystemExit("the account token must not be written into RAILWAY_TOKEN")
if text.count("sync_preview_own_secrets") != 1:
    raise SystemExit("pr-deploy.yaml must call sync_preview_own_secrets once")
PY

echo "preview-own-secrets tests passed"
