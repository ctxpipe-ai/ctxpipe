#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$root/scripts/preview-otel-vars.sh"
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

bash -n "$script" || fail "preview-otel-vars.sh must pass bash -n"

got="$(
  jq -n '{
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://telemetry.ctxpipe.ai/v1/traces",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://telemetry.ctxpipe.ai/v1/logs",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://telemetry.ctxpipe.ai/v1/metrics",
    OTEL_EXPORTER_OTLP_HEADERS: "authorization=test-ingest",
    DATABASE_URL: "postgresql://should-not-copy"
  }' | "$script" extract
)"
echo "$got" | jq -e '
  .OTEL_EXPORTER_OTLP_TRACES_ENDPOINT == "https://telemetry.ctxpipe.ai/v1/traces"
  and .OTEL_EXPORTER_OTLP_LOGS_ENDPOINT == "https://telemetry.ctxpipe.ai/v1/logs"
  and .OTEL_EXPORTER_OTLP_METRICS_ENDPOINT == "https://telemetry.ctxpipe.ai/v1/metrics"
  and .OTEL_EXPORTER_OTLP_HEADERS == "authorization=test-ingest"
  and (keys | length) == 4
  and (has("DATABASE_URL") | not)
' >/dev/null || fail "extract should keep only the four exporter keys"

if jq -n '{OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:"https://telemetry.ctxpipe.ai/v1/traces"}' | "$script" extract 2>/dev/null; then
  fail "extract should fail when headers/logs/metrics are missing"
fi

got="$(OBSERVABILITY_OTLP_HEADERS="authorization=from-secret" "$script" build)"
echo "$got" | jq -e '
  .OTEL_EXPORTER_OTLP_TRACES_ENDPOINT == "https://telemetry.ctxpipe.ai/v1/traces"
  and .OTEL_EXPORTER_OTLP_LOGS_ENDPOINT == "https://telemetry.ctxpipe.ai/v1/logs"
  and .OTEL_EXPORTER_OTLP_METRICS_ENDPOINT == "https://telemetry.ctxpipe.ai/v1/metrics"
  and .OTEL_EXPORTER_OTLP_HEADERS == "authorization=from-secret"
' >/dev/null || fail "build should use the ClickStack public collector default"

got="$(OBSERVABILITY_OTLP_HEADERS="authorization=custom" "$script" build "https://example.test/otel/")"
echo "$got" | jq -e '
  .OTEL_EXPORTER_OTLP_TRACES_ENDPOINT == "https://example.test/otel/v1/traces"
' >/dev/null || fail "build should trim a trailing slash on a custom endpoint"

if OBSERVABILITY_OTLP_HEADERS="" "$script" build 2>/dev/null; then
  fail "build should fail when OBSERVABILITY_OTLP_HEADERS is empty"
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
  if grep -E -q 'preview_otel_vars_json\(\)|upsert_preview_otel_variables\(\)' "$workflow"; then
    fail "$workflow must not redefine preview OTEL orchestration"
  fi
  assert_workflow_syntax "$workflow"
done

run_sync() {
  local mock_prod_vars_json="$1"
  local tmp="$2"
  mkdir -p "$tmp"
  : >"$tmp/queries"
  : >"$tmp/upserts"
  (
    set -euo pipefail
    # shellcheck disable=SC1091
    source "$script"
    curl() { fail "orchestration must not call curl; mock railway_graphql instead"; }
    railway_graphql() {
      local query="$1"
      local variables="$2"
      printf '%s\n' "$query" >>"$tmp/queries"
      case "$query" in
        *environments*)
          jq -n '{data:{project:{environments:{edges:[{node:{id:"env_prod",name:"production"}}]}}}}'
          ;;
        *"query variables"*)
          printf '%s\n' "$variables" >"$tmp/prod_read"
          jq -nc --argjson vars "$mock_prod_vars_json" '{data:{variables:$vars}}'
          ;;
        *variableCollectionUpsert*)
          printf '%s\n' "$variables" >>"$tmp/upserts"
          echo '{"data":{"variableCollectionUpsert":true}}'
          ;;
        *)
          echo "unexpected railway_graphql query: $query" >&2
          return 1
          ;;
      esac
    }
    export RAILWAY_PROJECT_ID=proj_test
    export ENV_ID=env_preview
    export BACKEND_SERVICE_ID=svc_backend
    export WORKER_SERVICE_ID=svc_worker
    export UI_SERVICE_ID=svc_ui
    export CODESEARCH_SERVICE_ID=svc_codesearch
    export OBSERVABILITY_OTLP_HEADERS="${OBSERVABILITY_OTLP_HEADERS-}"
    sync_preview_otel_variables
  )
}

assert_four_upserts() {
  local upserts_file="$1"
  local expected_headers="$2"
  local count
  count="$(wc -l <"$upserts_file" | tr -d ' ')"
  [[ "$count" == 4 ]] || fail "expected 4 service upserts, got $count"
  python3 - "$upserts_file" "$expected_headers" <<'PY' || fail "upsert payloads did not match expected OTEL vars"
import json, sys
path, headers = sys.argv[1], sys.argv[2]
wanted = [
    "svc_backend",
    "svc_worker",
    "svc_ui",
    "svc_codesearch",
]
rows = [json.loads(line) for line in open(path) if line.strip()]
if [row["input"]["serviceId"] for row in rows] != wanted:
    raise SystemExit(f"service order { [row['input']['serviceId'] for row in rows] } != {wanted}")
for row in rows:
    inp = row["input"]
    if inp["projectId"] != "proj_test" or inp["environmentId"] != "env_preview":
        raise SystemExit("upsert targeted the wrong project/env")
    if inp.get("skipDeploys") is not True:
        raise SystemExit("upsert must set skipDeploys=true")
    vars_ = inp["variables"]
    if set(vars_) != {
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
        "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
        "OTEL_EXPORTER_OTLP_HEADERS",
    }:
        raise SystemExit(f"unexpected keys {sorted(vars_)}")
    if vars_["OTEL_EXPORTER_OTLP_HEADERS"] != headers:
        raise SystemExit("headers did not match expected source")
    if "DATABASE_URL" in vars_:
        raise SystemExit("DATABASE_URL must not be copied")
    for key, suffix in (
        ("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "/v1/traces"),
        ("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "/v1/logs"),
        ("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "/v1/metrics"),
    ):
        if not vars_[key].endswith(suffix):
            raise SystemExit(f"{key} missing {suffix}")
PY
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

prod_complete="$(jq -nc '{
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://telemetry.ctxpipe.ai/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://telemetry.ctxpipe.ai/v1/logs",
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://telemetry.ctxpipe.ai/v1/metrics",
  OTEL_EXPORTER_OTLP_HEADERS: "authorization=from-prod",
  DATABASE_URL: "postgresql://should-not-copy"
}')"
out="$(
  OBSERVABILITY_OTLP_HEADERS="authorization=from-secret" \
    run_sync "$prod_complete" "$tmp/from-prod" 2>&1
)" || fail "sync should succeed when production backend has exporter vars"
printf '%s' "$out" | grep -Fq "Resolved preview OTEL exporter vars from production backend" \
  || fail "sync should report the production-backend source"
if printf '%s' "$out" | grep -Eq 'authorization=from-prod|authorization=from-secret|postgresql://should-not-copy'; then
  fail "orchestration must not print OTEL headers or DATABASE_URL"
fi
assert_four_upserts "$tmp/from-prod/upserts" "authorization=from-prod"
jq -e '
  .projectId == "proj_test"
  and .environmentId == "env_prod"
  and .serviceId == "svc_backend"
' "$tmp/from-prod/prod_read" >/dev/null || fail "production read must target production backend"

prod_missing='{}'
out="$(
  OBSERVABILITY_OTLP_HEADERS="authorization=from-secret" \
    run_sync "$prod_missing" "$tmp/from-secret" 2>&1
)" || fail "sync should fall back to OBSERVABILITY_OTLP_HEADERS when production vars are incomplete"
printf '%s' "$out" | grep -Fq "building from OBSERVABILITY_OTLP_HEADERS" \
  || fail "sync should report the secret fallback"
if printf '%s' "$out" | grep -Fq "authorization=from-secret"; then
  fail "fallback must not print OBSERVABILITY_OTLP_HEADERS"
fi
assert_four_upserts "$tmp/from-secret/upserts" "authorization=from-secret"
jq -e '
  .input.variables.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT == "https://telemetry.ctxpipe.ai/v1/traces"
' "$tmp/from-secret/upserts" >/dev/null || fail "fallback should build the default collector traces URL"

if OBSERVABILITY_OTLP_HEADERS="" run_sync '{}' "$tmp/empty-secret" >/dev/null 2>&1; then
  fail "sync should fail when production vars and OBSERVABILITY_OTLP_HEADERS are both missing"
fi

if (
  set -euo pipefail
  # shellcheck disable=SC1091
  source "$script"
  curl() { fail "orchestration must not call curl; mock railway_graphql instead"; }
  railway_graphql() {
    case "$1" in
      *environments*) echo '{"data":{"project":{"environments":{"edges":[]}}}}' ;;
      *) echo "unexpected query $1" >&2; return 1 ;;
    esac
  }
  export RAILWAY_PROJECT_ID=proj_test ENV_ID=env_preview
  export BACKEND_SERVICE_ID=svc_backend WORKER_SERVICE_ID=svc_worker
  export UI_SERVICE_ID=svc_ui CODESEARCH_SERVICE_ID=svc_codesearch
  export OBSERVABILITY_OTLP_HEADERS="authorization=from-secret"
  sync_preview_otel_variables
) >/dev/null 2>&1; then
  fail "sync should fail when the production Railway environment cannot be resolved"
fi

echo "preview-otel-vars tests passed"
