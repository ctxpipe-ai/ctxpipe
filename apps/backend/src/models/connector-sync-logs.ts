import { and, desc, eq } from "drizzle-orm"
import { requireCurrentOrgId } from "src/auth/context.js"
import { connectorSyncLogs } from "src/db/schema/connector-sync-logs.js"
import { connectors } from "src/db/schema/connectors.js"
import { generateObjectId } from "src/lib/id.js"
import { getOrgDb } from "../db/client.js"

export type SyncLogRecord = typeof connectorSyncLogs.$inferSelect
export type SyncStatus = "started" | "completed" | "failed"

export const listSyncLogs = async (
  connectorId: string,
  options?: { limit?: number },
) => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  const limit = options?.limit ?? 20

  return db
    .select()
    .from(connectorSyncLogs)
    .innerJoin(connectors, eq(connectors.id, connectorSyncLogs.connectorId))
    .where(
      and(
        eq(connectorSyncLogs.connectorId, connectorId),
        eq(connectors.orgId, orgId),
      ),
    )
    .orderBy(desc(connectorSyncLogs.startedAt))
    .limit(limit)
}

export const getLatestSyncLog = async (connectorId: string) => {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()

  const [result] = await db
    .select()
    .from(connectorSyncLogs)
    .innerJoin(connectors, eq(connectors.id, connectorSyncLogs.connectorId))
    .where(
      and(
        eq(connectorSyncLogs.connectorId, connectorId),
        eq(connectors.orgId, orgId),
      ),
    )
    .orderBy(desc(connectorSyncLogs.startedAt))
    .limit(1)

  return result?.connector_sync_logs ?? null
}

export const createSyncLog = async (input: {
  connectorId: string
  status: SyncStatus
}) => {
  const id = generateObjectId("csl")
  const db = getOrgDb()

  const [log] = await db
    .insert(connectorSyncLogs)
    .values({
      id,
      connectorId: input.connectorId,
      status: input.status,
    })
    .returning()

  if (log) return log
  throw new Error("Failed to create sync log")
}

export const completeSyncLog = async (
  logId: string,
  input: {
    status: "completed" | "failed"
    prNumber?: number
    prUrl?: string
    pagesAdded?: number
    pagesUpdated?: number
    pagesDeleted?: number
    errorMessage?: string
  },
) => {
  const db = getOrgDb()

  const [updated] = await db
    .update(connectorSyncLogs)
    .set({
      status: input.status,
      prNumber: input.prNumber ?? null,
      prUrl: input.prUrl ?? null,
      pagesAdded: input.pagesAdded ?? 0,
      pagesUpdated: input.pagesUpdated ?? 0,
      pagesDeleted: input.pagesDeleted ?? 0,
      errorMessage: input.errorMessage ?? null,
      completedAt: new Date(),
    })
    .where(eq(connectorSyncLogs.id, logId))
    .returning()

  return updated ?? null
}
