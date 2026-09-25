#!/usr/bin/env bash
# Fail before plan when the existing CI credentials are missing.
set -euo pipefail

missing=()
require() {
  local github_name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    missing+=("$github_name")
  fi
}

require R2_ACCESS_KEY_ID "${R2_ACCESS_KEY_ID:-}"
require R2_SECRET_ACCESS_KEY "${R2_SECRET_ACCESS_KEY:-}"
require "RAILWAY_TOKEN (Railway provider and region pin)" "${RAILWAY_TOKEN:-}"

if (( ${#missing[@]} > 0 )); then
  echo "Missing GitHub secrets for observability Terraform:"
  printf '  - %s\n' "${missing[@]}"
  echo "Service secret values stay on Railway. This workflow only needs existing R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and RAILWAY_TOKEN."
  echo "Those secrets must be available to GitHub Environments terraform-plan and observability."
  exit 1
fi

echo "Observability Terraform credentials are set."
