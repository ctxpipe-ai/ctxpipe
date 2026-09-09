import { randomUUID } from "node:crypto"
import { open } from "node:fs/promises"
import { join } from "node:path"
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
  planChatPullRequest,
} from "./chat-lifecycle.js"
import { isChatSessionBranch } from "./chat-pull-request.js"
import { workspaceAllowsConversationEdits } from "./chat-sandbox-policy.js"
import {
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

export type ConversationSandboxBinding = {
  githubConnectionId?: string | null
  defaultBranch?: string | null
  desiredGeneration?: number | null
  desiredUrl?: string | null
  desiredSha?: string | null
}

export function planCapturedConversationPublication(input: {
  revision: WorkspaceRevision
  writeStatus: string
  readOnlyReason?: string | null
  sandbox: ConversationSandboxBinding | null
}): ConversationPublishPlan {
  if (input.sandbox?.githubConnectionId !== input.revision.remote.connectionId)
    return { publish: false, reason: "stale_connection" }
  return planChatPullRequest({
    writeStatus: input.writeStatus,
    readOnlyReason: input.readOnlyReason,
    explicitRequest: true,
    host: githubRepoFullNameFromWorkspaceUrl(input.revision.remote.url)
      ? "github"
      : "other",
    defaultBranch: input.revision.defaultBranch,
    capturedDefaultBranch: input.sandbox?.defaultBranch ?? null,
    capturedGeneration: input.sandbox?.desiredGeneration ?? null,
    desiredGeneration: input.revision.generation,
    capturedUrl: input.sandbox?.desiredUrl ?? null,
    desiredUrl: input.revision.remote.url,
    capturedSha: input.sandbox?.desiredSha ?? null,
    desiredSha: input.revision.sha,
  })
}

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
  // The agent supplies Git objects only. A fresh broker directory owns all remote I/O.
  const head = await input.handle.exec("git rev-parse HEAD", { env: {} })
  if (head.exitCode !== 0)
    throw new Error("Cannot capture the conversation commit")
  const sha = gitObjectIdSchema.parse(head.stdout.trim())
  const agentPack = `.git/ctxpipe-publish-${randomUUID()}.pack`
  let readToken: string | undefined
  let writeToken: string | undefined
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
    if (sha === defaultTip.sha) return { ok: false, error: "no_changes" }
    if (sha === sessionTip?.sha) {
      await assertBinding()
      return { ok: true, branch, pushed: false }
    }
    // A quiet rebase rewrites the published session. Prefer that remote tip
    // for shallow restores, then the captured default for rebased history.
    // Publication still leases the observed remote session tip below.
    let packBase: string | undefined
    for (const candidate of new Set([sessionTip?.sha, revision.sha])) {
      if (!candidate) continue
      const ancestor = await input.handle.exec(
        `git merge-base --is-ancestor ${shellSingleQuote(candidate)} ${shellSingleQuote(sha)}`,
        { env: {} },
      )
      if (ancestor.exitCode === 0) {
        packBase = candidate
        break
      }
    }
    if (!packBase)
      return {
        ok: false,
        error:
          "Session branch changed; restore its current revision before publishing",
      }
    const packed = await input.handle.exec(
      `printf '%s\\n' ${shellSingleQuote(sha)} ${shellSingleQuote(`^${packBase}`)} | git pack-objects --stdout --revs --thin > ${shellSingleQuote(agentPack)}`,
      { env: {} },
    )
    if (packed.exitCode !== 0)
      throw new Error("Cannot capture the conversation Git delta")
    const size = await input.handle.exec(
      `wc -c < ${shellSingleQuote(agentPack)}`,
      { env: {} },
    )
    const packBytes = Number(size.stdout.trim())
    if (
      size.exitCode !== 0 ||
      !Number.isSafeInteger(packBytes) ||
      packBytes <= 0
    )
      throw new Error("Invalid conversation Git pack size")
    writeToken = await getRepoWriteCloneToken(input.orgId, input.env, {
      githubConnectionId: connectionId,
      repoFullName: repositoryName,
    })
    if (!writeToken) return { ok: false, error: "not_allowed" }
    await withGitDirectory(sha, async (directory) => {
      // Fetch the known base directly into the broker; never transfer unchanged
      // repository objects through the agent stdout channel.
      await nativeGit(
        directory,
        ["fetch", "--depth", "1", "--", revision.remote.url, packBase],
        undefined,
        gitRemoteEnvironment({ url: revision.remote.url, token: readToken }),
      )
      const localPack = join(directory, ".git", "conversation.pack")
      const output = await open(localPack, "wx")
      try {
        const chunkBytes = 256 * 1024
        for (let offset = 0; offset < packBytes; offset += chunkBytes) {
          const chunk = await input.handle.exec(
            `dd if=${shellSingleQuote(agentPack)} bs=${chunkBytes} skip=${offset / chunkBytes} count=1 2>/dev/null | base64`,
            { env: {} },
          )
          const encoded = chunk.stdout.replace(/\s/g, "")
          const bytes = Buffer.from(encoded, "base64")
          if (
            chunk.exitCode !== 0 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
            bytes.length !== Math.min(chunkBytes, packBytes - offset)
          )
            throw new Error(
              "Conversation Git transfer was truncated or changed",
            )
          await output.writeFile(bytes)
        }
      } finally {
        await output.close()
      }
      await nativeGit(directory, ["index-pack", "--stdin", "--fix-thin"], {
        file: localPack,
      })
      await nativeGit(directory, ["cat-file", "-e", `${sha}^{commit}`])
      const latestDefault = await resolveGitRemoteTip({
        url: revision.remote.url,
        token: writeToken,
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
          token: writeToken,
        }),
      )
    })
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error)
    for (const credential of [readToken, writeToken])
      if (credential) message = sanitizeGitRemoteError(message, credential)
    return { ok: false, error: message }
  } finally {
    await input.handle.exec(`rm -f -- ${shellSingleQuote(agentPack)}`, {
      env: {},
    })
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
