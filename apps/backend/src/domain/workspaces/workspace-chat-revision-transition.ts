import type {
  SandboxEnsureContext,
  SandboxHandle,
  SandboxInstanceRecord,
} from "@tanstack/ai-sandbox"
import { withOrgDbContext } from "../../db/client.js"
import {
  getDesiredWorkspaceRevision,
  getSandboxInstance,
} from "../../models/workspaces.js"
import { sameWorkspaceRevision, type WorkspaceRevision } from "./revision.js"

export class WorkspaceChatRevisionConflict extends Error {
  constructor(readonly revision: WorkspaceRevision) {
    super(
      "The conversation branch conflicts with the updated workspace. Rebase it before continuing; saved edits remain in Git's stash.",
    )
  }
}

/** Git updates the same branch; native ensure owns the lock and exact-record move. */
export async function transitionWorkspaceChatRevision(
  handle: SandboxHandle,
  previous: SandboxInstanceRecord,
  ctx: SandboxEnsureContext,
): Promise<void> {
  const source = ctx.workspace?.source
  const orgId = ctx.tenant?.orgId
  if (!orgId || source?.type !== "git" || !source.commit)
    throw new Error("Workspace transition requires a captured Git revision")
  const stored = await getSandboxInstance(previous.key, orgId)
  const previousRevision = stored?.revision
  if (!previousRevision)
    throw new Error("Previous workspace revision is missing")
  const current = await withOrgDbContext(orgId, () =>
    getDesiredWorkspaceRevision(previousRevision.workspaceId),
  )
  if (
    !current ||
    !sameWorkspaceRevision(current, { ...previousRevision, sha: source.commit })
  )
    throw new WorkspaceChatRevisionConflict(previousRevision)

  const result = await handle.process.exec(
    `(set -eu
STATE=$(git rev-parse --git-path ctxpipe-revision-transition)
BRANCH=$(git branch --show-current)
test -n "$BRANCH"
if ! git cat-file -e "$NEW_SHA^{commit}" 2>/dev/null; then
  git -c credential.helper='!f() { echo username=x-access-token; echo password=\${CTXPIPE_CLONE_TOKEN}; }; f' fetch origin "$NEW_SHA"
fi
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  git -c credential.helper='!f() { echo username=x-access-token; echo password=\${CTXPIPE_CLONE_TOKEN}; }; f' fetch --unshallow origin
fi
# An interrupted/conflicting rebase remains available to the repair turn.
if [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ] || [ -n "$(git diff --name-only --diff-filter=U)" ]; then exit 42; fi
STASH=
REBASE_BASE=$OLD_SHA
ORIGINAL=$(git rev-parse HEAD)
PHASE=starting
TOKEN=$(printf '%s' "$NEW_SHA-$$-$(date +%s)" | git hash-object --stdin)
write_state() {
  printf '%s\\n' "$OLD_SHA" "$NEW_SHA" "$ORIGINAL" "$STASH" "$PHASE" "$TOKEN" "$REBASE_BASE" > "$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
}
if [ -f "$STATE" ]; then
  SAVED_OLD=$(sed -n '1p' "$STATE")
  SAVED_NEW=$(sed -n '2p' "$STATE")
  SAVED_PHASE=$(sed -n '5p' "$STATE")
  if [ "$SAVED_NEW" = "$NEW_SHA" ] && [ "$SAVED_OLD" = "$OLD_SHA" ]; then
    ORIGINAL=$(sed -n '3p' "$STATE")
    STASH=$(sed -n '4p' "$STATE")
    PHASE=$SAVED_PHASE
    TOKEN=$(sed -n '6p' "$STATE")
    REBASE_BASE=$(sed -n '7p' "$STATE")
    REBASE_BASE=\${REBASE_BASE:-$OLD_SHA}
  elif [ "$SAVED_PHASE" = complete ] && [ "$SAVED_OLD" = "$OLD_SHA" ]; then
    # Git completed a superseded target before its native CAS failed.
    # Rebase only this branch's work from that completed target to the new one.
    git merge-base --is-ancestor "$SAVED_NEW" HEAD || exit 42
    REBASE_BASE=$SAVED_NEW
  elif [ "$SAVED_PHASE" != complete ] || [ "$SAVED_NEW" != "$OLD_SHA" ]; then
    exit 42
  fi
fi
if [ "$PHASE" = blocked ]; then
  PHASE=starting
  STASH=
  TOKEN=$(printf '%s' "$NEW_SHA-$$-$(date +%s)" | git hash-object --stdin)
fi
if [ "$PHASE" = complete ]; then
  git merge-base --is-ancestor "$NEW_SHA" HEAD
  exit 0
fi
if [ "$PHASE" = starting ]; then
  write_state
  # Git's uniquely named stash also closes the crash window before write_state.
  FOUND=$(git stash list --format='%H %s' | awk -v name="ctxpipe-revision-$TOKEN" '$NF == name {print $1; exit}')
  if [ -n "$FOUND" ]; then
    STASH=$FOUND
  elif [ -n "$(git status --porcelain)" ]; then
    git -c user.name=ctxpipe -c user.email=chat@ctxpipe.local stash push --include-untracked -m "ctxpipe-revision-$TOKEN" >/dev/null
    STASH=$(git rev-parse refs/stash)
  fi
  PHASE=stashed
  write_state
fi
if [ "$PHASE" = restoring ]; then
  # Never apply a stash twice after interruption; the repair turn can inspect
  # the saved stash, finish the files, and remove this marker explicitly.
  exit 42
fi
if [ "$(git rev-parse HEAD)" = "$ORIGINAL" ] || ! git merge-base --is-ancestor "$NEW_SHA" HEAD; then
  if ! git -c user.name=ctxpipe -c user.email=chat@ctxpipe.local rebase --onto "$NEW_SHA" "$REBASE_BASE"; then
    git rebase --abort
    if [ -n "$STASH" ]; then
      git stash apply --index "$STASH" >/dev/null || exit 42
      STASH=
    fi
    # Preserve the stash itself for recovery; retry starts from the original tree.
    PHASE=blocked
    write_state
    exit 42
  fi
fi
if [ -n "$STASH" ]; then
  PHASE=restoring
  write_state
  if ! git stash apply --index "$STASH" >/dev/null; then
    if [ "$BRANCH" = "$DEFAULT_BRANCH" ]; then
      # Keep the complete stash, including untracked files, as the recoverable
      # backup while the default branch follows the new tip.
      git restore --source="$NEW_SHA" --staged --worktree -- .
    else
      exit 42
    fi
  fi
fi
PHASE=complete
write_state
)`,
    {
      signal: ctx.signal,
      env: {
        OLD_SHA: previousRevision.sha,
        NEW_SHA: source.commit,
        DEFAULT_BRANCH: previousRevision.defaultBranch,
      },
    },
  )
  if (result.exitCode === 42)
    throw new WorkspaceChatRevisionConflict(previousRevision)
  if (result.exitCode !== 0) throw new Error("Workspace branch update failed")
}
