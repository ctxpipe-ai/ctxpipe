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
  require_access_headers_for_endpoint "$endpoint" "$headers" || return 1
  jq -nc --arg endpoint "$endpoint" --arg headers "$headers" '{
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: ($endpoint + "/v1/traces"),
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: ($endpoint + "/v1/logs"),
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: ($endpoint + "/v1/metrics"),
    OTEL_EXPORTER_OTLP_HEADERS: $headers
  }'
}

# The collector on otel.ctxpipe.dev is behind Cloudflare Access: it refuses headers without an Access service token,
# and the telemetry is lost. Fails (1) when the endpoint is that collector and the headers lack CF-Access-Client-Id or
# CF-Access-Client-Secret, so a deploy stops before it points an app there without its token. Prints no value.
require_access_headers_for_endpoint() {
  local endpoint="$1" headers="$2" name
  [[ "$endpoint" =~ ^https://otel\.ctxpipe\.dev(/|$) ]] || return 0
  for name in CF-Access-Client-Id CF-Access-Client-Secret; do
    if [[ -z "$(otlp_header_values "$headers" "$name")" ]]; then
      echo "preview-otel-vars: $endpoint needs the Access token, but the OTEL headers have no $name." >&2
      return 1
    fi
  done
}

# Every value of one header in an OTLP header list (`Name=value,Name=value`), by name, trimmed, one per line.
otlp_header_values() {
  local headers="$1" name="$2"
  printf '%s' "$headers" | jq -Rr --arg name "$name" '
    split(",")[] | capture("^\\s*(?<k>[^=]+?)\\s*=\\s*(?<v>.*?)\\s*$")? | select((.k | ascii_downcase) == ($name | ascii_downcase)) | .v'
}

# A missing Preview secret falls back to a repository secret of the same name, so the token is compared with
# production's before any preview gets it, header by header: the same client id or secret, a production backend
# without OTEL headers or with only one of the two Access headers, or one that cannot be read fails (1). Until
# production is redeployed with its Access token, its headers are the old stack's `authorization=` and carry no
# Access header: there is no token to compare with, so it returns 2 and the sync gives previews no OTEL variables.
# It reads only OTEL_EXPORTER_OTLP_HEADERS of the production backend and prints no value.
check_preview_otel_differs_from_production() {
  local prod prod_headers name prod_value preview_values same="" access=0
  if ! prod="$(production_backend_vars OTEL_EXPORTER_OTLP_HEADERS)"; then
    echo "preview-otel-vars: cannot read the production OTEL headers to compare." >&2
    return 1
  fi
  prod_headers="$(printf '%s' "$prod" | jq -r '.OTEL_EXPORTER_OTLP_HEADERS // ""')"
  if [[ -z "${prod_headers//[[:space:]]/}" ]]; then
    echo "preview-otel-vars: the production backend has no OTEL headers, so the deploy cannot prove that the Preview token is different." >&2
    return 1
  fi
  for name in CF-Access-Client-Id CF-Access-Client-Secret; do
    [[ -n "$(otlp_header_values "$prod_headers" "$name")" ]] && access=$((access + 1))
  done
  if ((access == 0)); then
    return 2
  fi
  for name in CF-Access-Client-Id CF-Access-Client-Secret; do
    prod_value="$(otlp_header_values "$prod_headers" "$name" | head -1)"
    if [[ -z "$prod_value" ]]; then
      echo "preview-otel-vars: the production backend has no $name in its OTEL headers, so the deploy cannot prove that the Preview token is different." >&2
      return 1
    fi
    preview_values="$(otlp_header_values "${OBSERVABILITY_OTLP_HEADERS:-}" "$name")"
    # One value per header: a second one could carry production's token behind a different first one.
    if (($(printf '%s' "$preview_values" | grep -c '') > 1)); then
      echo "preview-otel-vars: the Preview OBSERVABILITY_OTLP_HEADERS has $name more than once." >&2
      return 1
    fi
    [[ "$preview_values" == "$prod_value" ]] && same+=" $name"
  done
  if [[ -n "$same" ]]; then
    echo "preview-otel-vars: the Preview OBSERVABILITY_OTLP_HEADERS has production's token:${same}." >&2
    echo "preview-otel-vars: a missing Preview environment secret falls back to the repository secret. Set the telemetry-preview token in the GitHub environment Preview." >&2
    return 1
  fi
}

# The previews that the production deploy rolls (CTX-1216): the PR numbers of the preview environments (pr-<N>) whose
# backend's OTEL headers have no Access token, one per line. Their OTEL sync skipped while production had none; a
# roll now sets their variables. It reads the state, not a change, so a re-run of a failed deploy finds the same
# previews, and once each has its token it finds none. It reads only OTEL_EXPORTER_OTLP_HEADERS and prints no value.
previews_without_access_otel() {
  local envs id name vars headers
  envs="$(railway_graphql \
    'query($id: String!) { project(id: $id) { environments { edges { node { id name } } } } }' \
    "$(jq -nc --arg id "$RAILWAY_PROJECT_ID" '{id:$id}')" \
    | jq -r '.data.project.environments.edges[]?.node | select(.name | test("^pr-[0-9]+$")) | "\(.id) \(.name)"')" || return 1
  while read -r id name; do
    [[ -n "$id" ]] || continue
    vars="$(service_vars "$id" "$BACKEND_SERVICE_ID" OTEL_EXPORTER_OTLP_HEADERS)" || return 1
    headers="$(printf '%s' "$vars" | jq -r '.OTEL_EXPORTER_OTLP_HEADERS // ""')"
    [[ -n "$(otlp_header_values "$headers" CF-Access-Client-Id)" ]] || echo "${name#pr-}"
  done <<<"$envs"
}

# Previews send with their own Access service token: OBSERVABILITY_OTLP_HEADERS of the GitHub `Preview` environment,
# never production's. A token that leaks from PR code then can be revoked without touching production.
sync_preview_otel_variables() {
  local vars_json status=0
  check_preview_otel_differs_from_production || status=$?
  if ((status == 2)); then
    echo "preview-otel-vars: production still sends to the old stack (no Access token in its OTEL headers); previews get no OTEL exporter variables until production is redeployed with its token." >&2
    return 0
  fi
  ((status == 0)) || return 1
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
