import { and, eq, inArray } from "drizzle-orm"
import { withOrgDbContext } from "../db/client.js"
import { workspaceSources } from "../db/schema/workspace_sources.js"
import { workspaces } from "../db/schema/workspaces.js"
import type { PlannedSourceRow } from "../domain/workspace-sources/projection-plan.js"
import { generateObjectId } from "../lib/id.js"

export type WorkspaceSourceRow = typeof workspaceSources.$inferSelect

function sameRow(row: WorkspaceSourceRow, planned: PlannedSourceRow): boolean {
  return (
    row.provider === planned.provider &&
    row.connectionId === planned.connectionId &&
    row.status === planned.status &&
    row.statusDetail === planned.statusDetail &&
    JSON.stringify(row.scope) === JSON.stringify(planned.scope)
  )
}

/**
 * Make the rows of one Workspace match the planned projection of `revision`.
 * Running it again with the same plan changes nothing. Returns the rows that
 * it removed and the rows whose content changed, with their old values.
 */
export async function replaceWorkspaceSourceRows(input: {
  orgId: string
  workspaceId: string
  revision: string
  rows: readonly PlannedSourceRow[]
}): Promise<{
  removed: WorkspaceSourceRow[]
  changed: Array<{ before: WorkspaceSourceRow; after: PlannedSourceRow }>
  added: PlannedSourceRow[]
}> {
  return withOrgDbContext(input.orgId, (db) =>
    db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(workspaceSources)
        .where(eq(workspaceSources.workspaceId, input.workspaceId))
      const byKey = new Map(existing.map((row) => [row.sourceKey, row]))
      const plannedKeys = new Set(input.rows.map((row) => row.sourceKey))
      const removed = existing.filter((row) => !plannedKeys.has(row.sourceKey))
      if (removed.length)
        await tx.delete(workspaceSources).where(
          inArray(
            workspaceSources.id,
            removed.map((row) => row.id),
          ),
        )
      const changed: Array<{
        before: WorkspaceSourceRow
        after: PlannedSourceRow
      }> = []
      const added: PlannedSourceRow[] = []
      const now = new Date()
      for (const planned of input.rows) {
        const current = byKey.get(planned.sourceKey)
        if (!current) {
          added.push(planned)
          await tx.insert(workspaceSources).values({
            id: generateObjectId("wsrc"),
            orgId: input.orgId,
            workspaceId: input.workspaceId,
            ...planned,
            revision: input.revision,
            createdAt: now,
            updatedAt: now,
          })
          continue
        }
        if (sameRow(current, planned)) {
          if (current.revision !== input.revision)
            await tx
              .update(workspaceSources)
              .set({ revision: input.revision })
              .where(eq(workspaceSources.id, current.id))
          continue
        }
        changed.push({ before: current, after: planned })
        await tx
          .update(workspaceSources)
          .set({ ...planned, revision: input.revision, updatedAt: now })
          .where(eq(workspaceSources.id, current.id))
      }
      return { removed, changed, added }
    }),
  )
}

export async function listWorkspaceSourceRows(input: {
  orgId: string
  workspaceId: string
}): Promise<WorkspaceSourceRow[]> {
  return withOrgDbContext(input.orgId, (db) =>
    db
      .select()
      .from(workspaceSources)
      .where(eq(workspaceSources.workspaceId, input.workspaceId))
      .orderBy(workspaceSources.sourceKey),
  )
}

/** The source rows that use one connection, with their Workspace. */
export async function listConnectionSourceRows(input: {
  orgId: string
  connectionId: string
  status?: WorkspaceSourceRow["status"]
}) {
  return withOrgDbContext(input.orgId, (db) =>
    db
      .select({
        source: workspaceSources,
        workspaceSlug: workspaces.slug,
        workspaceName: workspaces.displayName,
      })
      .from(workspaceSources)
      .innerJoin(workspaces, eq(workspaces.id, workspaceSources.workspaceId))
      .where(
        and(
          eq(workspaceSources.connectionId, input.connectionId),
          input.status ? eq(workspaceSources.status, input.status) : undefined,
        ),
      )
      .orderBy(workspaces.slug, workspaceSources.sourceKey),
  )
}
