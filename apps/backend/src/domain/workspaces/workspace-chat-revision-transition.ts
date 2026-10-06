import type { SandboxHandle } from "@tanstack/ai-sandbox"
import { withOrgDbContext } from "../../db/client.js"
import {
  advanceSandboxInstanceRevision,
  getSandboxInstance,
} from "../../models/workspace-sandboxes.js"
import { getDesiredWorkspaceRevision } from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import { SANDBOX_READ_GIT } from "./chat-runtime.js"
import {
  restoredSessionBase,
  rotateMergedSessionBranch,
} from "./conversation-session-branch.js"
import {
  sameWorkspaceBinding,
  sameWorkspaceRevision,
  type WorkspaceRevision,
} from "./revision.js"

/**
 * Bring a conversation's sandbox to the Workspace's current commit before a
 * turn (option D). The sandbox keeps its identity; Git stashes the
 * conversation's edits, rebases its branch onto the new commit, and restores
 * them. A conflict leaves the sandbox on its previous commit and is reported
 * so the turn can ask the agent to repair the branch. A request whose target
 * the Workspace has already moved past leaves the sandbox where it is.
 *
 * `effective` is set whenever the sandbox is not on `desired` afterwards.
 */
export async function updateConversationSandboxRevision(input: {
  handle: SandboxHandle
  orgId: string
  sandboxKey: string
  desired: WorkspaceRevision
  signal?: AbortSignal
}): Promise<{ effective?: WorkspaceRevision; conflict?: boolean }> {
  const { handle, desired } = input
  const row = await getSandboxInstance(input.sandboxKey, input.orgId)
  let previousRevision = row?.revision
  if (!previousRevision || !sameWorkspaceBinding(previousRevision, desired))
    throw new Error("Conversation sandbox revision is missing")
  const record = async (to: WorkspaceRevision) => {
    if (!previousRevision || previousRevision.sha === to.sha) return
    await advanceSandboxInstanceRevision({
      id: input.sandboxKey,
      orgId: input.orgId,
      from: previousRevision,
      to,
    })
    previousRevision = to
  }
  const defaultMoved = previousRevision.sha !== desired.sha
  // A sandbox restored from its session branch is recorded at the commit it
  // was created for; rebase from the commit the branch really builds on.
  // After the agent repaired a conflict, that can already be `desired`; it
  // is then recorded only after the PR check, so a failed check runs again.
  const base = await restoredSessionBase({
    handle,
    recorded: previousRevision.sha,
    desired: desired.sha,
  })
  const repaired = base === desired.sha
  if (base && !repaired) await record({ ...previousRevision, sha: base })
  if (!defaultMoved && previousRevision.sha === desired.sha) return {}
  const current = await withOrgDbContext(input.orgId, () =>
    getDesiredWorkspaceRevision(desired.workspaceId),
  )
  if (!current || !sameWorkspaceRevision(current, desired)) {
    if (base) await record({ ...previousRevision, sha: base })
    return { effective: previousRevision }
  }
  // The default moved, as a merged PR moves it: a merged session branch
  // continues on a fresh one instead of being rebased.
  const conversationId = row?.conversationId
  if (defaultMoved && conversationId) {
    const rotation = await rotateMergedSessionBranch({
      handle,
      orgId: input.orgId,
      conversationId,
      desired,
    }).catch((error: unknown) => {
      log.warn({
        step: "conversation-session-rotate",
        message: `Checking the session branch's PR failed: ${String(error)}`,
        conversationId,
      })
      return "unknown" as const
    })
    // Without the PR state, keep the sandbox as it is; the next turn checks
    // again.
    if (rotation === "unknown") return { effective: previousRevision }
    if (rotation === "conflict")
      return { effective: previousRevision, conflict: true }
    if (rotation === "rotated") {
      await record(desired)
      return {}
    }
  }
  if (repaired) {
    await record(desired)
    return {}
  }
  if (previousRevision.sha === desired.sha) return {}
  const moved = await advanceConversationWorktree({
    handle,
    from: previousRevision,
    to: desired,
    signal: input.signal,
  })
  if (moved === "conflict")
    return { effective: previousRevision, conflict: true }
  await advanceSandboxInstanceRevision({
    id: input.sandboxKey,
    orgId: input.orgId,
    from: previousRevision,
    to: desired,
  })
  return {}
}

/**
 * The Git half of the update: stash the conversation's edits, rebase its
 * branch onto `to`, restore the edits. Progress is recorded in
 * `.git/ctxpipe-revision-transition`, so a process lost after Git finished
 * resumes as a no-op and only the sandbox record still needs updating.
 */
export async function advanceConversationWorktree(input: {
  handle: SandboxHandle
  from: WorkspaceRevision
  to: WorkspaceRevision
  signal?: AbortSignal
}): Promise<"moved" | "conflict"> {
  const { handle } = input
  const previousRevision = input.from
  const desired = input.to
  const result = await handle.process.exec(
    `(set -eu
STATE=$(git rev-parse --git-path ctxpipe-revision-transition)
BRANCH=$(git branch --show-current)
test -n "$BRANCH"
if ! git cat-file -e "$NEW_SHA^{commit}" 2>/dev/null; then
  ${SANDBOX_READ_GIT} fetch origin "$NEW_SHA"
fi
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  ${SANDBOX_READ_GIT} fetch --unshallow origin
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
git update-ref refs/remotes/ctxpipe/base "$NEW_SHA"
)`,
    {
      signal: input.signal,
      env: {
        OLD_SHA: previousRevision.sha,
        NEW_SHA: desired.sha,
        DEFAULT_BRANCH: previousRevision.defaultBranch,
      },
    },
  )
  if (result.exitCode === 42) return "conflict"
  if (result.exitCode !== 0) throw new Error("Workspace branch update failed")
  return "moved"
}
