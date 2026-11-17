#!/usr/bin/env bash
# Print the MCP evals reminder for the merge gate summary when the PR changes
# a file under apps/backend/src/mcp/ and has no `mcp-evals` label. Else print
# nothing. The evals call paid models, so only the label starts them
# (mcp-evals.yaml). The reminder does not depend on the check selection, so
# it shows in every mode.
#
# Usage: mcp-evals-reminder.sh
# Environment: GH_TOKEN, REPO, PR. Run it in the checkout of the merge revision
# (its first parent is main): the changed paths come from git, not from the
# GitHub API. With no rename detection, a renamed file counts at its old path.
set -euo pipefail

# Exit code 0: no change under the path; 1: a change.
code=0
git diff-tree --quiet -r HEAD^1 HEAD -- apps/backend/src/mcp/ || code=$?
[ "$code" = 1 ] || exit "$code"
labels="$(gh api "repos/$REPO/issues/$PR/labels" --jq '.[].name')"
if grep -qx 'mcp-evals' <<<"$labels"; then
  exit 0
fi
echo
echo "**MCP evals:** this pull request changes the MCP tools. The evals call paid models, so they start only when this pull request has the label \`mcp-evals\`. Add the label before you merge."
