#!/usr/bin/env bash
# Build or sync the four OTEL exporter variables Railway PR previews need.
# Export stays off in app processes until these are set (observability skill).
# Does not print values when sourced; CLI build writes JSON to stdout.
# Sync uses the caller's railway_graphql and never prints secret values.
set -euo pipefail
# shellcheck source=scripts/preview-service-vars.sh
source "$(dirname "${BASH_SOURCE[0]}")/preview-service-vars.sh"

preview_otel_vars_build() {
  local endpoint="${1:-https://otel.ctxpipe.dev}"
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

# Previews send with their own Access service token: OBSERVABILITY_OTLP_HEADERS of the GitHub `Preview` environment,
# never production's. A token that leaks from PR code then can be revoked without touching production.
preview_otel_vars_json() {
  echo "Building preview OTEL exporter vars from the Preview OBSERVABILITY_OTLP_HEADERS" >&2
  preview_otel_vars_build
}

# A missing Preview secret falls back to a repository secret of the same name, so the token is compared with
# production's before any preview gets it: equal, or production unreadable, fails the deploy. It reads only
# OTEL_EXPORTER_OTLP_HEADERS of the production backend and prints no value.
check_preview_otel_differs_from_production() {
  local prod prod_headers preview_headers
  if ! prod="$(production_backend_vars OTEL_EXPORTER_OTLP_HEADERS)"; then
    echo "preview-otel-vars: cannot read the production OTEL headers to compare." >&2
    return 1
  fi
  prod_headers="$(printf '%s' "$prod" | jq -r '.OTEL_EXPORTER_OTLP_HEADERS // "" | gsub("^\\s+|\\s+$"; "")')"
  preview_headers="$(printf '%s' "${OBSERVABILITY_OTLP_HEADERS:-}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ -n "$prod_headers" && "$preview_headers" == "$prod_headers" ]]; then
    echo "preview-otel-vars: the Preview OBSERVABILITY_OTLP_HEADERS is production's token." >&2
    echo "preview-otel-vars: a missing Preview environment secret falls back to the repository secret. Set the telemetry-preview token in the GitHub environment Preview." >&2
    return 1
  fi
}

sync_preview_otel_variables() {
  local vars_json
  check_preview_otel_differs_from_production || return 1
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
    build) preview_otel_vars_build "${2:-}" ;;
    *)
      echo "Usage: scripts/preview-otel-vars.sh build [otlp-base-url]" >&2
      exit 2
      ;;
  esac
fi
