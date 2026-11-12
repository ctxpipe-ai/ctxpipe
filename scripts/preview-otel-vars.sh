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

# One header's value from an OTLP header list (`Name=value,Name=value`), by name, trimmed.
otlp_header_value() {
  local headers="$1" name="$2"
  printf '%s' "$headers" | jq -Rr --arg name "$name" '
    [split(",")[] | capture("^\\s*(?<k>[^=]+?)\\s*=\\s*(?<v>.*?)\\s*$")? | select((.k | ascii_downcase) == ($name | ascii_downcase)) | .v]
    | first // ""'
}

# A missing Preview secret falls back to a repository secret of the same name, so the token is compared with
# production's before any preview gets it, header by header: the same client id or secret, a production backend
# without the headers, or one that cannot be read fails the deploy. It reads only OTEL_EXPORTER_OTLP_HEADERS of the
# production backend and prints no value.
check_preview_otel_differs_from_production() {
  local prod prod_headers name prod_value same=""
  if ! prod="$(production_backend_vars OTEL_EXPORTER_OTLP_HEADERS)"; then
    echo "preview-otel-vars: cannot read the production OTEL headers to compare." >&2
    return 1
  fi
  prod_headers="$(printf '%s' "$prod" | jq -r '.OTEL_EXPORTER_OTLP_HEADERS // ""')"
  for name in CF-Access-Client-Id CF-Access-Client-Secret; do
    prod_value="$(otlp_header_value "$prod_headers" "$name")"
    if [[ -z "$prod_value" ]]; then
      echo "preview-otel-vars: the production backend has no $name in its OTEL headers, so the deploy cannot prove that the Preview token is different." >&2
      return 1
    fi
    [[ "$(otlp_header_value "${OBSERVABILITY_OTLP_HEADERS:-}" "$name")" == "$prod_value" ]] && same+=" $name"
  done
  if [[ -n "$same" ]]; then
    echo "preview-otel-vars: the Preview OBSERVABILITY_OTLP_HEADERS has production's token:${same}." >&2
    echo "preview-otel-vars: a missing Preview environment secret falls back to the repository secret. Set the telemetry-preview token in the GitHub environment Preview." >&2
    return 1
  fi
}

# Previews send with their own Access service token: OBSERVABILITY_OTLP_HEADERS of the GitHub `Preview` environment,
# never production's. A token that leaks from PR code then can be revoked without touching production.
sync_preview_otel_variables() {
  local vars_json
  check_preview_otel_differs_from_production || return 1
  echo "Building preview OTEL exporter vars from the Preview OBSERVABILITY_OTLP_HEADERS" >&2
  vars_json="$(preview_otel_vars_build)" || return 1
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
