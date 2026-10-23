import { createHash } from "node:crypto"
import { z } from "zod"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { listOrgWorkspaces } from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { workspaceTipCheck } from "./workspace-tip-check.js"

const hourSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}$/)

/**
 * The hourly tip check of each org that has a Workspace (ADR-046: "a
 * periodic tip check"). The tip check hydrates a tip that no webhook
 * announced, and it builds again each phase that is not ready, with no new
 * commit: for example a graph that failed while the graph store was down.
 * Each run first queues the run of the next hour, so a failure later in the
 * run does not stop the chain. The worker start queues the run of the
 * current hour, which starts the chain again after a lost schedule.
 */
export const workspaceTipCheckSchedule = defineWorkflow(
  {
    name: "workspace-tip-check-schedule",
    schema: z.object({ hour: hourSchema }),
  },
  async ({ input, step }) => {
    const hourStart = Date.parse(`${input.hour}:00:00.000Z`)
    await step.run({ name: "schedule-next-hour" }, () =>
      scheduleWorkspaceTipChecks(new Date(hourStart + 3_600_000)),
    )
    return step.run({ name: "queue-org-tip-checks" }, async () => {
      const orgs = await getSystemDb()
        .select({ id: organizations.id })
        .from(organizations)
        .orderBy(organizations.id)
      let queued = 0
      for (const { id: orgId } of orgs) {
        try {
          // RLS shows the Workspaces of an org only in its own context.
          const workspaces = await withOrgDbContext(orgId, () =>
            listOrgWorkspaces(orgId),
          )
          if (!workspaces.length) continue
          await enqueueHourlyTipCheck(orgId, input.hour)
          queued += 1
        } catch (error) {
          log.error({
            step: "workspace-tip-check-schedule",
            message: `Queueing the hourly tip check failed: ${String(error)}`,
            orgId,
          })
        }
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

/**
 * Queue the tip check of one org for the UTC hour `hour`. A hash of the org
 * id gives its minute and second in that hour, so the checks of all orgs do
 * not start at the same time. The key names the org and the hour, so a
 * restart in the same hour queues no second check. The check gets the hour,
 * so that its retry keys are those of this hour.
 */
export async function enqueueHourlyTipCheck(orgId: string, hour: string) {
  const offsetMs =
    (createHash("sha256").update(orgId).digest().readUInt32BE(0) % 3600) * 1000
  return runWorkflowWithWorkerWake(
    workspaceTipCheck.spec,
    { orgId, hour },
    {
      availableAt: new Date(Date.parse(`${hour}:00:00.000Z`) + offsetMs),
      idempotencyKey: `workspace-tip-check-hourly:${orgId}:${hour}`,
    },
  )
}
