import type { SandboxHandle } from "@tanstack/ai-sandbox"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import {
  getConversationSession,
  rotateConversationSessionBranch,
} from "../../models/conversations.js"
import type { RunningSandboxProvider } from "../../models/workspace-sandboxes.js"
import { log } from "../../observability/logger.js"
import { nextConversationSessionBranch } from "./chat-lifecycle.js"
import { SANDBOX_READ_GIT } from "./chat-runtime.js"
import { UNPUSHED_COMMITS_COMMAND } from "./conversation-files.js"
import {
  type PublishTarget,
  pushConversationSession,
  resolvePublishTarget,
  type SessionPushResult,
} from "./conversation-publish.js"
import { adaptTanstackHandle } from "./job-sandbox.js"
import type { JobSandboxHandle } from "./job-worktree.js"
import { attachProviderSandbox } from "./sandbox-provider.js"
import type { WorkspaceChatTanstackTool } from "./workspace-chat-tools.js"

/** A push gives up after this long, so it never holds the conversation. */
const PUSH_TIMEOUT_MS = 2 * 60_000

function logPush(
  conversationId: string,
  outcome: SessionPushResult | Error,
): void {
  if (outcome instanceof Error)
    log.warn({
      step: "conversation-branch-push",
      message: `Conversation commits were not pushed: ${outcome.message}`,
      conversationId,
    })
  else if (outcome.status === "failed" || outcome.status === "skipped")
    log.info({
      step: "conversation-branch-push",
      message: `Conversation commits were not pushed (${outcome.reason})`,
      conversationId,
      reason: outcome.reason,
    })
}

/**
 * The agent's way to publish its commits: push the conversation's session
 * branch through the broker. The sandbox never holds a write credential, and
 * only the session branch is ever pushed. The agent decides when (a finished
 * task, or the user asked); uncommitted files are not pushed.
 */
export function conversationBranchPushTool(input: {
  conversationId: string
  orgId: string
  orgSlug: string
  workspaceId: string
  /** The run's sandbox, once the run has one. */
  sandbox: () => SandboxHandle | undefined
}): WorkspaceChatTanstackTool {
  return {
    name: "push_conversation_branch",
    description:
      "Publish the commits you made in this conversation to its branch on GitHub, so the user can see them there. Commit with git first; uncommitted files are not published. Never touches the default branch.",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, execution) {
      const sandbox = input.sandbox()
      if (!sandbox) return { pushed: false, reason: "sandbox_not_ready" }
      const handle = adaptTanstackHandle(
        sandbox,
        AbortSignal.any([
          AbortSignal.timeout(PUSH_TIMEOUT_MS),
          ...(execution?.abortSignal ? [execution.abortSignal] : []),
        ]),
      )
      const outcome = await withOrgIdContext(
        { id: input.orgId, slug: input.orgSlug },
        () =>
          pushConversationSession({
            handle,
            conversationId: input.conversationId,
            orgId: input.orgId,
            workspaceId: input.workspaceId,
            env: parseEnv(process.env as Record<string, string | undefined>),
          }),
      )
      logPush(input.conversationId, outcome)
      const uncommitted = outcome.dirty
      if (outcome.status === "pushed")
        return { pushed: true, branch: outcome.branch, uncommitted }
      if (outcome.status === "unchanged")
        return { pushed: false, reason: "nothing_new", uncommitted }
      if (outcome.status === "failed" && outcome.reason === "session_moved")
        return {
          pushed: false,
          reason: outcome.reason,
          uncommitted,
          // The origin URL has no credentials; a private repository needs
          // the sandbox's read credential to fetch.
          next: `The branch on GitHub has commits you do not have. Fetch them with \`${SANDBOX_READ_GIT} fetch origin "$(git branch --show-current)"\`, then run \`git rebase FETCH_HEAD\` on the session branch, resolve any conflicts, and push again.`,
        }
      return { pushed: false, reason: outcome.reason, uncommitted }
    },
  }
}

/**
 * Deletion only: stop a rebase or an unfinished Workspace update, so that the
 * branch's commits can be pushed. Files stay as they are; uncommitted files
 * are not pushed.
 */
const STOP_UNFINISHED_GIT_WORK = `if [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]; then git rebase --abort; fi
T=$(git rev-parse --git-path ctxpipe-revision-transition)
if [ -f "$T" ] && [ "$(sed -n 5p "$T")" != complete ]; then rm -f "$T"; fi
[ -z "$(git diff --name-only --diff-filter=U)" ] || git reset -q
true`

/**
 * Before the sweep deletes a conversation's sandbox, its committed but
 * unpushed work goes to the session branch; uncommitted files do not. A
 * rebase or a Workspace update in progress is stopped first. When the session
 * branch moved on GitHub meanwhile, the commits go to a fresh branch
 * (`…/<n+1>`) instead, which becomes the conversation's branch.
 *
 * `retry`: a local branch still has commits that no remote has; keep the
 * sandbox for the next sweep.
 */
export async function pushBeforeSandboxDelete(input: {
  orgId: string
  conversationId: string
  workspaceId: string
  provider: RunningSandboxProvider
  providerSandboxId: string
  /** The default commit the sandbox is recorded on. */
  baseSha: string
}): Promise<"done" | "retry"> {
  try {
    const org = await getSystemDb().query.organizations.findFirst({
      where: { id: { eq: input.orgId } },
    })
    if (!org) return "done"
    return await withOrgIdContext({ id: org.id, slug: org.slug }, async () => {
      // The sandbox may predate the Workspace's current commit; its commits
      // still belong on the session branch, built on the commit it has.
      const resolved = await resolvePublishTarget({
        ...input,
        sandbox: "ignore",
      })
      // A deleted conversation has no branch to push to.
      if (!resolved.ok && resolved.reason === "missing_conversation")
        return "done"
      const sandbox = await attachProviderSandbox(input)
      if (!sandbox) return "done"
      const handle = adaptTanstackHandle(
        sandbox,
        AbortSignal.timeout(PUSH_TIMEOUT_MS),
      )
      await handle.exec(STOP_UNFINISHED_GIT_WORK, { env: {} })
      if (resolved.ok)
        logPush(
          input.conversationId,
          await pushOrRescue(handle, {
            ...resolved.target,
            baseSha: input.baseSha,
          }),
        )
      else
        log.info({
          step: "conversation-branch-push",
          message: `Conversation commits were not pushed (${resolved.reason})`,
          conversationId: input.conversationId,
          reason: resolved.reason,
        })
      const unpushed = await handle.exec(UNPUSHED_COMMITS_COMMAND, { env: {} })
      if (unpushed.exitCode === 0 && !unpushed.stdout.trim()) return "done"
      log.warn({
        step: "conversation-branch-push",
        message:
          "The sandbox has commits that no remote has; it stays for the next sweep",
        conversationId: input.conversationId,
      })
      return "retry"
    })
  } catch (error) {
    logPush(
      input.conversationId,
      error instanceof Error ? error : new Error(String(error)),
    )
    return "retry"
  }
}

/**
 * Push to the session branch. When someone else pushed to it, the commits go
 * to the next branch name instead, which becomes the conversation's branch.
 * Its PR stays with the old branch, so the conversation has no PR then.
 */
async function pushOrRescue(
  handle: JobSandboxHandle,
  target: PublishTarget,
): Promise<SessionPushResult> {
  const push = (to: PublishTarget) =>
    pushConversationSession({
      handle,
      conversationId: target.conversationId,
      orgId: target.orgId,
      workspaceId: target.workspaceId,
      env: parseEnv(process.env as Record<string, string | undefined>),
      target: to,
    })
  const outcome = await push(target)
  if (outcome.status !== "failed" || outcome.reason !== "session_moved")
    return outcome
  const conversation = await getConversationSession(
    target.orgId,
    target.conversationId,
  )
  const next = nextConversationSessionBranch(
    target.conversationId,
    target.branch,
  )
  if (
    !conversation ||
    !(await rotateConversationSessionBranch({
      orgId: target.orgId,
      conversationId: target.conversationId,
      from: conversation.lastBranch,
      to: next,
    }))
  )
    return outcome
  const moved = await handle.exec('git checkout -q -B "$NEXT"', {
    env: { NEXT: next },
  })
  if (moved.exitCode !== 0) return { status: "failed", reason: "push_failed" }
  const rescued = await push({ ...target, branch: next, pushedSha: null })
  if (rescued.status === "pushed")
    log.info({
      step: "conversation-branch-push",
      message: `The deleted sandbox's commits went to ${next}: the session branch moved on GitHub`,
      conversationId: target.conversationId,
    })
  return rescued
}
