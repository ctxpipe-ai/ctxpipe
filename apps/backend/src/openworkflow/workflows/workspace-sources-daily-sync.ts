import { z } from "zod"
import { enqueueDailySourcesSyncs } from "../../domain/workspace-sources/enqueue.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/**
 * The daily full sync of Workspace sources (CTX-557). Each run queues the
 * sync of each connection that has an `ok` source for its UTC day, then
 * queues the run of the next day at its midnight. The worker start queues
 * the run of the current day, which starts the chain again after a lost
 * schedule. The keys are per day, so these runs share one run for each day.
 */
export const workspaceSourcesDailySync = defineWorkflow(
  {
    name: "workspace-sources-daily-sync",
    schema: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  },
  async ({ input, step }) => {
    const queued = await step.run({ name: "enqueue-connection-syncs" }, () => {
      const dayStart = Date.parse(`${input.day}T00:00:00.000Z`)
      return enqueueDailySourcesSyncs(new Date(Math.max(dayStart, Date.now())))
    })
    await step.run({ name: "schedule-next-day" }, () =>
      scheduleDailySourcesSync(
        new Date(Date.parse(`${input.day}T00:00:00.000Z`) + 86_400_000),
      ),
    )
    return { queued }
  },
)

/** Queue the daily run of the UTC day of `at`, to start at `at`. */
export async function scheduleDailySourcesSync(at: Date): Promise<void> {
  const day = at.toISOString().slice(0, 10)
  await runWorkflowWithWorkerWake(
    workspaceSourcesDailySync.spec,
    { day },
    {
      availableAt: at,
      idempotencyKey: `workspace-sources-daily:${day}`,
    },
  )
}
