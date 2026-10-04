import type { SandboxHandle } from "@tanstack/ai-sandbox"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import type { RunningSandboxProvider } from "../../models/workspace-sandboxes.js"
import { log } from "../../observability/logger.js"
import {
  pushConversationSession,
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
      let outcome: SessionPushResult
      try {
        outcome = await withOrgIdContext(
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
      } catch (error) {
        logPush(
          input.conversationId,
          error instanceof Error ? error : new Error(String(error)),
        )
        return { pushed: false, reason: "push_failed" }
      }
      logPush(input.conversationId, outcome)
      const uncommitted =
        (await handle.exec("git status --porcelain", { env: {} })).stdout.trim()
          .length > 0
      if (outcome.status === "pushed")
        return { pushed: true, branch: outcome.branch, uncommitted }
      if (outcome.status === "unchanged")
        return { pushed: false, reason: "nothing_new", uncommitted }
      return { pushed: false, reason: outcome.reason, uncommitted }
    },
  }
}

/**
 * Before the sweep deletes a conversation's sandbox (30 days unused), its
 * committed but unpushed work goes to the session branch; uncommitted files
 * are not. Best effort: a failure is logged and the deletion goes ahead.
 */
export async function pushBeforeSandboxDelete(input: {
  orgId: string
  conversationId: string
  workspaceId: string
  provider: RunningSandboxProvider
  providerSandboxId: string
}): Promise<void> {
  try {
    const org = await getSystemDb().query.organizations.findFirst({
      where: { id: { eq: input.orgId } },
    })
    if (!org) return
    const handle = await attachProviderSandbox(input)
    if (!handle) return
    logPush(
      input.conversationId,
      await withOrgIdContext({ id: org.id, slug: org.slug }, () =>
        pushConversationSession({
          handle: adaptTanstackHandle(
            handle,
            AbortSignal.timeout(PUSH_TIMEOUT_MS),
          ),
          conversationId: input.conversationId,
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          env: parseEnv(process.env as Record<string, string | undefined>),
          // A stopped sandbox may predate the Workspace's current commit; its
          // commits still belong on the session branch.
          sandboxBinding: "if-live",
        }),
      ),
    )
  } catch (error) {
    logPush(
      input.conversationId,
      error instanceof Error ? error : new Error(String(error)),
    )
  }
}
