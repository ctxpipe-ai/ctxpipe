#!/usr/bin/env bash
# Append the MCP evals reminder to the merge gate comment when the PR changes
# a file under apps/backend/src/mcp/ and has no `mcp-evals` label. The evals
# call paid models, so only the label starts them (mcp-evals.yaml). The
# reminder does not depend on the check selection, so it shows in every mode.
#
# Usage: mcp-evals-reminder.sh <comment-file>
# Environment: GH_TOKEN, REPO, PR.
set -euo pipefail

comment="${1:?usage: mcp-evals-reminder.sh <comment-file>}"
# No comment text (the decision failed): the comment step posts nothing new.
[ -f "$comment" ] || exit 0
files="$(gh api "repos/$REPO/pulls/$PR/files" --paginate --jq '.[].filename')"
if ! grep -q '^apps/backend/src/mcp/' <<<"$files"; then
  exit 0
fi
labels="$(gh api "repos/$REPO/issues/$PR/labels" --jq '.[].name')"
if grep -qx 'mcp-evals' <<<"$labels"; then
  exit 0
fi
{
  echo
  echo "**MCP evals:** this pull request changes the MCP tools. The evals call paid models, so they start only when this pull request has the label \`mcp-evals\`. Add the label before you merge."
} >> "$comment"
