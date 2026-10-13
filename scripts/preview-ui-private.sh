#!/usr/bin/env bash
# Keep backend-to-UI traffic of a Railway PR preview on the private network.
# Production does the same (infra/module/ctxpipe/railway.tf), and its UI has
# no public domain. Each Railway environment has its own private network, so
# `ui.RAILWAY_PRIVATE_DOMAIN` resolves to this preview's UI, not to production.
# Users and the smoke tests reach the UI through the backend public URL.
# Uses the caller's railway_graphql, RAILWAY_PROJECT_ID, ENV_ID,
# BACKEND_SERVICE_ID, and UI_SERVICE_ID.
set -euo pipefail

# Set backend UI_PROXY_URL to the UI private domain. The UI listens on 3002
# (its PORT variable). Through a public UI domain, each proxied page load
# left Railway and came back through the edge as billed UI egress.
point_preview_backend_at_private_ui() {
  # shellcheck disable=SC2016 # Railway reads the reference, not the shell
  local url='http://${{ui.RAILWAY_PRIVATE_DOMAIN}}:3002'
  railway_graphql \
    'mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }' \
    "$(jq -nc --arg project "$RAILWAY_PROJECT_ID" --arg env "$ENV_ID" --arg service "$BACKEND_SERVICE_ID" --arg url "$url" \
      '{input:{projectId:$project,environmentId:$env,serviceId:$service,skipDeploys:true,variables:{UI_PROXY_URL:$url}}}')" >/dev/null || return 1
  echo "Set backend UI_PROXY_URL=$url"
}

# Delete each public service domain of the UI in this environment. Older
# previews got one when UI_PROXY_URL used it. Call this only after the
# backend runs with the private UI_PROXY_URL.
remove_preview_ui_public_domains() {
  local response id domain
  response="$(railway_graphql \
    'query serviceInstanceDomain($environmentId: String!, $serviceId: String!) { serviceInstance(environmentId: $environmentId, serviceId: $serviceId) { domains { serviceDomains { id domain } } } }' \
    "$(jq -nc --arg env "$ENV_ID" --arg service "$UI_SERVICE_ID" '{environmentId:$env, serviceId:$service}')")" || return 1
  while IFS=$'\t' read -r id domain; do
    [[ -n "$id" ]] || continue
    railway_graphql \
      'mutation serviceDomainDelete($id: String!) { serviceDomainDelete(id: $id) }' \
      "$(jq -nc --arg id "$id" '{id:$id}')" >/dev/null || return 1
    echo "Removed preview UI public domain $domain"
  done < <(echo "$response" | jq -r '.data.serviceInstance.domains.serviceDomains[]? | [.id, .domain] | @tsv')
}
