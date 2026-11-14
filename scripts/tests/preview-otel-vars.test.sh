#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$root/scripts/preview-otel-vars.sh"
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

bash -n "$script" || fail "preview-otel-vars.sh must pass bash -n"

# The guard: the collector on otel.ctxpipe.dev refuses headers without the Access token, so an endpoint there needs
# both Access headers. No endpoint, or another endpoint, needs none.
guard() {
  (
    set -euo pipefail
    # shellcheck disable=SC1091
    source "$script"
    require_access_headers_for_endpoint "$1" "$2"
  )
}
guard "" "authorization=key" || fail "no endpoint needs no Access token"
guard "https://example.test/otel" "authorization=key" || fail "another endpoint keeps its own headers"
guard "https://otel.ctxpipe.dev" "CF-Access-Client-Id=i,CF-Access-Client-Secret=s" \
  || fail "both Access headers pass"
if out="$(guard "https://otel.ctxpipe.dev" "authorization=old-ingest-key" 2>&1)"; then
  fail "the new collector without the Access token should fail"
fi
printf '%s' "$out" | grep -Fq "needs the Access token" || fail "the guard should say why it failed"
if printf '%s' "$out" | grep -Fq old-ingest-key; then fail "the guard must not print a header value"; fi
if guard "https://otel.ctxpipe.dev" "CF-Access-Client-Id=only-id" 2>/dev/null; then
  fail "the new collector with only one of the Access headers should fail"
fi

# Until the cutover, production exports nothing: the ctxpipe module's otel_otlp_endpoint has no default, so Terraform
# sets no exporter endpoint. A TF_VAR would reach the module only through a root variable that infra/ passes on.
deploy_workflow="$root/.github/workflows/deploy.yaml"
endpoint_of_module="$(cd "$root" && bash -c 'source scripts/preview-otel-vars.sh; production_otel_endpoint')"
[[ -z "$endpoint_of_module" ]] \
  || fail "the ctxpipe module's otel_otlp_endpoint should be empty until the cutover (got: $endpoint_of_module)"
if grep -q 'TF_VAR_otel_otlp_endpoint' "$deploy_workflow" && ! grep -q 'variable "otel_otlp_endpoint"' "$root/infra/variables.tf"; then
  fail "deploy.yaml sets TF_VAR_otel_otlp_endpoint, but infra/ has no root variable to take it"
fi
# The production deploy runs the guard on that endpoint before its sync and before Terraform applies.
grep -Fq 'endpoint="$(production_otel_endpoint)"' "$deploy_workflow" \
  || fail "deploy.yaml must check the endpoint that Terraform sets"
grep -Fq 'require_access_headers_for_endpoint "$endpoint" "$OBSERVABILITY_OTLP_HEADERS"' "$deploy_workflow" \
  || fail "deploy.yaml must refuse the new collector without its Access token"
guard_line="$(grep -n 'name: Refuse the new collector without its Access token' "$deploy_workflow" | cut -d: -f1)"
sync_line="$(grep -n 'name: Sync production secrets to Railway' "$deploy_workflow" | cut -d: -f1)"
apply_line="$(grep -n 'name: Terraform Apply' "$deploy_workflow" | cut -d: -f1)"
((guard_line < sync_line && guard_line < apply_line)) \
  || fail "deploy.yaml must refuse before the sync and before Terraform applies"
grep -Fq 'for ENV_ID in $(preview_environment_ids); do' "$deploy_workflow" \
  || fail "the production deploy must remove the OTEL variables of every preview"
envs="$(
  set -euo pipefail
  # shellcheck disable=SC1091
  source "$script"
  railway_graphql() {
    jq -n '{data:{project:{environments:{edges:[{node:{id:"env_prod",name:"production"}},
      {node:{id:"env_1",name:"pr-1"}},{node:{id:"env_x",name:"pr-x"}},{node:{id:"env_2",name:"pr-22"}}]}}}}'
  }
  export RAILWAY_PROJECT_ID=proj_test
  preview_environment_ids
)"
[[ "$(paste -sd' ' - <<<"$envs")" == "env_1 env_2" ]] || fail "only the pr-<N> environments are previews (got: $envs)"
if grep -q 'roll_previews_onto_collector' "$deploy_workflow"; then
  fail "previews get no OTEL variables, so the production deploy rolls none"
fi

assert_workflow_syntax() {
  local workflow="$1"
  python3 - "$workflow" <<'PY' || fail "workflow bash blocks failed bash -n: $workflow"
import pathlib, re, subprocess, sys, tempfile

path = pathlib.Path(sys.argv[1])
text = path.read_text()


def replace_gha_expr(s: str) -> str:
    out = []
    i = 0
    while i < len(s):
        if s.startswith("${{", i):
            depth = 0
            j = i + 1
            while j < len(s):
                if s[j] == "{":
                    depth += 1
                elif s[j] == "}":
                    depth -= 1
                    if depth == 0:
                        j += 1
                        break
                j += 1
            out.append("__GHA__")
            i = j
        else:
            out.append(s[i])
            i += 1
    return "".join(out)


def extract_pipe_blocks(src: str) -> list[str]:
    scripts = []
    lines = src.splitlines()
    i = 0
    while i < len(lines):
        match = re.match(r"^(\s*)(?:run|command):\s*\|\s*$", lines[i])
        if not match:
            i += 1
            continue
        indent = len(match.group(1))
        i += 1
        block = []
        while i < len(lines):
            line = lines[i]
            if line.strip() == "":
                block.append("")
                i += 1
                continue
            leading = len(line) - len(line.lstrip(" "))
            if leading <= indent:
                break
            block.append(line)
            i += 1
        if not block:
            continue
        content_indents = [len(line) - len(line.lstrip(" ")) for line in block if line.strip()]
        strip = min(content_indents) if content_indents else 0
        scripts.append("\n".join(line[strip:] if line.strip() else "" for line in block))
    return scripts


blocks = extract_pipe_blocks(text)
if not blocks:
    raise SystemExit(f"no run/command pipe blocks in {path}")
for index, block in enumerate(blocks):
    checked = replace_gha_expr(block)
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as handle:
        handle.write(checked + "\n")
        tmp = handle.name
    try:
        result = subprocess.run(["bash", "-n", tmp], capture_output=True, text=True)
    finally:
        pathlib.Path(tmp).unlink(missing_ok=True)
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        raise SystemExit(f"{path} run/command block {index} failed bash -n")
PY
}

for workflow in \
  "$root/.github/workflows/pr-deploy.yaml" \
  "$root/.github/workflows/pr-preview-roll-existing.yaml"
do
  [[ -f "$workflow" ]] || fail "missing $workflow"
  grep -Fq 'scripts/preview-otel-vars.sh' "$workflow" || fail "$workflow must source scripts/preview-otel-vars.sh"
  count="$(grep -c 'sync_preview_otel_variables' "$workflow" || true)"
  [[ "$count" == 1 ]] || fail "$workflow must invoke sync_preview_otel_variables once (got $count)"
  assert_workflow_syntax "$workflow"
done
assert_workflow_syntax "$deploy_workflow"

# The preview sync removes the OTEL exporter variables that exist, from the four services, and nothing else.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
out="$(
  set -euo pipefail
  # shellcheck disable=SC1091
  source "$script"
  railway_graphql() {
    case "$1" in
      (*"query variables"*)
        case "$(jq -r .serviceId <<<"$2")" in
          (svc_backend) jq -n '{data:{variables:{
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:"https://otel.ctxpipe.dev/v1/traces",
            OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:"https://otel.ctxpipe.dev/v1/logs",
            OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:"https://otel.ctxpipe.dev/v1/metrics",
            OTEL_EXPORTER_OTLP_HEADERS:"CF-Access-Client-Id=p,CF-Access-Client-Secret=preview-secret",
            DATABASE_URL:"postgresql://should-stay"}}}' ;;
          (svc_worker) jq -n '{data:{variables:{OTEL_EXPORTER_OTLP_HEADERS:"x=preview-secret"}}}' ;;
          (svc_ui) jq -n '{data:{variables:{}}}' ;;
          (svc_codesearch) jq -n '{data:{variables:{OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:"https://otel.ctxpipe.dev/v1/traces"}}}' ;;
        esac ;;
      (*variableDelete*) jq -r '"\(.input.serviceId) \(.input.name) \(.input.environmentId)"' <<<"$2" >>"$tmp/deletes"; echo '{}' ;;
      (*) echo "unexpected query $1" >&2; return 1 ;;
    esac
  }
  export RAILWAY_PROJECT_ID=proj_test ENV_ID=env_preview
  export BACKEND_SERVICE_ID=svc_backend WORKER_SERVICE_ID=svc_worker UI_SERVICE_ID=svc_ui CODESEARCH_SERVICE_ID=svc_codesearch
  sync_preview_otel_variables
)" || fail "the sync should succeed: $out"
expected="svc_backend OTEL_EXPORTER_OTLP_HEADERS env_preview
svc_backend OTEL_EXPORTER_OTLP_LOGS_ENDPOINT env_preview
svc_backend OTEL_EXPORTER_OTLP_METRICS_ENDPOINT env_preview
svc_backend OTEL_EXPORTER_OTLP_TRACES_ENDPOINT env_preview
svc_codesearch OTEL_EXPORTER_OTLP_TRACES_ENDPOINT env_preview
svc_worker OTEL_EXPORTER_OTLP_HEADERS env_preview"
[[ "$(sort "$tmp/deletes")" == "$expected" ]] || fail "the sync should delete exactly the OTEL variables that exist (got: $(sort "$tmp/deletes" | paste -sd';' -))"
if printf '%s' "$out" | grep -Eq 'preview-secret|should-stay|otel\.ctxpipe\.dev'; then fail "the sync must not print a value"; fi

# production_backend_vars stays for the GitHub App guard: it returns only the named variables that exist.
prod_complete="$(jq -nc '{
  OTEL_EXPORTER_OTLP_HEADERS: "CF-Access-Client-Id=prod-id,CF-Access-Client-Secret=prod-secret",
  DATABASE_URL: "postgresql://should-not-copy"
}')"
narrow="$(
  set -euo pipefail
  # shellcheck disable=SC1091
  source "$script"
  railway_graphql() {
    case "$1" in
      (*environments*) jq -n '{data:{project:{environments:{edges:[{node:{id:"env_prod",name:"production"}}]}}}}' ;;
      (*"query variables"*) jq -nc --argjson vars "$prod_complete" '{data:{variables:$vars}}' ;;
      (*) echo "unexpected query $1" >&2; return 1 ;;
    esac
  }
  export RAILWAY_PROJECT_ID=proj_test BACKEND_SERVICE_ID=svc_backend
  production_backend_vars OTEL_EXPORTER_OTLP_HEADERS NOT_SET_IN_PRODUCTION
)" || fail "production_backend_vars should succeed"
[[ "$narrow" == '{"OTEL_EXPORTER_OTLP_HEADERS":"CF-Access-Client-Id=prod-id,CF-Access-Client-Secret=prod-secret"}' ]] \
  || fail "production_backend_vars must return only the named variables that exist (got keys: $(printf '%s' "$narrow" | jq -c keys))"

echo "preview-otel-vars tests passed"
