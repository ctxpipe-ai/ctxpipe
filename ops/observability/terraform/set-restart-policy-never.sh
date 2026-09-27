#!/usr/bin/env bash
# Creation-time Railway GraphQL write: restartPolicyType=NEVER.
# Provider 0.6.1 cannot express this field. omitempty on update leaves a
# set value in place, so this script must not be reapplied from a workflow.
set -euo pipefail

SERVICE_ID="${SERVICE_ID:-}"
ENVIRONMENT_ID="${ENVIRONMENT_ID:-}"

if [[ -z "${RAILWAY_TOKEN:-${RAILWAY_API_TOKEN:-}}" ]]; then
  echo "Missing RAILWAY_TOKEN (or RAILWAY_API_TOKEN)" >&2
  exit 1
fi
if [[ -z "$SERVICE_ID" ]]; then
  echo "Missing SERVICE_ID" >&2
  exit 1
fi
if [[ -z "$ENVIRONMENT_ID" ]]; then
  echo "Missing ENVIRONMENT_ID" >&2
  exit 1
fi

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../scripts/railway-graphql.sh"

# shellcheck disable=SC2016
railway_graphql \
  'mutation serviceInstanceUpdate($environmentId: String, $serviceId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(environmentId: $environmentId, serviceId: $serviceId, input: $input) }' \
  "$(jq -nc --arg env "$ENVIRONMENT_ID" --arg service "$SERVICE_ID" '{environmentId:$env, serviceId:$service, input:{restartPolicyType:"NEVER"}}')" \
  >/dev/null

# shellcheck disable=SC2016
response="$(railway_graphql \
  'query serviceInstanceRestartPolicy($environmentId: String!, $serviceId: String!) { serviceInstance(environmentId: $environmentId, serviceId: $serviceId) { restartPolicyType } }' \
  "$(jq -nc --arg env "$ENVIRONMENT_ID" --arg service "$SERVICE_ID" '{environmentId:$env, serviceId:$service}')")"

policy="$(printf '%s' "$response" | jq -r '.data.serviceInstance.restartPolicyType // empty')"
if [[ "$policy" != "NEVER" ]]; then
  echo "Expected restartPolicyType=NEVER, got ${policy:-empty}" >&2
  printf '%s\n' "$response" >&2
  exit 1
fi

echo "Set $SERVICE_ID restartPolicyType=NEVER"
