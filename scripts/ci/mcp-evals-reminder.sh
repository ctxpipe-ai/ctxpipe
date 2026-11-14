#!/usr/bin/env bash
# Append the MCP evals reminder to the merge gate comment when the PR changes
# a file under apps/backend/src/mcp/ and has no `mcp-evals` label. The evals
# call paid models, so only the label starts them (mcp-evals.yaml). The
# reminder does not depend on the check selection, so it shows in every mode.
#
# Usage: mcp-evals-reminder.sh <comment-file>
# Environment: GH_TOKEN, REPO, PR. Run it in the checkout of the merge revision
# (its first parent is main): the changed paths come from git, not from the
# GitHub API. With no rename detection, a renamed file counts at its old path.
set -euo pipefail

comment="${1:?usage: mcp-evals-reminder.sh <comment-file>}"
# No comment text (the decision failed): the comment step posts nothing new.
[ -f "$comment" ] || exit 0
# Exit code 0: no change under the path; 1: a change.
code=0
git diff-tree --quiet -r HEAD^1 HEAD -- apps/backend/src/mcp/ || code=$?
[ "$code" = 1 ] || exit "$code"
labels="$(gh api "repos/$REPO/issues/$PR/labels" --jq '.[].name')"
if grep -qx 'mcp-evals' <<<"$labels"; then
  exit 0
fi
{
  echo
  echo "**MCP evals:** this pull request changes the MCP tools. The evals call paid models, so they start only when this pull request has the label \`mcp-evals\`. Add the label before you merge."
} >> "$comment"
