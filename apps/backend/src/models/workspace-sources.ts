import { and, eq, inArray } from "drizzle-orm"
import { withOrgDbContext } from "../db/client.js"
import { repositories } from "../db/schema/repositories.js"
import { workspaceSources } from "../db/schema/workspace_sources.js"
import {
  workspaceLinkedRepositories,
  workspaces,
} from "../db/schema/workspaces.js"
import type { PlannedSourceRow } from "../domain/workspace-sources/projection-plan.js"
import { normalizeWorkspaceRepositoryUrl } from "../domain/workspaces/slug.js"
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

/**
 * Record a new access check of one source row. The row keeps its revision;
 * a projection of a newer revision since the read wins.
 */
export async function recordSourceAccessCheck(input: {
  orgId: string
  id: string
  revision: string
  status: "ok" | "out_of_access"
  statusDetail: string | null
}): Promise<void> {
  await withOrgDbContext(input.orgId, (db) =>
    db
      .update(workspaceSources)
      .set({
        status: input.status,
        statusDetail: input.statusDetail,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaceSources.id, input.id),
          eq(workspaceSources.revision, input.revision),
        ),
      ),
  )
}

/**
 * The Workspaces that use one GitHub connection: for its own Workspace
 * repository, for linked repositories whose org repository row it reads, or
 * both.
 */
export async function listGithubConnectionWorkspaces(input: {
  orgId: string
  connectionId: string
}): Promise<
  Array<{
    workspaceId: string
    workspaceSlug: string
    workspaceName: string
    workspaceRepository: boolean
    linkedRepositories: number
  }>
> {
  return withOrgDbContext(input.orgId, async (db) => {
    const [rows, linked, bound] = await Promise.all([
      db
        .select({
          id: workspaces.id,
          slug: workspaces.slug,
          displayName: workspaces.displayName,
          githubConnectionId: workspaces.githubConnectionId,
        })
        .from(workspaces)
        .orderBy(workspaces.slug),
      db
        .select({
          workspaceId: workspaceLinkedRepositories.workspaceId,
          gitUrl: workspaceLinkedRepositories.gitUrl,
        })
        .from(workspaceLinkedRepositories),
      db
        .select({ gitUrl: repositories.gitUrl })
        .from(repositories)
        .where(eq(repositories.githubConnectionId, input.connectionId)),
    ])
    const readable = new Set(
      bound.map((row) => normalizeWorkspaceRepositoryUrl(row.gitUrl)),
    )
    return rows.flatMap((workspace) => {
      const linkedRepositories = linked.filter(
        (row) =>
          row.workspaceId === workspace.id &&
          readable.has(normalizeWorkspaceRepositoryUrl(row.gitUrl)),
      ).length
      const workspaceRepository =
        workspace.githubConnectionId === input.connectionId
      if (!workspaceRepository && !linkedRepositories) return []
      return [
        {
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
          workspaceName: workspace.displayName,
          workspaceRepository,
          linkedRepositories,
        },
      ]
    })
  })
}
