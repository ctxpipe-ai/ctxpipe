#!/usr/bin/env bash
# Fail before plan when the existing CI credentials are missing.
# Values are never printed.
#
# Provider railway 0.6.1 authenticates with RAILWAY_TOKEN only. It has no
# read-only token, and terraform plan refreshes live resources, so a plan
# cannot run without this token.
#
# The S3 backend reads AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY. When
# GITHUB_ENV is set, publish those from the R2 secret names so later steps
# can `terraform init` without putting the keys on the command line.
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
require "RAILWAY_TOKEN (Railway provider and region pin; no read-only token)" "${RAILWAY_TOKEN:-}"

if (( ${#missing[@]} > 0 )); then
  echo "Missing GitHub secrets for observability Terraform:"
  printf '  - %s\n' "${missing[@]}"
  echo "Service secret values stay on Railway. This workflow only needs existing R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and RAILWAY_TOKEN."
  echo "Those secrets must be available to GitHub Environments terraform-plan and observability."
  echo "terraform-plan should have required reviewers. This script cannot create that rule."
  exit 1
fi

# Reject values that cannot be a single GITHUB_ENV heredoc line.
reject_multiline() {
  local name="$1"
  local value="$2"
  if [[ "$value" == *$'\n'* ]]; then
    echo "Refusing to publish $name: value contains a newline" >&2
    exit 1
  fi
}

publish_env() {
  local name="$1"
  local value="$2"
  local delim="OBS_CRED_${name}_$$"
  reject_multiline "$name" "$value"
  if [[ "$value" == *"$delim"* ]]; then
    echo "Refusing to publish $name" >&2
    exit 1
  fi
  # printf is a bash builtin, so the value is not an external argv.
  {
    builtin printf '%s<<%s\n' "$name" "$delim"
    builtin printf '%s\n' "$value"
    builtin printf '%s\n' "$delim"
  } >>"$GITHUB_ENV"
}

if [[ -n "${GITHUB_ENV:-}" ]]; then
  publish_env AWS_ACCESS_KEY_ID "$R2_ACCESS_KEY_ID"
  publish_env AWS_SECRET_ACCESS_KEY "$R2_SECRET_ACCESS_KEY"
fi

echo "Observability Terraform credentials are set."
