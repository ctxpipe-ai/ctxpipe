import { z } from "zod"
import { sweepConversationSandboxes } from "../../domain/workspaces/conversation-sandbox-lifecycle.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/**
 * One organization's conversation sandbox lifecycle (idle stop, 30-day
 * deletion). Each run schedules the next for when a sandbox is next due, so
 * the chain lasts as long as the org has sandboxes; starting a sandbox
 * schedules a run too.
 */
export const conversationSandboxSweep = defineWorkflow(
  {
    name: "conversation-sandbox-sweep",
    schema: z.object({ orgId: z.string().min(1) }),
  },
  async ({ input, step }) =>
    step.run({ name: "sweep" }, async () => {
      const swept = await sweepConversationSandboxes(input.orgId)
      if (swept.nextSweepAt)
        await scheduleConversationSandboxSweep(input.orgId, swept.nextSweepAt)
      return {
        stopped: swept.stopped,
        deleted: swept.deleted,
        nextSweepAt: swept.nextSweepAt?.toISOString() ?? null,
      }
    }),
)

/**
 * Runs are keyed by org and minute, so starts and sweeps that want the same
 * minute share one run, and two chains merge once they compute the same
 * next sweep.
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
