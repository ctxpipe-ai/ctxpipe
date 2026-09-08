import { and, eq, sql } from "drizzle-orm"
import { withOrgDbContext } from "../db/client.js"
import { confluenceSyncTargets } from "../db/schema/confluenceSyncTargets.js"
import { connections } from "../db/schema/connections.js"

export async function getConnectorContentSyncGeneration(
  orgId: string,
  connectionId: string,
): Promise<number> {
  return withOrgDbContext(orgId, async (db) => {
    const [row] = await db
      .select({ generation: connections.contentSyncGeneration })
      .from(connections)
      .where(eq(connections.id, connectionId))
    if (!row) throw new Error("Connector connection is missing")
    return row.generation
  })
}

/** Project only the current native owner's terminal state; this never schedules or retries work. */
export async function reconcileConnectorContentSync(input: {
  orgId: string
  connectionId: string
  admissionFailedGeneration?: number
}): Promise<boolean> {
  return withOrgDbContext(input.orgId, async (db) => {
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, input.connectionId))
      .for("update")
    if (!connection) return false
    if (
      input.admissionFailedGeneration != null &&
      input.admissionFailedGeneration !== connection.contentSyncGeneration
    )
      return false
    const provider =
      connection.type === "forge" ? "confluence" : connection.type
    if (!["linear", "notion", "confluence"].includes(provider)) return false
    const result = await db.execute<{ status: string }>(sql`
      select status from openworkflow.workflow_runs
      where workflow_name = ${`${provider}-sync-content`}
        and input->>'orgId' = ${input.orgId}
        and input->>'connectionId' = ${input.connectionId}
        and input->>'contentSyncGeneration' = ${String(connection.contentSyncGeneration)}
      order by created_at desc limit 1
    `)
    const owner = result.rows[0]
    if (
      !(owner && ["failed", "canceled"].includes(owner.status)) &&
      !(input.admissionFailedGeneration != null && !owner)
    )
      return Boolean(owner)
    if (provider === "confluence") {
      await db
        .update(confluenceSyncTargets)
        .set({ setupPhase: "sync_failed", updatedAt: new Date() })
        .where(
          and(
            eq(confluenceSyncTargets.connectionId, input.connectionId),
            eq(confluenceSyncTargets.setupPhase, "initial_sync"),
          ),
        )
    } else if (connection.config.setupPhase === "initial_sync") {
      await db
        .update(connections)
        .set({
          config: { ...connection.config, setupPhase: "sync_failed" },
          updatedAt: new Date(),
        })
        .where(eq(connections.id, input.connectionId))
    }
    return Boolean(owner)
  })
}
