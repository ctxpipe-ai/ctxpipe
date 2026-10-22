import { randomUUID } from "node:crypto"
import { open } from "node:fs/promises"
import { join } from "node:path"
import type { Env } from "../../config/env.js"
import {
  type ConversationPushTrigger,
  type ConversationSync,
  saveConversationSync,
} from "../../models/conversation-turn-changes.js"
import {
  getConversationSession,
  recordConversationSessionPush,
} from "../../models/conversations.js"
import { getRepoWriteCloneToken } from "../../models/github-installation.js"
import { getOrganizationSlugByOrgId } from "../../models/organizations.js"
import {
  getWorkspaceById,
  getWorkspaceWriteAdmission,
  writesLegacyKnowledge,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import {
  gitRemoteEnvironment,
  resolveGitRemoteTip,
} from "../../services/git/clone-tree.js"
import { parseNameStatus } from "../../services/git/name-status.js"
import { nativeGit, withGitDirectory } from "../../services/git/pack.js"
import {
  workspaceRelativePath,
  workspaceRepositoryPath,
} from "../../services/git/root-folder.js"
import { compareBranchChanges } from "../../services/github/installation-write-client.js"
import { SOURCE_FILES_FOLDER } from "../workspace-sources/source-file.js"
import {
  type ChatPublishBlock,
  conversationSessionBranch,
  isChatSessionBranch,
  mayForcePushBranch,
  planChatPullRequest,
} from "./chat-lifecycle.js"
import { COMMIT_IDENTITY } from "./chat-runtime.js"
import { workspaceAllowsConversationEdits } from "./chat-sandbox-policy.js"
import {
  getConversationSandboxBinding,
  sanitizeGitRemoteError,
  UNPUSHED_COMMITS_COMMAND,
} from "./conversation-files.js"
import { switchToSessionBranch } from "./conversation-session-branch.js"
import { addedOwnershipField } from "./host-only.js"
import type { JobSandboxHandle } from "./job-worktree.js"
import {
  type BranchChanges,
  pullRequestBody,
  pullRequestTitle,
} from "./pull-request-text.js"
import { resolveRepositoryReadCredential } from "./resolve-revision.js"
import {
  gitObjectIdSchema,
  sameWorkspaceRevision,
  type WorkspaceRevision,
} from "./revision.js"
import {
  gitChangesOutsideWorkspaceRoot,
  workspaceRootPath,
} from "./root-path.js"
import { workspaceChatPersistence } from "./workspace-chat-persistence.js"
import {
  readWorkspaceFormat,
  SOURCE_FILES_FORMAT,
  WORKSPACE_FORMAT_PATH,
  workspaceFormatAtLeast,
} from "./workspace-format.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

type ConversationSandboxBinding = {
  githubConnectionId?: string | null
  defaultBranch?: string | null
  desiredGeneration?: number | null
  desiredUrl?: string | null
  desiredSha?: string | null
}

function planCapturedConversationPublication(input: {
  revision: WorkspaceRevision
  writeStatus: string
  readOnlyReason?: string | null
  sandbox: ConversationSandboxBinding | null
}):
  | { publish: true }
  | { publish: false; reason: ChatPublishBlock | "stale_connection" } {
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

export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Why nothing was published (nothing reached GitHub). */
export type SessionPublishSkip =
  | ChatPublishBlock
  | "missing_conversation"
  | "missing_workspace"
  | "read_only"
  | "not_github"
  | "missing_sandbox"
  | "stale_connection"
  /** The Workspace was relinked or lost write access meanwhile. */
  | "stale_binding"
  /** The session branch name would reach the default branch. */
  | "default_branch"
  /** The sandbox is on a branch that is not this conversation's. */
  | "other_branch"
  /** An option-D update is unfinished or a rebase is in progress. */
  | "rebase_in_progress"
  /** Only uncommitted files changed; a push publishes commits. */
  | "nothing_committed"
  /** The session branch is not on GitHub. */
  | "no_changes"
  /** The commits add or change `generated_by` or `sources` front matter. */
  | "host_only_field"
  /** The commits change a file outside the Workspace root folder. */
  | "outside_root"
  /** The commits change `.ctxpipe/workspace.yaml`; only an upgrade pull request does. */
  | "format_file"
  /** The commits change `sources/` on a Workspace below format 2. */
  | "upgrade_needed"
  /** The commits write a path of main-era knowledge that is not in git. */
  | "legacy_knowledge"

/** A publish that was attempted and did not reach GitHub. */
export type SessionPublishFailure =
  /** The session branch has commits ctxpipe did not push; fetch and rebase. */
  | "session_moved"
  /** No write credential for the Workspace repository. */
  | "no_write_access"
  /** Git or GitHub failed the commit or the transfer. */
  | "push_failed"

export type SessionPushResult =
  | {
      status: "pushed"
      branch: string
      sha: string
      /** The number of files that the pushed commits changed. */
      files: number
      treeUrl: string
    }
  | { status: "unchanged" }
  | { status: "skipped"; reason: SessionPublishSkip }
  | { status: "failed"; reason: SessionPublishFailure }

/** Everything a publish needs, resolved once per request. */
export type PublishTarget = {
  orgId: string
  conversationId: string
  workspaceId: string
  revision: WorkspaceRevision
  repositoryName: string
  connectionId: string
  branch: string
  /** The tip ctxpipe last pushed; only that tip may be replaced. */
  pushedSha: string | null
  /** A default-branch commit the sandbox builds on and GitHub has. */
  baseSha: string
}

/**
 * The conversation is in the Workspace, the Workspace accepts edits and is on
 * GitHub, and the sandbox is on the Workspace's current commit:
 * - `required`: a push from a sandbox (agent tool, Commit+Push);
 * - `if-live`: Create PR, which works without a sandbox;
 * - `ignore`: the push before a deletion, from a sandbox that may predate the
 *   current commit.
 */
export async function resolvePublishTarget(input: {
  orgId: string
  conversationId: string
  workspaceId: string
  sandbox: "required" | "if-live" | "ignore"
}): Promise<
  | { ok: true; target: PublishTarget }
  | { ok: false; reason: SessionPublishSkip }
> {
  const conversation = await getConversationSession(
    input.orgId,
    input.conversationId,
  )
  if (!conversation || conversation.workspaceId !== input.workspaceId)
    return { ok: false, reason: "missing_conversation" }
  const admission = await getWorkspaceWriteAdmission(input.workspaceId)
  if (!admission) return { ok: false, reason: "missing_workspace" }
  if (
    !workspaceAllowsConversationEdits(
      admission.writeStatus,
      admission.readOnlyReason,
    )
  )
    return { ok: false, reason: "read_only" }
  const revision = { ...admission.revision, access: "publish-session" as const }
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(revision.remote.url)
  const connectionId = revision.remote.connectionId
  if (!repositoryName || !connectionId)
    return { ok: false, reason: "not_github" }
  if (input.sandbox !== "ignore") {
    const sandbox = await getConversationSandboxBinding(
      input.conversationId,
      revision,
    )
    if (!sandbox && input.sandbox === "required")
      return { ok: false, reason: "missing_sandbox" }
    if (sandbox) {
      // A sandbox left on an older commit (a conflicted update) waits for the
      // agent to rebase it before anything is published.
      const planned = planCapturedConversationPublication({
        revision,
        writeStatus: admission.writeStatus,
        readOnlyReason: admission.readOnlyReason,
        sandbox,
      })
      if (!planned.publish) return { ok: false, reason: planned.reason }
    }
  }
  return {
    ok: true,
    target: {
      orgId: input.orgId,
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      revision,
      repositoryName,
      connectionId,
      branch: conversationSessionBranch(
        input.conversationId,
        conversation.lastBranch,
      ),
      pushedSha: conversation.lastPushedSha,
      baseSha: revision.sha,
    },
  }
}

/** Re-checked right before a push: nothing relinked the Workspace meanwhile. */
async function assertStillBound(target: PublishTarget): Promise<void> {
  const conversation = await getConversationSession(
    target.orgId,
    target.conversationId,
  )
  const current = await getWorkspaceWriteAdmission(target.workspaceId)
  if (
    conversation?.workspaceId !== target.workspaceId ||
    !current ||
    !sameWorkspaceRevision(current.revision, {
      ...target.revision,
      access: current.revision.access,
    }) ||
    !workspaceAllowsConversationEdits(
      current.writeStatus,
      current.readOnlyReason,
    )
  )
    throw new PublishRefused("stale_binding")
}

class PublishRefused extends Error {
  constructor(readonly reason: SessionPublishSkip) {
    super(`Conversation publish refused: ${reason}`)
  }
}

type SandboxSessionState =
  | { blocked: true }
  | { blocked: false; branch: string; dirty: boolean; unpushed: boolean }

/**
 * Local only, no network: the sandbox's branch, whether its files changed,
 * and whether it has commits GitHub lacks (the same test the Files status
 * uses). An unfinished option-D update or a rebase in progress blocks; a
 * completed update's marker does not.
 */
async function readSandboxSessionState(
  handle: JobSandboxHandle,
): Promise<SandboxSessionState> {
  const result = await handle.exec(
    `B=$(git branch --show-current)
T=$(git rev-parse --git-path ctxpipe-revision-transition)
if [ -z "$B" ] || [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ] || { [ -f "$T" ] && [ "$(sed -n 5p "$T")" != complete ]; } || [ -n "$(git diff --name-only --diff-filter=U)" ]; then echo blocked; exit 0; fi
printf 'branch %s\\n' "$B"
[ -z "$(git status --porcelain --untracked-files=all)" ] || echo dirty
[ -z "$(${UNPUSHED_COMMITS_COMMAND})" ] || echo unpushed`,
    { env: {} },
  )
  const lines = result.stdout.split("\n")
  const branch = lines.find((line) => line.startsWith("branch "))?.slice(7)
  if (result.exitCode !== 0 || lines.includes("blocked") || !branch)
    return { blocked: true }
  return {
    blocked: false,
    branch,
    dirty: lines.includes("dirty"),
    unpushed: lines.includes("unpushed"),
  }
}

/**
 * Push the sandbox's commits to the conversation's session branch. The
 * sandbox only hands over Git objects; this process holds the read and write
 * tokens. Used by the agent's push tool, Commit+Push (`commit`: uncommitted
 * files are committed first), Create PR and the push before a deletion. A
 * sandbox on the default branch first moves to the session branch.
 *
 * A clean sandbox with nothing unpushed does no network or database work.
 * The remote tip is replaced only when it is the tip ctxpipe pushed last (its
 * own history, rebased onto a moved default); anything else on the branch
 * that HEAD lacks answers `session_moved`. `dirty`: uncommitted files remain.
 */
export async function pushConversationSession(input: {
  handle: JobSandboxHandle
  orgId: string
  conversationId: string
  workspaceId: string
  env: Env
  commit?: { subject: string }
  /** Resolved by a caller that already checked it. */
  target?: PublishTarget
}): Promise<SessionPushResult & { dirty?: boolean }> {
  let dirty: boolean | undefined
  try {
    const state = await readSandboxSessionState(input.handle)
    if (state.blocked)
      return { status: "skipped", reason: "rebase_in_progress" }
    const committing = state.dirty && Boolean(input.commit)
    dirty = state.dirty
    if (!committing && !state.unpushed)
      return state.dirty
        ? { status: "skipped", reason: "nothing_committed", dirty }
        : { status: "unchanged", dirty }
    const resolved = input.target
      ? ({ ok: true, target: input.target } as const)
      : await resolvePublishTarget({ ...input, sandbox: "required" })
    if (!resolved.ok)
      return { status: "skipped", reason: resolved.reason, dirty }
    const { target } = resolved
    if (
      !(await switchToSessionBranch({
        handle: input.handle,
        branch: target.branch,
        defaultBranch: target.revision.defaultBranch,
      }))
    )
      throw new Error("Cannot check out the session branch")
    // The switch leaves any branch but the default where it is.
    if (
      state.branch !== target.revision.defaultBranch &&
      state.branch !== target.branch
    )
      return { status: "skipped", reason: "other_branch", dirty }
    if (committing && input.commit) {
      const committed = await input.handle.exec(
        `git add -A && git commit -q -m ${shellSingleQuote(input.commit.subject)}`,
        { env: COMMIT_IDENTITY },
      )
      if (committed.exitCode !== 0)
        throw new Error(
          `Cannot commit the conversation files: ${committed.stderr}`,
        )
      dirty = false
    }
    return {
      ...(await brokerPush({
        handle: input.handle,
        env: input.env,
        target,
      })),
      dirty,
    }
  } catch (error) {
    if (error instanceof PublishRefused) {
      // The event holds no path and no file text, because those come from
      // the agent.
      log.info({
        step: "conversation-session-push-refused",
        reason: error.reason,
        conversationId: input.conversationId,
      })
      return { status: "skipped", reason: error.reason, dirty }
    }
    log.warn({
      step: "conversation-session-push",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      conversationId: input.conversationId,
    })
    return { status: "failed", reason: "push_failed", dirty }
  }
}

/**
 * The thread shows each push of the conversation's commits after the last
 * user turn. The commits are already on GitHub, so a failure to record the
 * push is logged and the push succeeds.
 */
export async function recordConversationPush(input: {
  orgId: string
  conversationId: string
  pushed: Extract<SessionPushResult, { status: "pushed" }>
  trigger: ConversationPushTrigger
  pullRequest?: ConversationSync["pullRequest"]
}): Promise<void> {
  const { pushed } = input
  try {
    // The sweep does not hold off a delete: a deleted conversation gets no
    // entry that nothing would delete.
    if (!(await getConversationSession(input.orgId, input.conversationId)))
      return
    const thread = await workspaceChatPersistence().stores.messages.loadThread(
      input.conversationId,
    )
    await saveConversationSync({
      orgId: input.orgId,
      conversationId: input.conversationId,
      sync: {
        trigger: input.trigger,
        ...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
        branch: pushed.branch,
        sha: pushed.sha,
        files: pushed.files,
        treeUrl: pushed.treeUrl,
        turn: thread.filter((message) => message.role === "user").length,
        syncedAt: new Date().toISOString(),
      },
    })
  } catch (error) {
    log.warn({
      step: "conversation-sync-record",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      conversationId: input.conversationId,
    })
  }
}

async function brokerPush(input: {
  handle: JobSandboxHandle
  env: Env
  target: PublishTarget
}): Promise<SessionPushResult> {
  const { handle, target } = input
  const { revision, branch } = target
  const run = (command: string) => handle.exec(command, { env: {} })
  const agentPack = `.git/ctxpipe-publish-${randomUUID()}.pack`
  let readToken: string | undefined
  let writeToken: string | undefined
  try {
    readToken = await resolveRepositoryReadCredential({
      orgId: target.orgId,
      env: input.env,
      remote: revision.remote,
    })
    const head = await run("git rev-parse HEAD")
    if (head.exitCode !== 0)
      throw new Error("Cannot capture the conversation commit")
    const sha = gitObjectIdSchema.parse(head.stdout.trim())
    const remote = (
      await resolveGitRemoteTip({
        url: revision.remote.url,
        branch,
        token: readToken,
      })
    )?.sha
    if (remote === sha) {
      await recordConversationSessionPush({ ...target, sha })
      return { status: "unchanged" }
    }
    const fastForward =
      remote !== undefined &&
      (
        await run(
          `git merge-base --is-ancestor ${shellSingleQuote(remote)} ${shellSingleQuote(sha)}`,
        )
      ).exitCode === 0
    // Replacing the remote tip is only for the tip ctxpipe pushed itself, after
    // an option-D rebase. Anything else the agent must fetch and rebase onto.
    if (remote && !fastForward && remote !== target.pushedSha)
      return { status: "failed", reason: "session_moved" }
    // Never replace the session's commits with a branch that has none.
    if (
      remote &&
      !fastForward &&
      (
        await run(
          `git merge-base --is-ancestor ${shellSingleQuote(sha)} ${shellSingleQuote(target.baseSha)}`,
        )
      ).exitCode === 0
    )
      return { status: "skipped", reason: "no_changes" }
    // The commit the broker fetches from GitHub to apply the sandbox's delta:
    // the remote tip it builds on, else the default commit it builds on.
    const packBase = fastForward && remote ? remote : target.baseSha
    const packed = await run(
      `printf '%s\\n' ${shellSingleQuote(sha)} ${shellSingleQuote(`^${packBase}`)} | git pack-objects --stdout --revs --thin > ${shellSingleQuote(agentPack)}`,
    )
    if (packed.exitCode !== 0)
      throw new Error("Cannot capture the conversation Git delta")
    const changed = await run(
      `git diff --no-ext-diff --name-only -z -M ${shellSingleQuote(packBase)} ${shellSingleQuote(sha)}`,
    )
    if (changed.exitCode !== 0)
      throw new Error("Cannot count the conversation's changed files")
    const files = changed.stdout.split("\0").filter(Boolean).length
    const size = await run(`wc -c < ${shellSingleQuote(agentPack)}`)
    const packBytes = Number(size.stdout.trim())
    if (
      size.exitCode !== 0 ||
      !Number.isSafeInteger(packBytes) ||
      packBytes <= 0
    )
      throw new Error("Invalid conversation Git pack size")
    // The sandbox reports the size. The copy below reads that many bytes into
    // this process, so a larger pack is refused before any copy.
    if (packBytes > 100 * 1024 * 1024)
      throw new Error("The conversation Git pack is larger than 100 MB")
    writeToken = await getRepoWriteCloneToken(target.orgId, input.env, {
      githubConnectionId: target.connectionId,
      repoFullName: target.repositoryName,
    })
    if (!writeToken) return { status: "failed", reason: "no_write_access" }
    const token = writeToken
    await withGitDirectory(
      sha,
      async (directory) => {
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
            const chunk = await run(
              `dd if=${shellSingleQuote(agentPack)} bs=${chunkBytes} skip=${offset / chunkBytes} count=1 2>/dev/null | base64`,
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
        // The check reads the broker's own copy of the objects, not the
        // sandbox, because the agent controls the sandbox. A change to a
        // host-only path such as `.ctxpipe/` is allowed: the push reaches only
        // the session branch, so the change reaches the default branch only
        // through a pull request that a person merges. The format file is the
        // exception: only an upgrade pull request changes it.
        if (await addsOwnershipField(directory, packBase, sha))
          throw new PublishRefused("host_only_field")
        // The agent may change files only below the Workspace root folder.
        const rootPath = workspaceRootPath(revision)
        const changedPaths = await changedWorkspacePaths(
          directory,
          packBase,
          sha,
          rootPath,
        )
        const refusal = await formatRefusal(
          directory,
          packBase,
          rootPath,
          changedPaths,
        )
        if (refusal) throw new PublishRefused(refusal)
        // Main-era knowledge that hydrate serves from Postgres is read-only.
        if (await writesLegacyKnowledge(target.workspaceId, changedPaths))
          throw new PublishRefused("legacy_knowledge")
        if (
          rootPath &&
          (
            await gitChangesOutsideWorkspaceRoot({
              directory,
              base: packBase,
              head: sha,
              rootPath,
            })
          ).length
        )
          throw new PublishRefused("outside_root")
        // The write token only ever reaches this conversation's session branch,
        // never a branch that is (or became) the default.
        const latestDefault = await resolveGitRemoteTip({
          url: revision.remote.url,
          token,
        })
        if (
          !isChatSessionBranch(branch) ||
          !mayForcePushBranch(branch, revision.defaultBranch) ||
          latestDefault?.branch !== revision.defaultBranch ||
          latestDefault.branch === branch
        )
          throw new PublishRefused("default_branch")
        await assertStillBound(target)
        await nativeGit(
          directory,
          [
            "push",
            "--porcelain",
            `--force-with-lease=refs/heads/${branch}:${remote ?? ""}`,
            "--",
            revision.remote.url,
            `${sha}:refs/heads/${branch}`,
          ],
          undefined,
          gitRemoteEnvironment({ url: revision.remote.url, token }),
        )
      },
      undefined,
      null,
    )
    await run(
      `git update-ref ${shellSingleQuote(`refs/remotes/origin/${branch}`)} ${shellSingleQuote(sha)}`,
    )
    await recordConversationSessionPush({ ...target, sha })
    return {
      status: "pushed",
      branch,
      sha,
      files,
      treeUrl: conversationGithubTreeUrl({
        repositoryName: target.repositoryName,
        branch,
      }),
    }
  } catch (error) {
    if (error instanceof PublishRefused) throw error
    throw new Error(sanitizeCredentials(error, [readToken, writeToken]))
  } finally {
    await run(`rm -f -- ${shellSingleQuote(agentPack)}`)
  }
}

/**
 * True when a change from `base` to `sha` gives a file an ownership field
 * that it did not have (CTX-722). Only the host sets these fields, because
 * they give a file to ingestion. The check reads the net change from `base`
 * to `sha`, and each commit between them against its first parent, because
 * the history keeps a change that a later commit removes. A commit with no
 * parent is compared with the empty tree. A rename compares the file with its
 * old version, so an agent can move a generated file. The old version of a
 * file that is not Markdown has no ownership fields, so a rename to Markdown
 * cannot bring them in.
 */
async function addsOwnershipField(
  directory: string,
  base: string,
  sha: string,
): Promise<boolean> {
  const emptyTree = async () =>
    (await nativeGit(directory, ["hash-object", "-t", "tree", "--stdin"], ""))
      .toString("utf8")
      .trim()
  const pairs: Array<[string, string]> = [[base, sha]]
  const commits = (
    await nativeGit(directory, ["rev-list", "--parents", `${base}..${sha}`])
  )
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
  for (const line of commits) {
    const [commit = "", parent] = line.split(" ")
    pairs.push([parent ?? (await emptyTree()), commit])
  }
  const blob = async (commit: string, path: string) =>
    (
      await nativeGit(directory, ["cat-file", "blob", `${commit}:${path}`])
    ).toString("utf8")
  const isMarkdown = (path: string) => /\.md$/i.test(path)
  for (const [from, to] of pairs) {
    const changes = parseNameStatus(
      await nativeGit(directory, [
        "diff-tree",
        "-r",
        "-z",
        "-M",
        "--name-status",
        from,
        to,
      ]),
    )
    for (const change of changes) {
      if (change.status.startsWith("D") || !isMarkdown(change.to)) continue
      const before =
        change.status.startsWith("A") || !isMarkdown(change.from)
          ? null
          : await blob(from, change.from)
      if (addedOwnershipField(before, await blob(to, change.to))) return true
    }
  }
  return false
}

/**
 * The paths (relative to the Workspace root) that the change from `base` to
 * `sha` adds, changes or deletes, in the broker's copy.
 */
async function changedWorkspacePaths(
  directory: string,
  base: string,
  sha: string,
  rootPath: string,
): Promise<string[]> {
  return (
    await nativeGit(directory, [
      "diff-tree",
      "-r",
      "-z",
      "--no-renames",
      "--name-only",
      base,
      sha,
    ])
  )
    .toString("utf8")
    .split("\0")
    .flatMap((path) => {
      const relative = path ? workspaceRelativePath(rootPath, path) : null
      return relative === null ? [] : [relative]
    })
}

/**
 * The refusal of a change that the Workspace format does not allow, or null.
 * The commits must not change the format file. Below format 2, they must not
 * change `sources/`, because the Workspace still reads `.ctxpipe/sources.yaml`.
 * The format comes from the format file at `base`, in the broker's copy.
 */
async function formatRefusal(
  directory: string,
  base: string,
  rootPath: string,
  changed: readonly string[],
): Promise<"format_file" | "upgrade_needed" | null> {
  if (changed.includes(WORKSPACE_FORMAT_PATH)) return "format_file"
  if (!changed.some((path) => path.startsWith(`${SOURCE_FILES_FOLDER}/`)))
    return null
  const formatPath = workspaceRepositoryPath(rootPath, WORKSPACE_FORMAT_PATH)
  const text = (
    await nativeGit(directory, [
      "ls-tree",
      "--name-only",
      base,
      "--",
      formatPath,
    ])
  )
    .toString("utf8")
    .trim()
    ? (
        await nativeGit(directory, [
          "cat-file",
          "blob",
          `${base}:${formatPath}`,
        ])
      ).toString("utf8")
    : null
  const format = readWorkspaceFormat(text)
  return workspaceFormatAtLeast(
    format.kind === "format" ? format.format : null,
    SOURCE_FILES_FORMAT,
  )
    ? null
    : "upgrade_needed"
}

function sanitizeCredentials(
  error: unknown,
  credentials: Array<string | undefined>,
): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const credential of credentials)
    if (credential) message = sanitizeGitRemoteError(message, credential)
  return message
}

/** Create PR without a sandbox: whether the session branch is on GitHub. */
export async function sessionBranchOnGithub(
  target: PublishTarget,
  env: Env,
): Promise<boolean> {
  const readToken = await resolveRepositoryReadCredential({
    orgId: target.orgId,
    env,
    remote: target.revision.remote,
  })
  return Boolean(
    await resolveGitRemoteTip({
      url: target.revision.remote.url,
      branch: target.branch,
      token: readToken,
    }),
  )
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

/** The conversation in the app, at the public origin `AUTH_BASE_URL`. */
async function conversationAppUrl(
  target: PublishTarget,
  env: Env,
): Promise<string | null> {
  const [orgSlug, workspace] = await Promise.all([
    getOrganizationSlugByOrgId(target.orgId),
    getWorkspaceById(target.workspaceId, target.orgId),
  ])
  if (!orgSlug || !workspace?.slug) return null
  const origin = env.AUTH_BASE_URL.replace(/\/+$/, "")
  return `${origin}/${orgSlug}/ws/${workspace.slug}/${target.conversationId}`
}

/**
 * The title and body of a new pull request from the session branch: what the
 * branch adds to the default branch on GitHub, and a link to the
 * conversation. A failed compare gives a shorter body, so the pull request
 * still opens.
 */
export async function describeSessionPullRequest(input: {
  target: PublishTarget
  env: Env
  name: string | null | undefined
}): Promise<{ title: string; body: string }> {
  const { target, env } = input
  const changes = await compareBranchChanges({
    orgId: target.orgId,
    repositoryName: target.repositoryName,
    env,
    githubConnectionId: target.connectionId,
    base: target.revision.defaultBranch,
    head: target.branch,
  }).catch((error: unknown): BranchChanges => {
    log.warn({
      step: "conversation-pull-request-compare",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      conversationId: target.conversationId,
    })
    return { commits: [], files: [] }
  })
  const conversationUrl = await conversationAppUrl(target, env)
  return {
    title: pullRequestTitle(input.name, changes),
    body: pullRequestBody({ changes, conversationUrl }),
  }
}
