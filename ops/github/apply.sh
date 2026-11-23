#!/usr/bin/env bash
# Create or update each ruleset in ops/github/rulesets/ and each environment
# in ops/github/environments/ on the GitHub repository. The "name" field of
# the file finds the ruleset or the environment. Run it again after you change
# a file. You must be a repository admin (gh auth login).
set -euo pipefail

repo="${1:-ctxpipe-ai/ctxpipe}"
root="$(cd "$(dirname "$0")" && pwd)"

for file in "$root"/rulesets/*.json; do
  name="$(jq -r .name "$file")"
  id="$(gh api "repos/$repo/rulesets?includes_parents=false" --paginate --jq ".[] | select(.name == \"$name\") | .id")"
  if [ -n "$id" ]; then
    gh api --method PUT "repos/$repo/rulesets/$id" --input "$file" --jq '"updated \(.name) \(.id)"'
  else
    gh api --method POST "repos/$repo/rulesets" --input "$file" --jq '"created \(.name) \(.id)"'
  fi
done

# An environment: its deployment branch policy, then exactly the branch
# policies of the file (missing ones added, others removed). Its secrets are
# not in the file: a repository admin sets them in Settings > Environments.
for file in "$root"/environments/*.json; do
  name="$(jq -r .name "$file")"
  jq '{deployment_branch_policy}' "$file" |
    gh api --method PUT "repos/$repo/environments/$name" --input - --jq '"updated environment \(.name)"'
  path="repos/$repo/environments/$name/deployment-branch-policies"
  current="$(gh api "$path" --paginate --jq '.branch_policies[] | "\(.type) \(.name) \(.id)"')"
  wanted="$(jq -r '.branch_policies[] | "\(.type) \(.name)"' "$file")"
  # Names compare as fixed strings: a pattern such as `main*` is a stray
  # policy, not a match of `main`.
  while read -r type pattern; do
    [ -n "$type" ] || continue
    if ! cut -d' ' -f1,2 <<<"$current" | grep -Fqx -- "$type $pattern"; then
      gh api --method POST "$path" -f name="$pattern" -f type="$type" --jq '"added \(.type) \(.name)"'
    fi
  done <<<"$wanted"
  while read -r type pattern id; do
    [ -n "$type" ] || continue
    if ! grep -Fqx -- "$type $pattern" <<<"$wanted"; then
      gh api --method DELETE "$path/$id" --silent
      echo "removed $type $pattern"
    fi
  done <<<"$current"
done
