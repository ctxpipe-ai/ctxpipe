#!/usr/bin/env bash
# Create or update each ruleset in ops/github/rulesets/ on the GitHub
# repository. The "name" field of the file finds the ruleset. Run it again
# after you change a file. You must be a repository admin (gh auth login).
set -euo pipefail

repo="${1:-ctxpipe-ai/ctxpipe}"
dir="$(cd "$(dirname "$0")" && pwd)/rulesets"

for file in "$dir"/*.json; do
  name="$(jq -r .name "$file")"
  id="$(gh api "repos/$repo/rulesets" --paginate --jq ".[] | select(.name == \"$name\") | .id")"
  if [ -n "$id" ]; then
    gh api --method PUT "repos/$repo/rulesets/$id" --input "$file" --jq '"updated \(.name) \(.id)"'
  else
    gh api --method POST "repos/$repo/rulesets" --input "$file" --jq '"created \(.name) \(.id)"'
  fi
done
