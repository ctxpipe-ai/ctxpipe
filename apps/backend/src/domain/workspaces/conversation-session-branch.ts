import type { SandboxHandle } from "@tanstack/ai-sandbox"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getConversationSession,
  rotateConversationSessionBranch,
} from "../../models/conversations.js"
import { getWorkspaceWriteAdmission } from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import { getPullRequestState } from "../../services/github/installation-write-client.js"
import {
  conversationSessionBranch,
  nextConversationSessionBranch,
} from "./chat-lifecycle.js"
import { COMMIT_IDENTITY, SANDBOX_READ_GIT } from "./chat-runtime.js"
import { workspaceAllowsConversationEdits } from "./chat-sandbox-policy.js"
import { adaptTanstackHandle } from "./job-sandbox.js"
import type { JobSandboxHandle } from "./job-worktree.js"
import type { WorkspaceRevision } from "./revision.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

/**
 * Move a sandbox that is on the default branch to the session branch, keeping
 * its uncommitted files. An existing local session branch is checked out as
 * it is (never reset). A sandbox already on another branch stays there.
 */
export async function switchToSessionBranch(input: {
  handle: JobSandboxHandle
  branch: string
  defaultBranch: string
}): Promise<boolean> {
  const result = await input.handle.exec(
    '[ "$(git branch --show-current)" != "$DEFAULT_BRANCH" ] || git checkout -q "$SESSION" 2>/dev/null || git checkout -q -b "$SESSION"',
    { env: { DEFAULT_BRANCH: input.defaultBranch, SESSION: input.branch } },
  )
  return result.exitCode === 0
}

/**
 * A turn in a writable conversation works on its session branch, so the agent
 * can commit there (commits on the default branch are refused). Opening a
 * conversation leaves a new sandbox on the default branch.
 */
export async function checkoutSessionBranch(input: {
  handle: SandboxHandle
  orgId: string
  conversationId: string
  desired: WorkspaceRevision
}): Promise<void> {
  const [conversation, admission] = await Promise.all([
    getConversationSession(input.orgId, input.conversationId),
    withOrgDbContext(input.orgId, () =>
      getWorkspaceWriteAdmission(input.desired.workspaceId),
    ),
  ])
  if (
    !conversation ||
    !admission ||
    !workspaceAllowsConversationEdits(
      admission.writeStatus,
      admission.readOnlyReason,
    )
  )
    return
  const switched = await switchToSessionBranch({
    handle: adaptTanstackHandle(input.handle),
    branch: conversationSessionBranch(
      input.conversationId,
      conversation.lastBranch,
    ),
    defaultBranch: input.desired.defaultBranch,
  })
  if (!switched)
    throw new Error("Cannot check out the conversation's session branch")
}

/**
 * Once the session branch's PR is merged, the conversation moves to a fresh
 * branch (`…/<n+1>`) on the Workspace's new commit. The caller asks only when
 * the default commit moved, as a merge moves it. Work the sandbox has that
 * the merged head does not (later commits, pushed or not, and uncommitted
 * files) is carried over: the commits are rebased onto the new commit. When
 * the agent already rebased the branch onto the new commit (after a
 * conflict), the branch only gets the fresh name. A closed but unmerged PR
 * keeps its branch.
 *
 * `conflict`: the carried work does not apply; the sandbox stays on the old
 * branch with its work, and the turn asks the agent to repair it.
 */
export async function rotateMergedSessionBranch(input: {
  handle: SandboxHandle
  orgId: string
  conversationId: string
  desired: WorkspaceRevision
}): Promise<"rotated" | "kept" | "conflict"> {
  const conversation = await getConversationSession(
    input.orgId,
    input.conversationId,
  )
  if (conversation?.lastChatPrNumber == null) return "kept"
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(
    input.desired.remote.url,
  )
  if (!repositoryName) return "kept"
  const branch = conversationSessionBranch(
    input.conversationId,
    conversation.lastBranch,
  )
  const pull = await getPullRequestState({
    orgId: input.orgId,
    repositoryName,
    env: parseEnv(process.env as Record<string, string | undefined>),
    githubConnectionId: input.desired.remote.connectionId ?? undefined,
    pullNumber: conversation.lastChatPrNumber,
  })
  if (pull?.prState !== "merged" || pull.branch !== branch) return "kept"
  const next = nextConversationSessionBranch(input.conversationId, branch)
  const moved = await input.handle.process.exec(
    `set -u
if [ "$(git branch --show-current)" != "$SESSION" ]; then
  # No local session branch: nothing to carry over.
  git rev-parse -q --verify "refs/heads/$SESSION" >/dev/null || exit 4
  git checkout -q "$SESSION" || exit 42
fi
git cat-file -e "$NEW_SHA^{commit}" 2>/dev/null || ${SANDBOX_READ_GIT} fetch -q --depth 1 origin "$NEW_SHA" || exit 42
if git merge-base --is-ancestor "$NEW_SHA" HEAD; then
  # The agent already rebased the work onto the new commit.
  git branch -M "$NEXT" || exit 42
else
  # Only the commits after the merged head move to the new commit.
  { git cat-file -e "$MERGED^{commit}" 2>/dev/null && git merge-base --is-ancestor "$MERGED" HEAD; } || exit 42
  STASH=
  if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
    git stash push -q --include-untracked -m ctxpipe-rotate && STASH=1
  fi
  restore() {
    git checkout -q "$SESSION" && git branch -q -D "$NEXT"
    [ -z "$STASH" ] || git stash pop -q
    exit 42
  }
  git checkout -q -B "$NEXT" HEAD
  git -c user.name=${COMMIT_IDENTITY.GIT_COMMITTER_NAME} -c user.email=${COMMIT_IDENTITY.GIT_COMMITTER_EMAIL} rebase -q --onto "$NEW_SHA" "$MERGED" || { git rebase --abort; restore; }
  if [ -n "$STASH" ] && ! git stash apply -q --index; then
    git reset -q --hard
    restore
  fi
  [ -z "$STASH" ] || git stash drop -q
  # The old branch's commits now live on the fresh branch.
  git branch -q -D "$SESSION"
fi
git update-ref refs/remotes/ctxpipe/base "$NEW_SHA"`,
    {
      env: {
        NEW_SHA: input.desired.sha,
        MERGED: pull.headSha,
        SESSION: branch,
        NEXT: next,
      },
    },
  )
  if (moved.exitCode !== 0 && moved.exitCode !== 4) {
    log.info({
      step: "conversation-session-rotate",
      message: "The merged session branch's remaining work did not apply",
      conversationId: input.conversationId,
    })
    return "conflict"
  }
  const recorded = await rotateConversationSessionBranch({
    orgId: input.orgId,
    conversationId: input.conversationId,
    from: conversation.lastBranch,
    to: next,
  })
  if (!recorded && moved.exitCode === 0)
    await followRecordedBranch({ ...input, from: next })
  // Still on the default branch: the usual update moves it.
  return moved.exitCode === 4 ? "kept" : "rotated"
}

/**
 * Another writer moved the conversation to a different branch while the
 * sandbox rotated. The record wins: the sandbox's branch gets that name.
 */
async function followRecordedBranch(input: {
  handle: SandboxHandle
  orgId: string
  conversationId: string
  from: string
}): Promise<void> {
  const conversation = await getConversationSession(
    input.orgId,
    input.conversationId,
  )
  if (!conversation) return
  const recorded = conversationSessionBranch(
    input.conversationId,
    conversation.lastBranch,
  )
  if (recorded === input.from) return
  log.warn({
    step: "conversation-session-rotate",
    message: "The conversation moved to another branch during the rotation",
    conversationId: input.conversationId,
  })
  const renamed = await input.handle.process.exec(
    'git branch -M "$FROM" "$RECORDED"',
    { env: { FROM: input.from, RECORDED: recorded } },
  )
  if (renamed.exitCode !== 0)
    throw new Error("Cannot move the sandbox to the conversation's branch")
}

/** Whether the sandbox's HEAD already contains `sha` (no fetch). */
async function sandboxContains(
  handle: SandboxHandle,
  sha: string,
): Promise<boolean> {
  const result = await handle.process.exec(
    'git cat-file -e "$SHA^{commit}" 2>/dev/null && git merge-base --is-ancestor "$SHA" HEAD',
    { env: { SHA: sha } },
  )
  return result.exitCode === 0
}

/**
 * The commit a restored session branch really builds on. A sandbox recreated
 * from the session branch is recorded at the Workspace's current commit, but
 * the branch may build on an older one; the pre-turn update must rebase from
 * there. Fetches the branch's history (the restore is shallow). Null when
 * HEAD already contains `recorded`, or when the base cannot be found (the
 * update then runs as before).
 */
export async function restoredSessionBase(input: {
  handle: SandboxHandle
  recorded: string
  desired: string
}): Promise<string | null> {
  if (await sandboxContains(input.handle, input.recorded)) return null
  const result = await input.handle.process.exec(
    `set -u
B=$(git branch --show-current)
[ -n "$B" ] || exit 1
git cat-file -e "$NEW_SHA^{commit}" 2>/dev/null || ${SANDBOX_READ_GIT} fetch -q --depth 1 origin "$NEW_SHA" || exit 1
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  ${SANDBOX_READ_GIT} fetch -q --unshallow origin "+refs/heads/$B:refs/remotes/origin/$B" "$NEW_SHA" || exit 1
fi
git merge-base HEAD "$NEW_SHA"`,
    { env: { NEW_SHA: input.desired } },
  )
  const base = result.stdout.trim()
  if (result.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(base)) return base
  log.warn({
    step: "conversation-session-restore",
    message: "Cannot find the restored session branch's base",
  })
  return null
}
