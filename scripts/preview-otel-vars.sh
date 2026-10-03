#!/usr/bin/env bash
# Build, extract, or sync the four OTEL exporter variables Railway PR previews need.
# Export stays off in app processes until these are set (observability skill).
# Does not print values when sourced; CLI extract/build write JSON to stdout.
# Sync uses the caller's railway_graphql and never prints secret values.
set -euo pipefail
# shellcheck source=scripts/preview-service-vars.sh
source "$(dirname "${BASH_SOURCE[0]}")/preview-service-vars.sh"

preview_otel_vars_extract() {
  jq -ce '
    def req($k):
      (.[$k] // "") | tostring | gsub("^\\s+|\\s+$"; "") as $v
      | if $v == "" then error("missing \($k)") else $v end;
    {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: req("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: req("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"),
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: req("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"),
      OTEL_EXPORTER_OTLP_HEADERS: req("OTEL_EXPORTER_OTLP_HEADERS")
    }
  '
}

preview_otel_vars_build() {
  local endpoint="${1:-https://telemetry.ctxpipe.ai}"
  local headers="${OBSERVABILITY_OTLP_HEADERS:-}"
  endpoint="${endpoint%/}"
  if [[ -z "${headers//[[:space:]]/}" ]]; then
    echo "preview-otel-vars: OBSERVABILITY_OTLP_HEADERS is empty" >&2
    return 1
  fi
  if [[ -z "$endpoint" ]]; then
    echo "preview-otel-vars: OTLP endpoint is empty" >&2
    return 1
  fi
  jq -nc --arg endpoint "$endpoint" --arg headers "$headers" '{
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: ($endpoint + "/v1/traces"),
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: ($endpoint + "/v1/logs"),
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: ($endpoint + "/v1/metrics"),
    OTEL_EXPORTER_OTLP_HEADERS: $headers
  }'
}

preview_otel_vars_json() {
  local prod_env_id prod_vars extracted
  if ! declare -F railway_graphql >/dev/null; then
    echo "preview-otel-vars: railway_graphql is not defined" >&2
    return 1
  fi
  if [[ -z "${RAILWAY_PROJECT_ID:-}" || -z "${BACKEND_SERVICE_ID:-}" ]]; then
    echo "preview-otel-vars: RAILWAY_PROJECT_ID and BACKEND_SERVICE_ID are required" >&2
    return 1
  fi
  prod_env_id="$(railway_graphql \
    'query($id: String!) { project(id: $id) { environments { edges { node { id name } } } } }' \
    "$(jq -nc --arg id "$RAILWAY_PROJECT_ID" '{id:$id}')" \
    | jq -r '.data.project.environments.edges[]?.node | select(.name == "production") | .id' | head -1)" || return 1
  if [[ -z "$prod_env_id" ]]; then
    echo "Could not resolve production Railway environment id" >&2
    return 1
  fi
  prod_vars="$(railway_graphql \
    'query variables($projectId: String!, $environmentId: String!, $serviceId: String) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) }' \
    "$(jq -nc --arg project "$RAILWAY_PROJECT_ID" --arg env "$prod_env_id" --arg service "$BACKEND_SERVICE_ID" '{projectId:$project, environmentId:$env, serviceId:$service}')" \
    | jq -c '.data.variables // {}')" || return 1
  if extracted="$(printf '%s' "$prod_vars" | preview_otel_vars_extract 2>/dev/null)"; then
    echo "Resolved preview OTEL exporter vars from production backend" >&2
    printf '%s' "$extracted"
    return 0
  fi
  echo "Production backend OTEL exporter vars missing; building from OBSERVABILITY_OTLP_HEADERS" >&2
  preview_otel_vars_build
}

sync_preview_otel_variables() {
  local vars_json
  vars_json="$(preview_otel_vars_json)" || return 1
  if [[ -z "$vars_json" ]]; then
    echo "preview-otel-vars: failed to resolve exporter vars" >&2
    return 1
  fi
  upsert_service_vars "OTEL exporter vars" "$vars_json" \
    "${BACKEND_SERVICE_ID:-}" "${WORKER_SERVICE_ID:-}" \
    "${UI_SERVICE_ID:-}" "${CODESEARCH_SERVICE_ID:-}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    extract) preview_otel_vars_extract ;;
    build) preview_otel_vars_build "${2:-}" ;;
    *)
      echo "Usage: scripts/preview-otel-vars.sh extract | build [otlp-base-url]" >&2
      exit 2
      ;;
  esac
fi
