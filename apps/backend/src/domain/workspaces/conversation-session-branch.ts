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
import { workspaceAllowsConversationEdits } from "./chat-sandbox-policy.js"
import type { WorkspaceRevision } from "./revision.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

/** Same read credential the sandbox setup uses; it can never push. */
const SANDBOX_FETCH = `git -c credential.helper='!f() { echo username=x-access-token; echo password=\${CTXPIPE_CLONE_TOKEN}; }; f' fetch -q`

/**
 * Once the session branch's PR is merged or closed, the conversation moves to
 * a fresh branch (`…/<n+1>`) from the Workspace's current commit, before the
 * next turn. Rebasing the old branch onto a default that already holds its
 * squashed work would only conflict. Only a sandbox whose work is all pushed
 * moves; otherwise it stays until a later turn has pushed it.
 */
export async function rotateClosedSessionBranch(input: {
  handle: SandboxHandle
  orgId: string
  conversationId: string
  desired: WorkspaceRevision
}): Promise<boolean> {
  const conversation = await getConversationSession(
    input.orgId,
    input.conversationId,
  )
  if (conversation?.lastChatPrNumber == null) return false
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(
    input.desired.remote.url,
  )
  if (!repositoryName) return false
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
  if (!pull || pull.prState === "open" || pull.branch !== branch) return false
  const next = nextConversationSessionBranch(input.conversationId, branch)
  const moved = await input.handle.process.exec(
    `set -u
[ -z "$(git status --porcelain)" ] || exit 3
[ -z "$(git rev-list -n 1 HEAD --not --remotes)" ] || exit 3
git cat-file -e "$NEW_SHA^{commit}" 2>/dev/null || ${SANDBOX_FETCH} --depth 1 origin "$NEW_SHA" || exit 1
git checkout -q -B "$NEXT" "$NEW_SHA"`,
    { env: { NEW_SHA: input.desired.sha, NEXT: next } },
  )
  if (moved.exitCode !== 0) {
    log.info({
      step: "conversation-session-rotate",
      message: `Session branch kept after its PR closed (exit ${moved.exitCode})`,
      conversationId: input.conversationId,
    })
    return false
  }
  return rotateConversationSessionBranch({
    orgId: input.orgId,
    conversationId: input.conversationId,
    from: conversation.lastBranch,
    to: next,
  })
}

/**
 * A writable conversation works on its session branch from the start, so the
 * agent can commit there (commits on the default branch are refused).
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
  const branch = conversationSessionBranch(
    input.conversationId,
    conversation.lastBranch,
  )
  const result = await input.handle.process.exec(
    '[ "$(git branch --show-current)" != "$DEFAULT_BRANCH" ] || git checkout -q -B "$SESSION"',
    {
      env: {
        DEFAULT_BRANCH: input.desired.defaultBranch,
        SESSION: branch,
      },
    },
  )
  if (result.exitCode !== 0)
    throw new Error("Cannot check out the conversation's session branch")
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
git cat-file -e "$NEW_SHA^{commit}" 2>/dev/null || ${SANDBOX_FETCH} --depth 1 origin "$NEW_SHA" || exit 1
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  ${SANDBOX_FETCH} --unshallow origin "+refs/heads/$B:refs/remotes/origin/$B" "$NEW_SHA" || exit 1
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
