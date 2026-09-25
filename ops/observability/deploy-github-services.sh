#!/usr/bin/env bash
# Redeploy GitHub-built observability services after a main apply.
#
# The Railway GitHub App is not installed on ctxpipe-ai/ctxpipe
# (NO_INSTALLATION), so a push does not rebuild these services.
# serviceInstanceDeployV2 builds the connected repo at the branch already
# set on the service. It does not copy volumes.
#
# Push: deploy a service only when ops/observability/<name>/** changed
# between GITHUB_EVENT_BEFORE and GITHUB_SHA. A missing or all-zero before
# (first push or force push) deploys collector, clickhouse, and
# railway-telemetry.
# workflow_dispatch: DEPLOY_SERVICES=all (default) or a comma-separated
# subset of those three names.
#
# Required when executed: RAILWAY_TOKEN, RAILWAY_PROJECT_ID.
# Optional: RAILWAY_ENVIRONMENT (default production), DEPLOY_WAIT_SECONDS
# (default 600).

select_github_services() {
  local svc raw changed before sha
  if [[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" ]]; then
    raw="${DEPLOY_SERVICES:-all}"
    if [[ -z "$raw" || "$raw" == "all" ]]; then
      printf '%s\n' collector clickhouse railway-telemetry
      return 0
    fi
    while IFS= read -r svc; do
      [[ -z "$svc" ]] && continue
      case "$svc" in
        collector|clickhouse|railway-telemetry) printf '%s\n' "$svc" ;;
        *)
          echo "Unknown deploy service: $svc (expected all, collector, clickhouse, railway-telemetry)" >&2
          return 1
          ;;
      esac
    done < <(printf '%s\n' "$raw" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    return 0
  fi

  before="${GITHUB_EVENT_BEFORE:-}"
  sha="${GITHUB_SHA:-HEAD}"
  if [[ -z "$before" || "$before" =~ ^0+$ ]] || ! git cat-file -e "${before}^{commit}" >/dev/null 2>&1; then
    echo "No usable before commit (${before:-empty}); deploying collector, clickhouse, and railway-telemetry" >&2
    printf '%s\n' collector clickhouse railway-telemetry
    return 0
  fi

  changed="$(git diff --name-only "$before" "$sha")"
  for svc in collector clickhouse railway-telemetry; do
    if printf '%s\n' "$changed" | grep -q "^ops/observability/${svc}/"; then
      printf '%s\n' "$svc"
    fi
  done
}

main() {
  set -euo pipefail
  local root svc sid started
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  # shellcheck disable=SC1091
  source "$root/scripts/railway-graphql.sh"

  TOKEN="${RAILWAY_TOKEN:-${RAILWAY_API_TOKEN:-}}"
  PROJECT_ID="${RAILWAY_PROJECT_ID:-}"
  ENVIRONMENT_NAME="${RAILWAY_ENVIRONMENT:-production}"
  local wait_seconds="${DEPLOY_WAIT_SECONDS:-600}"

  if [[ -z "$TOKEN" ]]; then
    echo "Missing RAILWAY_TOKEN (or RAILWAY_API_TOKEN)" >&2
    exit 1
  fi
  if [[ -z "$PROJECT_ID" ]]; then
    echo "Missing RAILWAY_PROJECT_ID" >&2
    exit 1
  fi

  local -a services=()
  local services_text
  services_text="$(select_github_services)"
  while IFS= read -r svc; do
    [[ -z "$svc" ]] && continue
    services+=("$svc")
  done <<< "$services_text"

  if (( ${#services[@]} == 0 )); then
    echo "No GitHub-built observability service folders changed; skipping Railway deploy."
    exit 0
  fi

  railway_load_project
  echo "Railway environment $ENVIRONMENT_NAME ($ENV_ID)"
  for svc in "${services[@]}"; do
    # ids_by_name is set by railway_load_project.
    # shellcheck disable=SC2154
    sid="$(echo "$ids_by_name" | jq -r --arg name "$svc" '.[$name] // empty')"
    if [[ -z "$sid" ]]; then
      echo "No Railway service named $svc in project $PROJECT_ID" >&2
      exit 1
    fi
    started="$(railway_latest_deployment_created_at "$sid")"
    echo "Deploying $svc ($sid)"
    deploy_service "$sid"
    wait_deploy "$svc" "$sid" "$wait_seconds" "$started"
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main
fi
