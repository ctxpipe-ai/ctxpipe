#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$root/scripts/preview-otel-vars.sh"
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

bash -n "$script" || fail "preview-otel-vars.sh must pass bash -n"

got="$(OBSERVABILITY_OTLP_HEADERS="CF-Access-Client-Id=preview-id,CF-Access-Client-Secret=preview-secret" "$script" build)"
echo "$got" | jq -e '
  .OTEL_EXPORTER_OTLP_TRACES_ENDPOINT == "https://otel.ctxpipe.dev/v1/traces"
  and .OTEL_EXPORTER_OTLP_LOGS_ENDPOINT == "https://otel.ctxpipe.dev/v1/logs"
  and .OTEL_EXPORTER_OTLP_METRICS_ENDPOINT == "https://otel.ctxpipe.dev/v1/metrics"
  and .OTEL_EXPORTER_OTLP_HEADERS == "CF-Access-Client-Id=preview-id,CF-Access-Client-Secret=preview-secret"
' >/dev/null || fail "build should use the collector on the tunnel by default"

got="$(OBSERVABILITY_OTLP_HEADERS="CF-Access-Client-Id=custom-id,CF-Access-Client-Secret=custom-secret" "$script" build "https://example.test/otel/")"
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
  if grep -E -q 'preview_otel_vars_build\(\)|upsert_preview_otel_variables\(\)' "$workflow"; then
    fail "$workflow must not redefine preview OTEL orchestration"
  fi
  assert_workflow_syntax "$workflow"
done

# The sync reads one production variable, OTEL_EXPORTER_OTLP_HEADERS, only to compare it with the Preview token.
run_sync() {
  local mock_prod_headers="$1"
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
          [[ "$mock_prod_headers" == unreadable ]] && return 1
          jq -nc --arg h "$mock_prod_headers" '{data:{variables:{OTEL_EXPORTER_OTLP_HEADERS:$h, DATABASE_URL:"postgresql://should-not-copy"}}}'
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

out="$(
  OBSERVABILITY_OTLP_HEADERS="CF-Access-Client-Id=preview-id,CF-Access-Client-Secret=preview-secret" \
    run_sync "CF-Access-Client-Id=prod-id,CF-Access-Client-Secret=prod-secret" "$tmp/own-token" 2>&1
)" || fail "sync should succeed with a Preview token that is not production's"
printf '%s' "$out" | grep -Fq "from the Preview OBSERVABILITY_OTLP_HEADERS" \
  || fail "sync should report the Preview token as its source"
if printf '%s' "$out" | grep -Eq 'preview-secret|prod-secret|should-not-copy'; then
  fail "sync must not print OBSERVABILITY_OTLP_HEADERS or production's values"
fi
# A preview sends with its own token, to the default collector.
assert_four_upserts "$tmp/own-token/upserts" "CF-Access-Client-Id=preview-id,CF-Access-Client-Secret=preview-secret"
jq -e '
  .input.variables.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT == "https://otel.ctxpipe.dev/v1/traces"
' "$tmp/own-token/upserts" >/dev/null || fail "sync should build the default collector traces URL"

if OBSERVABILITY_OTLP_HEADERS="" run_sync "" "$tmp/empty-secret" >/dev/null 2>&1; then
  fail "sync should fail when OBSERVABILITY_OTLP_HEADERS is empty"
fi

# A missing Preview secret falls back to the repository secret: production's token must never reach a preview.
same="CF-Access-Client-Id=prod-id,CF-Access-Client-Secret=prod-secret"
if out="$(OBSERVABILITY_OTLP_HEADERS=" $same " run_sync "$same" "$tmp/prod-token" 2>&1)"; then
  fail "sync should fail when the Preview token is production's"
fi
[[ ! -s "$tmp/prod-token/upserts" ]] || fail "sync must not upsert production's token"
printf '%s' "$out" | grep -Fq "has production's token" || fail "sync should say why it failed"
if printf '%s' "$out" | grep -Fq 'prod-secret'; then fail "sync must not print the token"; fi

# The same credentials in another order and spacing are still production's token.
if OBSERVABILITY_OTLP_HEADERS="CF-Access-Client-Secret = prod-secret , CF-Access-Client-Id=other-id" \
  run_sync "$same" "$tmp/reordered" >/dev/null 2>&1; then
  fail "sync should fail when the Preview headers hold production's secret in another order"
fi
# A duplicate header could hide production's secret behind a different first value.
if OBSERVABILITY_OTLP_HEADERS="CF-Access-Client-Id=preview-id,CF-Access-Client-Secret=preview-secret,CF-Access-Client-Secret=prod-secret" \
  run_sync "$same" "$tmp/duplicate" >/dev/null 2>&1; then
  fail "sync should fail when the Preview headers repeat a header"
fi
# A production backend without the headers: nothing to compare with, so fail closed.
if OBSERVABILITY_OTLP_HEADERS="CF-Access-Client-Id=preview-id,CF-Access-Client-Secret=preview-secret" \
  run_sync "" "$tmp/no-prod-headers" >/dev/null 2>&1; then
  fail "sync should fail when the production backend has no OTEL headers"
fi

# Unable to compare: fail closed.
if OBSERVABILITY_OTLP_HEADERS="CF-Access-Client-Id=preview-id,CF-Access-Client-Secret=preview-secret" \
  run_sync unreadable "$tmp/no-prod" >/dev/null 2>&1; then
  fail "sync should fail when it cannot read production's headers to compare"
fi

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
