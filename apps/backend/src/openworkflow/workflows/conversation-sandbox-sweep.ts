import { z } from "zod"
import { CHAT_SANDBOX_IDLE_STOP_MS } from "../../domain/workspaces/chat-lifecycle.js"
import {
  orgsWithSandboxes,
  sweepConversationSandboxes,
} from "../../domain/workspaces/conversation-sandbox-lifecycle.js"
import { discoverSandboxProvider } from "../../domain/workspaces/sandbox-provider.js"
import { getLogger, log } from "../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { requestDockerSandboxHostPrune } from "./docker-sandbox-host-prune.js"

/**
 * One organization's conversation sandbox lifecycle (idle stop, 30-day
 * deletion, unused Workspace bases). Each run schedules the next for when a
 * running sandbox is next due, so the chain lasts while the org runs
 * sandboxes. The schedule step is separate, so a retried run reuses the
 * swept result instead of computing a second next time. On Docker hosts each
 * run asks for the host prune, which runs once per 5-minute window however
 * many orgs sweep (the host's disk only grows while sandboxes run).
 */
export const conversationSandboxSweep = defineWorkflow(
  {
    name: "conversation-sandbox-sweep",
    schema: z.object({ orgId: z.string().min(1) }),
  },
  async ({ input, step }) => {
    const swept = await step.run({ name: "sweep" }, async () => {
      const result = await sweepConversationSandboxes(input.orgId)
      return {
        stopped: result.stopped,
        deleted: result.deleted,
        nextSweepAt: result.nextSweepAt?.toISOString() ?? null,
      }
    })
    const { nextSweepAt } = swept
    if (nextSweepAt)
      await step.run({ name: "schedule-next" }, () =>
        scheduleConversationSandboxSweep(input.orgId, new Date(nextSweepAt)),
      )
    await step.run({ name: "request-host-prune" }, async () => {
      try {
        if ((await discoverSandboxProvider()) === "docker")
          await requestDockerSandboxHostPrune()
      } catch (error) {
        // The next sweep asks again; the org's own sweep is done.
        getLogger().error(
          error instanceof Error ? error : new Error(String(error)),
          {
            step: "docker-sandbox-host-prune",
            orgId: input.orgId,
          },
        )
      }
    })
    return swept
  },
)

/**
 * Runs are keyed by org and by the minute boundary at or after `at`. Every
 * caller derives `at` from the same state (a sandbox's last use plus 5
 * minutes, or the shared retry boundary), so runs that want the same sweep
 * share one run and the org keeps a single chain.
 */
export async function scheduleConversationSandboxSweep(
  orgId: string,
  at: Date,
): Promise<void> {
  const minute = Math.ceil(at.getTime() / 60_000) * 60_000
  await runWorkflowWithWorkerWake(
    conversationSandboxSweep.spec,
    { orgId },
    {
      availableAt: new Date(minute),
      idempotencyKey: `conversation-sandbox-sweep:${orgId}:${minute}`,
    },
  )
}

/** A sandbox was used (a turn ended, a prepare or file read): stop it once idle. */
export async function scheduleIdleSandboxStop(
  orgId: string,
  usedAt: Date,
): Promise<void> {
  try {
    await scheduleConversationSandboxSweep(
      orgId,
      new Date(usedAt.getTime() + CHAT_SANDBOX_IDLE_STOP_MS),
    )
  } catch (error) {
    // The worker-start backstop and the next use reschedule it.
    log.error({
      step: "conversation-sandbox-sweep-schedule",
      message: `Scheduling the sandbox sweep failed: ${String(error)}`,
      orgId,
    })
  }
}

/**
 * Backstop for a lost chain (a failed schedule, a crashed replica): on worker
 * start, sweep every org that has a sandbox row (`orgsWithSandboxes`).
 */
export async function scheduleSweepsForOrgsNeedingIt(): Promise<void> {
  const now = new Date()
  for (const orgId of await orgsWithSandboxes()) {
    try {
      await scheduleConversationSandboxSweep(orgId, now)
    } catch (error) {
      log.error({
        step: "conversation-sandbox-sweep-backstop",
        message: `Scheduling the startup sandbox sweep failed: ${String(error)}`,
        orgId,
      })
    }
  }
}
