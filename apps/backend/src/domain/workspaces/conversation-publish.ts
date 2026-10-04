import { randomUUID } from "node:crypto"
import { open } from "node:fs/promises"
import { join } from "node:path"
import type { Env } from "../../config/env.js"
import {
  getConversationSession,
  recordConversationSessionPush,
} from "../../models/conversations.js"
import { getRepoWriteCloneToken } from "../../models/github-installation.js"
import { getWorkspaceWriteAdmission } from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import {
  gitRemoteEnvironment,
  resolveGitRemoteTip,
} from "../../services/git/clone-tree.js"
import { nativeGit, withGitDirectory } from "../../services/git/pack.js"
import {
  conversationSessionBranch,
  isChatSessionBranch,
  mayForcePushBranch,
  planChatPullRequest,
} from "./chat-lifecycle.js"
import { workspaceAllowsConversationEdits } from "./chat-sandbox-policy.js"
import {
  ensureConversationSessionBranch,
  getConversationSandboxBinding,
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
}): ReturnType<typeof planChatPullRequest> {
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

/** Same read credential the sandbox setup uses; it can never push. */
const SANDBOX_READ_CREDENTIAL = `-c credential.helper='!f() { echo username=x-access-token; echo password=\${CTXPIPE_CLONE_TOKEN}; }; f'`

const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: "ctxpipe",
  GIT_AUTHOR_EMAIL: "workspace-chat@ctxpipe.local",
  GIT_COMMITTER_NAME: "ctxpipe",
  GIT_COMMITTER_EMAIL: "workspace-chat@ctxpipe.local",
}

/**
 * Why nothing was published. Preflight reasons mirror the planner's
 * (`stale_*`, `read_only`, ...); the rest are named here.
 */
export type SessionPublishSkip = string

/** A publish that was attempted and did not reach GitHub. */
export type SessionPublishFailure =
  /** The session branch has commits that do not rebase cleanly under ours. */
  | "session_moved"
  /** No write credential for the Workspace repository. */
  | "no_write_access"
  /** GitHub or Git refused or failed the transfer. */
  | "push_failed"

export type SessionPushResult =
  | { status: "pushed"; branch: string; sha: string }
  | { status: "unchanged" }
  | { status: "skipped"; reason: SessionPublishSkip }
  | { status: "failed"; reason: SessionPublishFailure }

type PublishTarget = {
  revision: WorkspaceRevision
  repositoryName: string
  connectionId: string
  branch: string
  /** The tip ctx| last pushed; only that tip may be replaced. */
  pushedSha: string | null
}

/**
 * Everything a publish needs before touching Git: the conversation is in the
 * Workspace, the Workspace accepts edits and is on GitHub, and (with a
 * sandbox) the sandbox is on the Workspace's current commit.
 */
async function publishTarget(input: {
  orgId: string
  conversationId: string
  workspaceId: string
  /** `required`: a turn's push; `if-live`: Create PR, which needs no sandbox. */
  sandboxBinding: "required" | "if-live"
  /** Create PR publishes the revision it started with, or nothing. */
  expected?: WorkspaceRevision
}): Promise<
  { ok: true; target: PublishTarget } | { ok: false; reason: string }
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
  if (input.expected && !sameWorkspaceRevision(revision, input.expected))
    return { ok: false, reason: "stale_binding" }
  const sandbox = await getConversationSandboxBinding(
    input.conversationId,
    revision,
  )
  if (!sandbox && input.sandboxBinding === "required")
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
  const branch = conversationSessionBranch(
    input.conversationId,
    conversation.lastBranch,
  )
  if (!mayForcePushBranch(branch, revision.defaultBranch))
    return { ok: false, reason: "default_branch" }
  return {
    ok: true,
    target: {
      revision,
      repositoryName,
      connectionId,
      branch,
      pushedSha: conversation.lastPushedSha,
    },
  }
}

/**
 * Create PR's first check: the Workspace accepts edits on GitHub and a live
 * sandbox (if any) is on its current commit. Returns the revision the rest of
 * Create PR must still find.
 */
export async function conversationPublishPreflight(input: {
  orgId: string
  conversationId: string
  workspaceId: string
}): Promise<
  { ok: true; revision: WorkspaceRevision } | { ok: false; reason: string }
> {
  const planned = await publishTarget({ ...input, sandboxBinding: "if-live" })
  return planned.ok ? { ok: true, revision: planned.target.revision } : planned
}

/** Re-checked right before a push: nothing relinked the Workspace meanwhile. */
async function assertStillBound(input: {
  orgId: string
  conversationId: string
  workspaceId: string
  revision: WorkspaceRevision
}): Promise<void> {
  const conversation = await getConversationSession(
    input.orgId,
    input.conversationId,
  )
  const current = await getWorkspaceWriteAdmission(input.workspaceId)
  if (
    conversation?.workspaceId !== input.workspaceId ||
    !current ||
    !sameWorkspaceRevision(current.revision, {
      ...input.revision,
      access: current.revision.access,
    }) ||
    !workspaceAllowsConversationEdits(
      current.writeStatus,
      current.readOnlyReason,
    )
  )
    throw new BindingChanged()
}

class BindingChanged extends Error {
  constructor() {
    super("Conversation write binding changed before push")
  }
}

type SandboxSessionState =
  | { blocked: true }
  | { blocked: false; branch: string; dirty: boolean; unpushed: boolean }

/**
 * Local only, no network: the sandbox's branch, whether its files changed,
 * and whether HEAD has commits no remote-tracking ref knows. A rebase in
 * progress (a conflicted option-D update the agent is repairing) blocks;
 * a completed update's marker does not.
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
[ -z "$(git rev-list -n 1 HEAD --not --remotes)" ] || echo unpushed`,
    { env: {} },
  )
  if (result.exitCode !== 0)
    throw new Error("Cannot read the sandbox Git state")
  const lines = result.stdout.split("\n")
  if (lines.includes("blocked")) return { blocked: true }
  const branch = lines.find((line) => line.startsWith("branch "))?.slice(7)
  if (!branch) return { blocked: true }
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
 * tokens. The agent pushes through its workspace tool when it decides to;
 * people push with Commit+Push (`commit`: uncommitted files are committed
 * first); Create PR and the 30-day deletion push what is committed.
 *
 * A clean sandbox whose HEAD every remote-tracking ref already covers does no
 * network or database work. The remote tip is replaced only when it is the
 * tip ctx| last pushed (its own history, rebased onto a moved default);
 * commits someone else pushed are fetched and the sandbox's work is rebased
 * onto them instead.
 */
export async function pushConversationSession(input: {
  handle: JobSandboxHandle
  conversationId: string
  orgId: string
  workspaceId: string
  env: Env
  /** Commit+Push: commit uncommitted files with this subject first. */
  commit?: { subject: string }
  /** `if-live`: the deletion's last push, from a sandbox no longer current. */
  sandboxBinding?: "required" | "if-live"
}): Promise<SessionPushResult> {
  const state = await readSandboxSessionState(input.handle)
  if (state.blocked) return { status: "skipped", reason: "rebase_in_progress" }
  const committing = state.dirty && Boolean(input.commit)
  if (!committing && !state.unpushed)
    return state.dirty
      ? { status: "skipped", reason: "nothing_committed" }
      : { status: "unchanged" }
  const planned = await publishTarget({
    ...input,
    sandboxBinding: input.sandboxBinding ?? "required",
  })
  if (!planned.ok) return { status: "skipped", reason: planned.reason }
  const { target } = planned
  if (state.branch === target.revision.defaultBranch)
    await ensureConversationSessionBranch({
      handle: input.handle,
      branch: target.branch,
      defaultBranch: target.revision.defaultBranch,
    })
  else if (state.branch !== target.branch)
    return { status: "skipped", reason: "other_branch" }
  if (committing && input.commit) {
    const committed = await input.handle.exec(
      `git add -A && git commit -q -m ${shellSingleQuote(input.commit.subject)}`,
      { env: COMMIT_IDENTITY },
    )
    if (committed.exitCode !== 0)
      throw new Error(
        committed.stderr || "Cannot commit the conversation files",
      )
  }
  return brokerPush({ ...input, target })
}

async function brokerPush(input: {
  handle: JobSandboxHandle
  conversationId: string
  orgId: string
  workspaceId: string
  env: Env
  target: PublishTarget
}): Promise<SessionPushResult> {
  const { handle, target } = input
  const { revision, branch } = target
  const run = (command: string) => handle.exec(command, { env: {} })
  const head = async () => {
    const result = await run("git rev-parse HEAD")
    if (result.exitCode !== 0)
      throw new Error("Cannot capture the conversation commit")
    return gitObjectIdSchema.parse(result.stdout.trim())
  }
  const isAncestor = async (ancestor: string, of: string) =>
    (
      await run(
        `git merge-base --is-ancestor ${shellSingleQuote(ancestor)} ${shellSingleQuote(of)}`,
      )
    ).exitCode === 0
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
      defaultTip.branch === branch ||
      !isChatSessionBranch(branch)
    )
      return { status: "skipped", reason: "default_branch" }
    let sha = await head()
    if (sha === revision.sha || sha === defaultTip.sha) {
      // Nothing of the session's own: remember the commit so the next clean
      // turn stays local.
      await run(
        `git update-ref refs/remotes/ctxpipe/default ${shellSingleQuote(sha)}`,
      )
      return { status: "unchanged" }
    }
    const remote = (
      await resolveGitRemoteTip({
        url: revision.remote.url,
        branch,
        token: readToken,
      })
    )?.sha
    const tracking = (
      await run(
        `git rev-parse -q --verify ${shellSingleQuote(`refs/remotes/origin/${branch}`)}`,
      )
    ).stdout.trim()
    if (remote && (remote !== tracking || remote !== target.pushedSha)) {
      // The branch moved without this sandbox (a push on GitHub, or from an
      // earlier sandbox of this conversation): build on it, never over it. Only a remote tip that
      // ctx| pushed itself is replaced, after an option-D rebase.
      if (!(await adoptRemoteSessionTip(handle, branch, target.pushedSha)))
        return { status: "failed", reason: "session_moved" }
      sha = await head()
    }
    if (remote && sha === remote) {
      await recordConversationSessionPush({
        orgId: input.orgId,
        conversationId: input.conversationId,
        branch,
        sha,
      })
      return { status: "unchanged" }
    }
    const fastForward = !remote || (await isAncestor(remote, sha))
    // The commit the broker fetches from GitHub to apply the sandbox's delta:
    // the session tip, the Workspace's commit, or (for an older sandbox) the
    // default-branch commit it was created on.
    const localDefault = (
      await run(
        `git merge-base HEAD ${shellSingleQuote(`refs/heads/${revision.defaultBranch}`)}`,
      )
    ).stdout.trim()
    const packBase =
      remote && fastForward
        ? remote
        : (await isAncestor(revision.sha, sha))
          ? revision.sha
          : /^[0-9a-f]{40,64}$/.test(localDefault)
            ? localDefault
            : undefined
    if (!packBase) return { status: "failed", reason: "session_moved" }
    const packed = await run(
      `printf '%s\\n' ${shellSingleQuote(sha)} ${shellSingleQuote(`^${packBase}`)} | git pack-objects --stdout --revs --thin > ${shellSingleQuote(agentPack)}`,
    )
    if (packed.exitCode !== 0)
      throw new Error("Cannot capture the conversation Git delta")
    const size = await run(`wc -c < ${shellSingleQuote(agentPack)}`)
    const packBytes = Number(size.stdout.trim())
    if (
      size.exitCode !== 0 ||
      !Number.isSafeInteger(packBytes) ||
      packBytes <= 0
    )
      throw new Error("Invalid conversation Git pack size")
    writeToken = await getRepoWriteCloneToken(input.orgId, input.env, {
      githubConnectionId: target.connectionId,
      repoFullName: target.repositoryName,
    })
    if (!writeToken) return { status: "failed", reason: "no_write_access" }
    const token = writeToken
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
      // The write token must never reach a branch that became the default.
      const latestDefault = await resolveGitRemoteTip({
        url: revision.remote.url,
        token,
      })
      if (
        latestDefault?.branch !== revision.defaultBranch ||
        latestDefault.branch === branch
      )
        throw new BindingChanged()
      await assertStillBound({ ...input, revision })
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
    })
    await run(
      `git update-ref ${shellSingleQuote(`refs/remotes/origin/${branch}`)} ${shellSingleQuote(sha)}`,
    )
    await recordConversationSessionPush({
      orgId: input.orgId,
      conversationId: input.conversationId,
      branch,
      sha,
    })
    return { status: "pushed", branch, sha }
  } catch (error) {
    if (error instanceof BindingChanged)
      return { status: "skipped", reason: "stale_binding" }
    log.warn({
      step: "conversation-session-push",
      message: sanitizeCredentials(error, [readToken, writeToken]),
      conversationId: input.conversationId,
    })
    return { status: "failed", reason: "push_failed" }
  } finally {
    await run(`rm -f -- ${shellSingleQuote(agentPack)}`)
  }
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

/**
 * Move the sandbox onto the session branch's remote tip, keeping the commits
 * it has not pushed: they are rebased onto that tip. The sandbox fetches with
 * its own read credential. False when they do not apply cleanly.
 */
async function adoptRemoteSessionTip(
  handle: JobSandboxHandle,
  branch: string,
  /** The tip ctx| last pushed: the sandbox's work since then is replayed. */
  pushedSha: string | null,
): Promise<boolean> {
  const result = await handle.exec(
    `set -u
OLD=
for C in "$PUSHED" "$(git rev-parse -q --verify "refs/remotes/origin/$SESSION" || true)"; do
  if [ -n "$C" ] && git cat-file -e "$C^{commit}" 2>/dev/null && git merge-base --is-ancestor "$C" HEAD; then OLD=$C; break; fi
done
git ${SANDBOX_READ_CREDENTIAL} fetch -q --depth 1 origin "+refs/heads/$SESSION:refs/remotes/origin/$SESSION" || exit 42
NEW=$(git rev-parse "refs/remotes/origin/$SESSION")
if [ -n "$OLD" ]; then
  git rebase -q --onto "$NEW" "$OLD" || { git rebase --abort; exit 42; }
elif [ "$(git rev-parse 'HEAD^{tree}')" = "$(git rev-parse "$NEW^{tree}")" ]; then
  git reset -q --soft "$NEW"
else
  exit 42
fi`,
    { env: { ...COMMIT_IDENTITY, SESSION: branch, PUSHED: pushedSha ?? "" } },
  )
  return result.exitCode === 0
}

/**
 * Create PR: the session branch as it is on GitHub (the agent's commits are
 * kept). Checks the revision Create PR started with is still the Workspace's.
 */
export async function publishedSessionBranch(input: {
  conversationId: string
  orgId: string
  workspaceId: string
  env: Env
  expected: WorkspaceRevision
}): Promise<
  | { status: "published"; branch: string }
  | { status: "skipped"; reason: SessionPublishSkip }
> {
  const planned = await publishTarget({ ...input, sandboxBinding: "if-live" })
  if (!planned.ok) return { status: "skipped", reason: planned.reason }
  const { revision, branch } = planned.target
  const readToken = await resolveRepositoryReadCredential({
    orgId: input.orgId,
    env: input.env,
    remote: revision.remote,
  })
  const tip = await resolveGitRemoteTip({
    url: revision.remote.url,
    branch,
    token: readToken,
  })
  return tip
    ? { status: "published", branch }
    : { status: "skipped", reason: "no_changes" }
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
