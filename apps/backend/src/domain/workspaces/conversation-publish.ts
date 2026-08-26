import {
  conversationSessionBranch,
  mayForcePushBranch,
  planChatPullRequest,
} from "./chat-lifecycle.js"
import { isChatSessionBranch } from "./chat-pull-request.js"
import {
  conversationSandboxStatus,
  ensureConversationSessionBranch,
  sanitizeGitRemoteError,
} from "./conversation-files.js"
import type { JobSandboxHandle } from "./job-worktree.js"

export type ConversationPublishPlan = ReturnType<typeof planChatPullRequest>

export async function commitLeftoverConversationFiles(input: {
  handle: JobSandboxHandle
  conversationId: string
  defaultBranch: string
  message: string
}): Promise<{ committed: boolean; branch: string }> {
  const branch = await ensureConversationSessionBranch({
    handle: input.handle,
    conversationId: input.conversationId,
    defaultBranch: input.defaultBranch,
  })
  await input.handle.exec("git add -A", { env: {} })
  const committed = await input.handle.exec(
    `git -c user.email=workspace-chat@ctxpipe.local -c user.name=ctxpipe commit -m ${shellSingleQuote(input.message)}`,
    { env: {} },
  )
  const output = `${committed.stdout}\n${committed.stderr}`
  if (committed.exitCode !== 0 && !/nothing to commit/i.test(output)) {
    throw new Error(committed.stderr || "Failed to commit leftover conversation files")
  }
  return { committed: committed.exitCode === 0, branch }
}

export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function conversationPushRemoteUrl(input: {
  repositoryName: string
  token: string
}): string {
  return `https://x-access-token:${input.token}@github.com/${input.repositoryName}.git`
}

export async function pushConversationSessionBranch(input: {
  handle: JobSandboxHandle
  conversationId: string
  defaultBranch: string
  repositoryName: string
  token: string
  commitMessage: string
}): Promise<
  | { ok: true; branch: string; pushed: boolean }
  | { ok: false; error: "no_changes" | "default_branch" | string }
> {
  const branch = conversationSessionBranch(input.conversationId)
  if (!mayForcePushBranch(branch, input.defaultBranch)) {
    return { ok: false, error: "default_branch" }
  }
  if (!isChatSessionBranch(branch)) {
    return { ok: false, error: "default_branch" }
  }
  await commitLeftoverConversationFiles({
    handle: input.handle,
    conversationId: input.conversationId,
    defaultBranch: input.defaultBranch,
    message: input.commitMessage,
  })
  const status = await conversationSandboxStatus({
    handle: input.handle,
    defaultBranch: input.defaultBranch,
    sessionBranch: branch,
  })
  if (!status.differsFromDefault && !status.unpushed) {
    return { ok: false, error: "no_changes" }
  }
  const remote = conversationPushRemoteUrl({
    repositoryName: input.repositoryName,
    token: input.token,
  })
  const pushed = await input.handle.exec(
    `git push --force-with-lease ${remote} HEAD:refs/heads/${branch}`,
    { env: {} },
  )
  if (pushed.exitCode !== 0) {
    return {
      ok: false,
      error: sanitizeGitRemoteError(
        pushed.stderr || "Failed to push the conversation branch",
        input.token,
      ),
    }
  }
  return { ok: true, branch, pushed: true }
}

export function conversationGithubTreeUrl(input: {
  repositoryName: string
  branch: string
}): string {
  return `https://github.com/${input.repositoryName}/tree/${input.branch}`
}

export function conversationGithubPullUrl(input: {
  repositoryName: string
  prNumber: number
}): string {
  return `https://github.com/${input.repositoryName}/pull/${input.prNumber}`
}

export function chromePullRequestAction(prState: string | null): "create" | "show" {
  return prState === "open" ? "show" : "create"
}
