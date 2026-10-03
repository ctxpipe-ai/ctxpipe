import { defineChatMiddleware, type StreamChunk } from "@tanstack/ai"
import { getSandbox, SandboxCapability } from "@tanstack/ai-sandbox"
import { parseEnv } from "../../config/env.js"
import { recordConversationSessionBranch } from "../../models/conversations.js"
import { getWorkspaceWriteAdmission } from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import { splitGitNulPaths } from "./chat-pull-request.js"
import { workspaceAllowsConversationEdits } from "./chat-sandbox-policy.js"
import { generateCommitSubject } from "./commit-subject.js"
import {
  getConversationSandboxBinding,
  isConversationSandboxHarnessPath,
} from "./conversation-files.js"
import {
  planCapturedConversationPublication,
  pushConversationSessionBranch,
} from "./conversation-publish.js"
import { adaptTanstackHandle } from "./job-sandbox.js"
import type { JobSandboxHandle } from "./job-worktree.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

/** CUSTOM turn event: the turn's files reached (or missed) the session branch. */
export const WORKSPACE_CHAT_SESSION_PUSH_EVENT = "session-push"

export type ConversationTurnPush =
  | { status: "pushed"; branch: string }
  | { status: "unchanged" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string }

/**
 * Commit what the turn changed and push it to the conversation's session
 * branch through the broker (`pushConversationSessionBranch`): the sandbox
 * only hands over Git objects and never holds a write credential. Git is the
 * conversation's durable state, so a lost sandbox is rebuilt from this branch.
 *
 * Idempotent: a turn with nothing new pushes nothing. A failed push leaves the
 * commit in the sandbox, and the next turn pushes it with its own changes.
 */
export async function pushConversationTurn(input: {
  handle: JobSandboxHandle
  conversationId: string
  orgId: string
  workspaceId: string
}): Promise<ConversationTurnPush> {
  const admission = await getWorkspaceWriteAdmission(input.workspaceId)
  if (!admission) return { status: "skipped", reason: "missing_workspace" }
  if (
    !workspaceAllowsConversationEdits(
      admission.writeStatus,
      admission.readOnlyReason,
    )
  )
    return { status: "skipped", reason: "read_only" }
  const revision = { ...admission.revision, access: "publish-session" as const }
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(revision.remote.url)
  if (!repositoryName) return { status: "skipped", reason: "not_github" }
  // A sandbox left on an older commit (a conflicted update) waits for the
  // agent to rebase it; publishing would push a branch the next update rewrites.
  const planned = planCapturedConversationPublication({
    revision,
    writeStatus: admission.writeStatus,
    readOnlyReason: admission.readOnlyReason,
    sandbox: await getConversationSandboxBinding(
      input.conversationId,
      revision,
    ),
  })
  if (!planned.publish) return { status: "skipped", reason: planned.reason }
  const git = await input.handle.exec(
    `test -n "$(git branch --show-current)" && test ! -e "$(git rev-parse --git-path ctxpipe-revision-transition)" && test ! -d "$(git rev-parse --git-path rebase-merge)" && test ! -d "$(git rev-parse --git-path rebase-apply)" && git add -A && git diff --cached --name-only -z HEAD`,
    { env: {} },
  )
  if (git.exitCode !== 0)
    return { status: "skipped", reason: "rebase_in_progress" }
  const changed = splitGitNulPaths(git.stdout).filter(
    (path) => !isConversationSandboxHarnessPath(path),
  )
  const subject =
    changed.length > 0
      ? await generateCommitSubject({
          repoName: repositoryName.split("/")[1] ?? repositoryName,
          trigger: "workspace chat",
          fileNames: changed,
        })
      : "ctxpipe - Workspace chat turn"
  const pushed = await pushConversationSessionBranch({
    handle: input.handle,
    conversationId: input.conversationId,
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    revision,
    env: parseEnv(process.env as Record<string, string | undefined>),
    commitMessage: subject,
  })
  if (!pushed.ok)
    return pushed.error === "no_changes"
      ? { status: "unchanged" }
      : { status: "failed", error: pushed.error }
  await recordConversationSessionBranch({
    conversationId: input.conversationId,
    branch: pushed.branch,
  })
  return pushed.pushed
    ? { status: "pushed", branch: pushed.branch }
    : { status: "unchanged" }
}

function sessionPushChunk(
  result: Extract<ConversationTurnPush, { status: "pushed" | "failed" }>,
): StreamChunk {
  return {
    type: "CUSTOM",
    name: WORKSPACE_CHAT_SESSION_PUSH_EVENT,
    value: result,
    timestamp: Date.now(),
  } as StreamChunk
}

/**
 * Push each finished turn before its `RUN_FINISHED` is forwarded: the
 * conversation lock and the sandbox are still held (terminal hooks release
 * them), and a failure reaches the client as a non-fatal `session-push` event.
 */
export function workspaceChatSessionPush(input: {
  conversationId: string
  orgId: string
  workspaceId: string
}) {
  let attempted = false
  return defineChatMiddleware({
    name: "workspace-chat-session-push",
    requires: [SandboxCapability],
    async onChunk(ctx, chunk) {
      if (
        attempted ||
        chunk.type !== "RUN_FINISHED" ||
        chunk.outcome?.type === "interrupt" ||
        chunk.finishReason === "tool_calls" ||
        ctx.signal?.aborted
      )
        return
      attempted = true
      let result: ConversationTurnPush
      try {
        result = await pushConversationTurn({
          conversationId: input.conversationId,
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          handle: adaptTanstackHandle(getSandbox(ctx), ctx.signal),
        })
      } catch (error) {
        result = {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }
      }
      if (result.status === "failed")
        log.warn({
          step: "workspace-chat-session-push",
          message: "Turn changes were not pushed; the next turn retries",
          conversationId: input.conversationId,
          error: result.error,
        })
      if (result.status !== "pushed" && result.status !== "failed") return
      return [sessionPushChunk(result), chunk]
    },
  })
}
