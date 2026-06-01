#!/bin/bash
set -euo pipefail

LOCKFILE="${1:-benchmarks/fixtures/grafana-codeowners-v1.lock.json}"

primary_sha="$(git ls-remote https://github.com/grafana/grafana HEAD | awk '{print $1}')"

tmp_lock="$(mktemp)"
trap 'rm -f "$tmp_lock"' EXIT

jq \
  --arg primary "$primary_sha" \
  '.repos.primary.ref = $primary' \
  "$LOCKFILE" > "$tmp_lock"

mv "$tmp_lock" "$LOCKFILE"

echo "Pinned fixture SHAs:"
echo "  primary (grafana/grafana): $primary_sha"

tmp_package="$(mktemp)"
tmp_codeowners="$(mktemp)"
trap 'rm -f "$tmp_lock" "$tmp_package" "$tmp_codeowners"' EXIT

curl -fsSL "https://raw.githubusercontent.com/grafana/grafana/${primary_sha}/package.json" > "$tmp_package"
curl -fsSL "https://raw.githubusercontent.com/grafana/grafana/${primary_sha}/.github/CODEOWNERS" > "$tmp_codeowners"

rg "codeowners-manifest" "$tmp_package" >/dev/null
rg "@grafana/" "$tmp_codeowners" >/dev/null

echo "Oracle sanity checks passed for pinned SHAs."
