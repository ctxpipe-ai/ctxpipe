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
  : >"$tmp/revokes"
  : >"$tmp/deletes"
  : >"$tmp/order"
  (
    # shellcheck disable=SC1090
    source "$script"
    # shellcheck disable=SC2329 # the sourced script calls it
    railway_graphql() {
      case "$1" in
        *"query variables"*)
          printf '%s\n' "$2" >"$tmp/read"
          jq -nc --arg m "$MARKER" --arg t "${OLD_TOKEN:-}" '{data:{variables:({AUTH_SECRET:"production-auth"} + (if $m == "" then {} else {PREVIEW_OWN_SECRETS:$m} end) + (if $t == "" then {} else {RAILWAY_TOKEN:$t} end))}}'
          ;;
        *"query projectTokens"*)
          # Two pages: the token of this preview is on the second one.
          if jq -e 'has("after")' <<<"$2" >/dev/null; then
            echo '{"data":{"projectTokens":{"edges":[{"node":{"id":"tok_preview","environmentId":"env_preview"}}],"pageInfo":{"hasNextPage":false,"endCursor":"c2"}}}}'
          else
            echo '{"data":{"projectTokens":{"edges":[{"node":{"id":"tok_other","environmentId":"env_other"}}],"pageInfo":{"hasNextPage":true,"endCursor":"c1"}}}}'
          fi
          ;;
        *projectTokenDelete*)
          echo revoke >>"$tmp/order"
          printf '%s\n' "$2" >>"$tmp/revokes"
          echo '{"data":{"projectTokenDelete":true}}'
          ;;
        *variableDelete*)
          echo delete >>"$tmp/order"
          printf '%s\n' "$2" >>"$tmp/deletes"
          echo '{"data":{"variableDelete":true}}'
          ;;
        *projectTokenCreate*)
          printf '%s\n' "$2" >>"$tmp/mints"
          [[ -n "$TOKEN" ]] || return 22
          jq -nc --arg t "$TOKEN" '{data:{projectTokenCreate:$t}}'
          ;;
        *variableCollectionUpsert*)
          echo upsert >>"$tmp/order"
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
[[ ! -s "$tmp/new/mints" ]] || fail "sync must not mint a Railway project token"
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
  and ($rows[3].variables | has("RAILWAY_TOKEN") | not)
  and $rows[3].variables.PREVIEW_OWN_SECRETS == "v1"
' "$tmp/new/upserts" >/dev/null \
  || fail "every service should get one new AUTH_SECRET and key; the backend last, with the marker and no Railway token"
if grep -Fq "account-token-value" "$tmp/new/upserts"; then
  fail "the workspace token must never reach a service variable"
fi
jq -e '.environmentId == "env_preview" and .serviceId == "svc_backend"' "$tmp/new/read" >/dev/null \
  || fail "the marker read should target the preview backend"

[[ "$(cat "$tmp/new/psql")" == "postgresql://owner@preview-branch/neondb -v ON_ERROR_STOP=1 -qc DELETE FROM jwkss" ]] \
  || fail "a new preview should delete the JWKS keys copied from production, in the preview database only"

out="$(MARKER="" TOKEN=scoped-token-value run_sync "$tmp/no-db" 2>&1)" || fail "a preview without a database URL should pass: $out"
[[ ! -s "$tmp/no-db/psql" ]] || fail "without OWNER_DB_URL, sync must not run psql"

out="$(MARKER=v1 TOKEN=scoped-token-value DB_URL=postgresql://owner@preview-branch/neondb run_sync "$tmp/kept" 2>&1)" || fail "a marked preview should pass: $out"
[[ ! -s "$tmp/kept/upserts" && ! -s "$tmp/kept/mints" && ! -s "$tmp/kept/psql" && ! -s "$tmp/kept/deletes" ]] \
  || fail "a preview that has its own secrets and no old variable keeps them"
jq -se 'map(.id) == ["tok_preview"]' "$tmp/kept/revokes" >/dev/null \
  || fail "a project token of the environment is revoked even when the variable is already gone"

out="$(MARKER=v1 OLD_TOKEN=old-wake-token run_sync "$tmp/old" 2>&1)" || fail "a marked preview with an old token should pass: $out"
printf '%s' "$out" | grep -Fq "old-wake-token" && fail "sync must not print the old token"
jq -se 'map(.id) == ["tok_preview"]' "$tmp/old/revokes" >/dev/null \
  || fail "only the project token of this preview environment should be revoked"
jq -e '.input == {projectId:"proj_test", environmentId:"env_preview", serviceId:"svc_backend", name:"RAILWAY_TOKEN"}' "$tmp/old/deletes" >/dev/null \
  || fail "RAILWAY_TOKEN should be deleted from the preview backend"
[[ ! -s "$tmp/old/upserts" && ! -s "$tmp/old/mints" ]] || fail "an old preview keeps its own secrets"

out="$(MARKER="" OLD_TOKEN=old-wake-token run_sync "$tmp/legacy" 2>&1)" || fail "an unmarked preview with an old token should pass: $out"
printf '%s' "$out" | grep -Fq "old-wake-token" && fail "sync must not print the old token"
jq -se 'map(.id) == ["tok_preview"]' "$tmp/legacy/revokes" >/dev/null \
  || fail "an unmarked preview should also lose the project token of its environment"
jq -e '.input.name == "RAILWAY_TOKEN" and .input.serviceId == "svc_backend"' "$tmp/legacy/deletes" >/dev/null \
  || fail "an unmarked preview should also lose RAILWAY_TOKEN"
grep -q "PREVIEW_OWN_SECRETS" "$tmp/legacy/upserts" || fail "an unmarked preview still gets its own secrets"
[[ "$(head -1 "$tmp/legacy/order")" == "revoke" && "$(tail -1 "$tmp/legacy/order")" == "delete" ]] \
  || fail "revoke first, and delete RAILWAY_TOKEN (which redeploys) only after the own secrets: $(tr '\n' ' ' <"$tmp/legacy/order")"


# The deploy job must not give the workspace token to steps that run branch code
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
    raise SystemExit("the workspace token must not be written into RAILWAY_TOKEN")
if text.count("sync_preview_own_secrets") != 1:
    raise SystemExit("pr-deploy.yaml must call sync_preview_own_secrets once")
PY

echo "preview-own-secrets tests passed"
