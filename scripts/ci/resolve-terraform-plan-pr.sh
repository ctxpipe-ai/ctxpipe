#!/usr/bin/env bash
# Resolve the PR for terraform-plan-pr.yaml and write the job outputs.
# Each value comes from the environment, never from an inline expression, so a
# branch name or an input stays data. The workflow file comes from the PR
# branch, so this script is a sanity check, not a security boundary.
#
# Environment: GH_TOKEN, REPO, INPUT_PR_NUMBER, BRANCH, REF, RUN_SHA,
# GITHUB_OUTPUT.
# Outputs: base_sha, merge_sha (the merge commit that the plan checks out) and
# current (false when the PR head moved on after the run started).
set -euo pipefail

if [[ ! "$INPUT_PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "The pr_number input must be a number" >&2
  exit 1
fi
PR_JSON="$(gh api "repos/${REPO}/pulls/${INPUT_PR_NUMBER}")"
# Only branches of this repository (not forks): the plan runs the code of the
# branch with the state keys.
if [[ "$(jq -r .head.repo.full_name <<<"$PR_JSON")" != "$REPO" ]]; then
  echo "::error::Refusing to plan fork PR #${INPUT_PR_NUMBER}"
  exit 1
fi
if [[ "$(jq -r .head.ref <<<"$PR_JSON")" != "$BRANCH" || "$REF" != "refs/heads/${BRANCH}" ]]; then
  echo "::error::Run this workflow from the branch of PR #${INPUT_PR_NUMBER}, not from ${BRANCH}."
  exit 1
fi
# The plan covers the merge of the PR into its base, as the pull_request
# trigger did. A base that moved on shows as a change of the branch otherwise.
merge_sha="$(jq -r '.merge_commit_sha // empty' <<<"$PR_JSON")"
if [[ ! "$merge_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::PR #${INPUT_PR_NUMBER} has no merge commit. Resolve its merge conflict, then run this workflow again."
  exit 1
fi
# GitHub can lag behind a push: the merge commit must hold the PR head, or it
# plans older code.
head_sha="$(jq -r .head.sha <<<"$PR_JSON")"
if ! gh api "repos/${REPO}/commits/${merge_sha}" --jq '.parents[].sha' | grep -qx "$head_sha"; then
  echo "::error::The merge commit of PR #${INPUT_PR_NUMBER} does not hold its head yet. Run this workflow again in a minute."
  exit 1
fi
{
  echo "base_sha=$(jq -r .base.sha <<<"$PR_JSON")"
  echo "merge_sha=${merge_sha}"
} >> "$GITHUB_OUTPUT"
# A newer push started its own run of the merge gate. This run is stale: it
# would plan old code and replace the newer comment.
if [[ "$head_sha" != "$RUN_SHA" ]]; then
  echo "::notice::The PR head moved on; a newer run plans it"
  echo "current=false" >> "$GITHUB_OUTPUT"
else
  echo "current=true" >> "$GITHUB_OUTPUT"
fi
