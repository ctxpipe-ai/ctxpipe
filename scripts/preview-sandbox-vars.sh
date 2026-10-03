#!/usr/bin/env bash
# Point a Railway PR preview's backend and worker at Vercel sandboxes for
# hosted chat. Hosted never runs chat unsandboxed, so a missing
# VERCEL_ACCESS_TOKEN fails the deploy. Production gets the same variables
# from Terraform (infra/module/ctxpipe/railway.tf).
set -euo pipefail
# shellcheck source=scripts/preview-service-vars.sh
source "$(dirname "${BASH_SOURCE[0]}")/preview-service-vars.sh"

sync_preview_sandbox_variables() {
  if [[ -z "${VERCEL_ACCESS_TOKEN:-}" ]]; then
    echo "preview-sandbox-vars: the VERCEL_ACCESS_TOKEN secret is empty; hosted chat needs it" >&2
    return 1
  fi
  upsert_service_vars "Vercel sandbox variables" \
    "$(jq -nc --arg token "$VERCEL_ACCESS_TOKEN" '{
      SANDBOX_PROVIDER: "vercel",
      VERCEL_TOKEN: $token,
      VERCEL_TEAM_ID: "ctxpipe",
      VERCEL_PROJECT_ID: "ctxpipe"
    }')" \
    "${BACKEND_SERVICE_ID:-}" "${WORKER_SERVICE_ID:-}"
}
