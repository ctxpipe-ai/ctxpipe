import type { SandboxHandle } from "@tanstack/ai-sandbox"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import type { RunningSandboxProvider } from "../../models/workspace-sandboxes.js"
import { log } from "../../observability/logger.js"
import { nextConversationSessionBranch } from "./chat-lifecycle.js"
import {
  type PublishTarget,
  pushConversationSession,
  resolvePublishTarget,
  type SessionPushResult,
} from "./conversation-publish.js"
import { adaptTanstackHandle } from "./job-sandbox.js"
import { attachProviderSandbox } from "./sandbox-provider.js"
import type { WorkspaceChatTanstackTool } from "./workspace-chat-tools.js"

/** A push gives up after this long, so it never holds the conversation. */
const PUSH_TIMEOUT_MS = 2 * 60_000

function logPush(conversationId: string, outcome: SessionPushResult | Error) {
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
      const uncommitted =
        (await handle.exec("git status --porcelain", { env: {} })).stdout.trim()
          .length > 0
      if (outcome.status === "pushed")
        return { pushed: true, branch: outcome.branch, uncommitted }
      if (outcome.status === "unchanged")
        return { pushed: false, reason: "nothing_new", uncommitted }
      if (outcome.status === "failed" && outcome.reason === "session_moved")
        return {
          pushed: false,
          reason: outcome.reason,
          uncommitted,
          next: "The branch on GitHub has commits you do not have. Run `git fetch origin <branch>` and `git rebase FETCH_HEAD` on the session branch, resolve any conflicts, then push again.",
        }
      return { pushed: false, reason: outcome.reason, uncommitted }
    },
  }
}

/**
 * Before the sweep deletes a conversation's sandbox, its committed but
 * unpushed work goes to the session branch; uncommitted files do not. When
 * the session branch moved on GitHub meanwhile, the commits go to a fresh
 * branch (`…/<n+1>`) instead, which becomes the conversation's branch.
 *
 * `retry`: the push failed; keep the sandbox for the next sweep.
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
      if (!resolved.ok) {
        logPush(input.conversationId, {
          status: "skipped",
          reason: resolved.reason,
        })
        return "done"
      }
      const sandbox = await attachProviderSandbox(input)
      if (!sandbox) return "done"
      const handle = adaptTanstackHandle(
        sandbox,
        AbortSignal.timeout(PUSH_TIMEOUT_MS),
      )
      const push = (target: PublishTarget) =>
        pushConversationSession({
          handle,
          conversationId: input.conversationId,
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          env: parseEnv(process.env as Record<string, string | undefined>),
          target,
        })
      const target = { ...resolved.target, baseSha: input.baseSha }
      let outcome = await push(target)
      // Someone else pushed to the session branch: the commits go to the next
      // free branch name instead, which becomes the conversation's branch.
      let branch = target.branch
      for (
        let attempt = 0;
        attempt < 5 &&
        outcome.status === "failed" &&
        outcome.reason === "session_moved";
        attempt += 1
      ) {
        branch = nextConversationSessionBranch(input.conversationId, branch)
        const moved = await handle.exec('git checkout -q -B "$NEXT"', {
          env: { NEXT: branch },
        })
        outcome =
          moved.exitCode === 0
            ? await push({ ...target, branch, pushedSha: null })
            : { status: "failed", reason: "push_failed" }
      }
      if (outcome.status === "pushed" && branch !== target.branch)
        log.info({
          step: "conversation-branch-push",
          message: `The deleted sandbox's commits went to ${branch}: the session branch moved on GitHub`,
          conversationId: input.conversationId,
        })
      logPush(input.conversationId, outcome)
      return outcome.status === "failed" ? "retry" : "done"
    })
  } catch (error) {
    logPush(
      input.conversationId,
      error instanceof Error ? error : new Error(String(error)),
    )
    return "retry"
  }
}
