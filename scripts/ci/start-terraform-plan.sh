#!/usr/bin/env bash
# Start terraform-plan-pr.yaml on the PR branch when the PR changes a file
# under infra/. It runs no repository code. The merge gate job
# merge-gate-terraform-plan calls it, in every mode of the gate.
#
# Environment: GH_TOKEN, REPO, BRANCH, PR.
set -euo pipefail

files="$(gh api "repos/$REPO/pulls/$PR/files" --paginate --jq '.[].filename')"
if ! grep -q '^infra/' <<<"$files"; then
  echo "::notice::The PR changes no file under infra/; no Terraform plan"
  exit 0
fi
# The PR can merge and lose its branch while the gate goes on. Skip only on a
# definite answer; any other failure fails the step.
state="$(gh pr view "$PR" --repo "$REPO" --json state --jq .state)"
if [ "$state" != "OPEN" ]; then
  echo "::notice::PR is closed or its branch is gone; no Terraform plan"
  exit 0
fi
if ! out="$(gh api "repos/$REPO/branches/$BRANCH" --silent 2>&1)"; then
  case "$out" in
    *"HTTP 404"*)
      echo "::notice::PR is closed or its branch is gone; no Terraform plan"
      exit 0
      ;;
  esac
  echo "$out" >&2
  exit 1
fi
gh workflow run terraform-plan-pr.yaml --repo "$REPO" --ref "$BRANCH" -f pr_number="$PR"
