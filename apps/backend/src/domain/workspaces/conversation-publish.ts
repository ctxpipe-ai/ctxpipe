import type { Env } from "../../config/env.js"
import { getConversation } from "../../models/conversations.js"
import { getRepoWriteCloneToken } from "../../models/github-installation.js"
import { getWorkspaceWriteAdmission } from "../../models/workspaces.js"
import {
  gitRemoteEnvironment,
  resolveGitRemoteTip,
} from "../../services/git/clone-tree.js"
import { nativeGit, withGitDirectory } from "../../services/git/pack.js"
import {
  conversationSessionBranch,
  mayForcePushBranch,
  type planChatPullRequest,
} from "./chat-lifecycle.js"
import { isChatSessionBranch } from "./chat-pull-request.js"
import { workspaceAllowsConversationEdits } from "./chat-sandbox-policy.js"
import {
  conversationSandboxStatus,
  ensureConversationSessionBranch,
  sanitizeGitRemoteError,
} from "./conversation-files.js"
import type { JobSandboxHandle } from "./job-worktree.js"
import { resolveRepositoryReadCredential } from "./resolve-revision.js"
import {
  gitObjectIdSchema,
  sameWorkspaceRevision,
  type WorkspaceRevision,
} from "./revision.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

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
    throw new Error(
      committed.stderr || "Failed to commit leftover conversation files",
    )
  }
  return { committed: committed.exitCode === 0, branch }
}

export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export async function pushConversationSessionBranch(input: {
  handle: JobSandboxHandle
  conversationId: string
  orgId: string
  workspaceId: string
  revision: WorkspaceRevision
  env: Env
  commitMessage: string
}): Promise<
  | { ok: true; branch: string; pushed: boolean }
  | { ok: false; error: "no_changes" | "default_branch" | string }
> {
  const branch = conversationSessionBranch(input.conversationId)
  const { revision } = input
  if (!mayForcePushBranch(branch, revision.defaultBranch)) {
    return { ok: false, error: "default_branch" }
  }
  if (!isChatSessionBranch(branch)) {
    return { ok: false, error: "default_branch" }
  }
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(revision.remote.url)
  const connectionId = revision.remote.connectionId
  if (!repositoryName || !connectionId)
    return { ok: false, error: "not_github" }
  const assertBinding = async () => {
    const conversation = await getConversation(input.conversationId, {
      workspaceId: input.workspaceId,
    })
    const current = await getWorkspaceWriteAdmission(input.workspaceId)
    if (
      !conversation ||
      conversation.orgId !== input.orgId ||
      !current ||
      !sameWorkspaceRevision(current.revision, {
        ...revision,
        sha: current.revision.sha,
        access: current.revision.access,
      })
    )
      throw new Error("Conversation write binding changed before push")
    if (
      !workspaceAllowsConversationEdits(
        current.writeStatus,
        current.readOnlyReason,
      )
    )
      throw new Error("Conversation repository write access is unavailable")
  }
  await assertBinding()
  await commitLeftoverConversationFiles({
    handle: input.handle,
    conversationId: input.conversationId,
    defaultBranch: revision.defaultBranch,
    message: input.commitMessage,
  })
  const status = await conversationSandboxStatus({
    handle: input.handle,
    defaultBranch: revision.defaultBranch,
    sessionBranch: branch,
  })
  if (!status.differsFromDefault && !status.unpushed) {
    return { ok: false, error: "no_changes" }
  }
  // The agent supplies Git objects only. A fresh broker directory owns all remote I/O.
  const head = await input.handle.exec("git rev-parse HEAD", { env: {} })
  if (head.exitCode !== 0)
    throw new Error("Cannot capture the conversation commit")
  const sha = gitObjectIdSchema.parse(head.stdout.trim())
  const packed = await input.handle.exec(
    `printf '%s\\n' ${shellSingleQuote(sha)} | git pack-objects --stdout --revs | base64`,
    { env: {} },
  )
  const objects = packed.stdout.replace(/\s/g, "")
  if (
    packed.exitCode !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(objects) ||
    objects.length > Math.ceil((8 * 1024 * 1024) / 3) * 4
  )
    throw new Error(
      "Conversation Git pack is missing or exceeds the publish limit",
    )
  const shallowResult = await input.handle.exec(
    "test ! -f .git/shallow || cat .git/shallow",
    { env: {} },
  )
  const shallow = shallowResult.stdout
  if (
    shallowResult.exitCode !== 0 ||
    shallow
      .split(/\s+/)
      .filter(Boolean)
      .some((value) => !gitObjectIdSchema.safeParse(value).success)
  )
    throw new Error("Invalid conversation Git shallow boundary")
  let readToken: string | undefined
  let token: string | null | undefined
  try {
    readToken = await resolveRepositoryReadCredential({
      orgId: input.orgId,
      env: input.env,
      remote: revision.remote,
    })
    const defaultTip = await resolveGitRemoteTip({
      url: revision.remote.url,
      token: readToken,
    })
    if (
      defaultTip?.branch !== revision.defaultBranch ||
      defaultTip.branch === branch
    )
      return { ok: false, error: "default_branch" }
    const sessionTip = await resolveGitRemoteTip({
      url: revision.remote.url,
      branch,
      token: readToken,
    })
    token = await getRepoWriteCloneToken(input.orgId, input.env, {
      githubConnectionId: connectionId,
      repoFullName: repositoryName,
    })
    if (!token) return { ok: false, error: "not_allowed" }
    await withGitDirectory(
      sha,
      async (directory) => {
        const latestDefault = await resolveGitRemoteTip({
          url: revision.remote.url,
          token: token ?? undefined,
        })
        if (
          latestDefault?.branch !== revision.defaultBranch ||
          latestDefault.branch === branch
        )
          throw new Error("Default branch changed during credential issuance")
        await assertBinding()
        await nativeGit(
          directory,
          [
            "push",
            "--porcelain",
            `--force-with-lease=refs/heads/${branch}:${sessionTip?.sha ?? ""}`,
            "--",
            revision.remote.url,
            `${sha}:refs/heads/${branch}`,
          ],
          undefined,
          gitRemoteEnvironment({
            url: revision.remote.url,
            token: token ?? undefined,
          }),
        )
      },
      { sha, objects, shallow },
    )
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error)
    for (const credential of [readToken, token])
      if (credential) message = sanitizeGitRemoteError(message, credential)
    return { ok: false, error: message }
  }
  await input.handle.exec(
    `git update-ref ${shellSingleQuote(`refs/remotes/origin/${branch}`)} ${shellSingleQuote(sha)}`,
    { env: {} },
  )
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

export function chromePullRequestAction(
  prState: string | null,
): "create" | "show" {
  return prState === "open" ? "show" : "create"
}
