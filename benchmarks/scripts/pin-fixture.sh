#!/bin/bash
set -euo pipefail

LOCKFILE="${1:-benchmarks/fixtures/boxyhq-saas-v1.lock.json}"

primary_sha="$(git ls-remote https://github.com/boxyhq/saas-starter-kit HEAD | awk '{print $1}')"
polis_sha="$(git ls-remote https://github.com/ory/polis HEAD | awk '{print $1}')"
ui_sha="$(git ls-remote https://github.com/boxyhq/ui HEAD | awk '{print $1}')"

tmp_lock="$(mktemp)"
trap 'rm -f "$tmp_lock"' EXIT

jq \
  --arg primary "$primary_sha" \
  --arg polis "$polis_sha" \
  --arg ui "$ui_sha" \
  '.repos.primary.ref = $primary
   | .repos["ory/polis"].ref = $polis
   | .repos["boxyhq/ui"].ref = $ui' \
  "$LOCKFILE" > "$tmp_lock"

mv "$tmp_lock" "$LOCKFILE"

echo "Pinned fixture SHAs:"
echo "  primary (boxyhq/saas-starter-kit): $primary_sha"
echo "  ory/polis: $polis_sha"
echo "  boxyhq/ui: $ui_sha"

tmp_env="$(mktemp)"
tmp_polis="$(mktemp)"
trap 'rm -f "$tmp_lock" "$tmp_env" "$tmp_polis"' EXIT

curl -fsSL "https://raw.githubusercontent.com/boxyhq/saas-starter-kit/${primary_sha}/.env.example" > "$tmp_env"
curl -fsSL "https://raw.githubusercontent.com/ory/polis/${polis_sha}/lib/env.ts" > "$tmp_polis"

rg "JACKSON_URL|JACKSON_EXTERNAL_URL|JACKSON_API_KEY" "$tmp_env" >/dev/null
rg "const samlPath = '/api/oauth/saml'" "$tmp_polis" >/dev/null

echo "Oracle sanity checks passed for pinned SHAs."
