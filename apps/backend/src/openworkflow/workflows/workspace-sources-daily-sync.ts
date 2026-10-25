import { z } from "zod"

import { enqueueDailySourcesSyncs } from "../../domain/workspace-sources/enqueue.js"
import { hasDailySourcesSyncRun } from "../../models/workspace-sources.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/**
 * The daily full sync of Workspace sources (CTX-557). Each run first queues
 * the run of the next day at its midnight, so that a failure later in the
 * run does not stop the chain. Then it queues the sync of each connection
 * that has an `ok` source for its UTC day. The worker start queues the run
 * of the current day, which starts the chain again after a lost schedule.
 */
export const workspaceSourcesDailySync = defineWorkflow(
  {
    name: "workspace-sources-daily-sync",
    schema: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    retryPolicy: {
      maximumAttempts: 5,
      initialInterval: "1m",
      backoffCoefficient: 3,
      maximumInterval: "1h",
    },
  },
  async ({ input, step }) => {
    const dayStart = Date.parse(`${input.day}T00:00:00.000Z`)
    await step.run({ name: "schedule-next-day" }, () =>
      scheduleDailySourcesSync(new Date(dayStart + 86_400_000)),
    )
    const queued = await step.run({ name: "enqueue-connection-syncs" }, () =>
      enqueueDailySourcesSyncs(new Date(Math.max(dayStart, Date.now()))),
    )
    return { queued }
  },
)

/**
 * Queue the daily run of the UTC day of `at`, to start at `at`. A run that
 * exists for that day stops a second one, also after the idempotency key of
 * OpenWorkflow ends (24 hours after the queue time).
 */
export async function scheduleDailySourcesSync(at: Date): Promise<void> {
  const day = at.toISOString().slice(0, 10)
  if (await hasDailySourcesSyncRun(day)) return
  await runWorkflowWithWorkerWake(
    workspaceSourcesDailySync.spec,
    { day },
    {
      availableAt: at,
      idempotencyKey: `workspace-sources-daily:${day}`,
    },
  )
}
