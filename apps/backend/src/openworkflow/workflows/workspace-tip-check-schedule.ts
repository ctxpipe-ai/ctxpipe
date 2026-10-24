import { createHash } from "node:crypto"
import { z } from "zod"
import { log } from "../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { enqueueWorkspaceTipCheck } from "../enqueue-workspace-tip-check.js"
import { listOrgIdsWithWorkspaces } from "../orgs-with-workspaces.js"

const HOUR_MS = 3_600_000

/**
 * The hourly tip check of each org that has a Workspace (ADR-046: "a
 * periodic tip check"). The tip check hydrates a tip that no webhook
 * announced, and it builds again each phase that is not ready, with no new
 * commit: for example a graph that failed while the graph store was down.
 * Each run first queues the run of the next hour, so a failure later in the
 * run does not stop the chain. A run of an hour that is already over only
 * queues the next hour, so a late chain does not queue the checks of each
 * hour that it missed. The worker queues the run of the current hour at
 * start and each 5 minutes, which starts the chain again after a lost
 * schedule.
 */
export const workspaceTipCheckSchedule = defineWorkflow(
  {
    name: "workspace-tip-check-schedule",
    schema: z.object({ hour: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}$/) }),
  },
  async ({ input, step }) => {
    const hourStart = Date.parse(`${input.hour}:00:00.000Z`)
    await step.run({ name: "schedule-next-hour" }, () =>
      scheduleWorkspaceTipChecks(new Date(hourStart + HOUR_MS)),
    )
    if (hourStart + HOUR_MS < Date.now()) return { queued: 0 }
    return step.run({ name: "queue-org-tip-checks" }, async () => {
      let queued = 0
      for (const orgId of await listOrgIdsWithWorkspaces()) {
        // A hash of the org id gives its minute and second in the hour, so
        // the checks of all orgs do not start at the same time. The key
        // names the org and the hour, so a second run of this hour queues
        // no second check. The check gets the hour for its retry keys.
        const offsetMs =
          (createHash("sha256").update(orgId).digest().readUInt32BE(0) % 3600) *
          1000
        const started = await enqueueWorkspaceTipCheck(
          orgId,
          {
            error: (error) =>
              log.error({
                step: "workspace-tip-check-schedule",
                message: `Queueing the hourly tip check failed: ${String(error)}`,
                orgId,
              }),
          },
          {
            hour: input.hour,
            availableAt: new Date(hourStart + offsetMs),
            idempotencyKey: `workspace-tip-check-hourly:${orgId}:${input.hour}`,
          },
        )
        if (started) queued += 1
      }
      return { queued }
    })
  },
)

/** Queue the schedule run of the UTC hour of `at`, to start at `at`. */
export async function scheduleWorkspaceTipChecks(at: Date): Promise<void> {
  const hour = at.toISOString().slice(0, 13)
  await runWorkflowWithWorkerWake(
    workspaceTipCheckSchedule.spec,
    { hour },
    { availableAt: at, idempotencyKey: `workspace-tip-check-schedule:${hour}` },
  )
}
