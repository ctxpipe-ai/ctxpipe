#!/usr/bin/env bash
# The OTEL exporter variables of Railway's PR previews. Until the cutover to AWS (CTX-1216, CTX-1217), Railway sends
# no telemetry: previews have no OTEL exporter variables, and the apps export nothing without an endpoint.
# Never prints a value. Uses the caller's railway_graphql.
set -euo pipefail
# shellcheck source=scripts/preview-service-vars.sh
source "$(dirname "${BASH_SOURCE[0]}")/preview-service-vars.sh"

PREVIEW_OTEL_VARIABLES=(
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
  OTEL_EXPORTER_OTLP_HEADERS
)

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

# The OTLP endpoint that the production deploy's Terraform sets: the default of the ctxpipe module's otel_otlp_endpoint.
# infra/ passes the module no value for it, so a TF_VAR would not reach it (2026-11-14).
production_otel_endpoint() {
  local file="${1:-infra/module/ctxpipe/variables.tf}"
  awk '/^variable "otel_otlp_endpoint"/ { found = 1 } found && /^ *default *=/ { sub(/^[^"]*"/, ""); sub(/".*$/, ""); print; exit }' "$file"
}

# Every value of one header in an OTLP header list (`Name=value,Name=value`), by name, trimmed, one per line.
otlp_header_values() {
  local headers="$1" name="$2"
  printf '%s' "$headers" | jq -Rr --arg name "$name" '
    split(",")[] | capture("^\\s*(?<k>[^=]+?)\\s*=\\s*(?<v>.*?)\\s*$")? | select((.k | ascii_downcase) == ($name | ascii_downcase)) | .v'
}

# Removes the OTEL exporter variables from the preview's backend, worker, ui and codesearch (ENV_ID), so the apps
# export nothing. Deletes only the ones that exist: a delete redeploys the service on its current image.
sync_preview_otel_variables() {
  local service_id present name
  if [[ -z "${RAILWAY_PROJECT_ID:-}" || -z "${ENV_ID:-}" ]]; then
    echo "preview-otel-vars: RAILWAY_PROJECT_ID and ENV_ID are required" >&2
    return 1
  fi
  for service_id in "${BACKEND_SERVICE_ID:-}" "${WORKER_SERVICE_ID:-}" "${UI_SERVICE_ID:-}" "${CODESEARCH_SERVICE_ID:-}"; do
    [[ -n "$service_id" ]] || { echo "preview-otel-vars: a service id is empty" >&2; return 1; }
    present="$(service_vars "$ENV_ID" "$service_id" "${PREVIEW_OTEL_VARIABLES[@]}" | jq -r 'keys[]')" || return 1
    for name in $present; do
      railway_graphql \
        'mutation variableDelete($input: VariableDeleteInput!) { variableDelete(input: $input) }' \
        "$(jq -nc --arg project "$RAILWAY_PROJECT_ID" --arg env "$ENV_ID" --arg service "$service_id" --arg name "$name" \
          '{input:{projectId:$project, environmentId:$env, serviceId:$service, name:$name}}')" >/dev/null || return 1
      echo "Removed $name from service $service_id"
    done
  done
}
