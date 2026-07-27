#!/usr/bin/env bash
set -euo pipefail

repos=(
  "boxyhq/saas-starter-kit"
  "ory/polis"
  "boxyhq/ui"
)

for repo in "${repos[@]}"; do
  sha="$(git ls-remote "https://github.com/${repo}.git" HEAD | awk '{print $1}')"
  printf '%s %s\n' "$repo" "$sha"
done
