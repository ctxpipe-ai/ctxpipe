import { isDeepStrictEqual } from "node:util"
import { and, eq, inArray, sql } from "drizzle-orm"
import { getSystemDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { repositories } from "../db/schema/repositories.js"
import { workspaceSources } from "../db/schema/workspace_sources.js"
import { workspaces } from "../db/schema/workspaces.js"
import {
  type PlannedSourceRow,
  unmatchedSourceDetail,
} from "../domain/workspace-sources/projection-plan.js"
import { sourceProviderSchema } from "../domain/workspace-sources/sources-file.js"
import { normalizeWorkspaceRepositoryUrl } from "../domain/workspaces/slug.js"
import { generateObjectId } from "../lib/id.js"
import { log } from "../observability/logger.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"
import {
  holdsTarget,
  listLinkedRepositoryPins,
  planSourceStates,
  sameSourceState,
} from "./workspace-source-state.js"

export type WorkspaceSourceRow = typeof workspaceSources.$inferSelect

/**
 * The same source entry: provider, connection and scope, not the status.
 * jsonb does not keep the key order of the stored scope, so compare by value.
 */
export function sameSource(
  row: Pick<WorkspaceSourceRow, "provider" | "connectionId" | "scope">,
  planned: Pick<PlannedSourceRow, "provider" | "connectionId" | "scope">,
): boolean {
  return (
    row.provider === planned.provider &&
    row.connectionId === planned.connectionId &&
    isDeepStrictEqual(row.scope, planned.scope)
  )
}

function sameRow(row: WorkspaceSourceRow, planned: PlannedSourceRow): boolean {
  return (
    sameSource(row, planned) &&
    row.status === planned.status &&
    row.statusDetail === planned.statusDetail
  )
}

/**
 * Make the rows of one Workspace match the planned projection of `revision`.
 * Running it again with the same plan changes nothing. Returns the rows that
 * it removed and the rows whose content changed, with their old values.
 *
 * When the plan cannot tell if a missing source left the file (see
 * `unmatchedSourceDetail`), the row of a missing source with a last good
 * target stays as `invalid`, so its files stay. An `invalid` row keeps the
 * last good target of its source in its state.
 */
export async function replaceWorkspaceSourceRows(input: {
  orgId: string
  workspaceId: string
  revision: string
  rows: readonly PlannedSourceRow[]
  /**
   * The old key of a row whose source moved to a new key, by new key: the
   * conversion moves an entry of `.ctxpipe/sources.yaml` to a file.
   */
  movedFrom?: ReadonlyMap<string, string>
}): Promise<{
  removed: WorkspaceSourceRow[]
  changed: Array<{ before: WorkspaceSourceRow; after: PlannedSourceRow }>
  added: PlannedSourceRow[]
}> {
  return withOrgDbContext(input.orgId, (db) =>
    db.transaction(async (tx) => {
      // Lock the rows: a pin write (`updateLinkedRepositoryPin`) waits, so
      // this write cannot undo its SHAs.
      const existing = await tx
        .select()
        .from(workspaceSources)
        .where(eq(workspaceSources.workspaceId, input.workspaceId))
        .for("update")
      const [workspace] = await tx
        .select({ url: workspaces.workspaceRepositoryUrl })
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId))
      const plannedKeys = new Set(input.rows.map((row) => row.sourceKey))
      const unmatchedDetail = unmatchedSourceDetail(input.rows)
      const held = (row: WorkspaceSourceRow) =>
        unmatchedDetail !== null && holdsTarget(row)
      const missing = existing.filter((row) => !plannedKeys.has(row.sourceKey))
      const removed = missing.filter((row) => !held(row))
      const plan: PlannedSourceRow[] = [
        ...input.rows,
        ...missing.filter(held).map((row) => ({
          sourceKey: row.sourceKey,
          provider: sourceProviderSchema.safeParse(row.provider).data ?? null,
          connectionId: row.connectionId,
          scope: row.scope,
          status: "invalid" as const,
          statusDetail: unmatchedDetail,
        })),
      ]
      const states = planSourceStates({
        existing,
        planned: plan,
        workspaceUrl: workspace?.url ?? null,
        movedFrom: input.movedFrom,
      })
      const byKey = new Map(existing.map((row) => [row.sourceKey, row]))
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
      for (const planned of plan) {
        const current = byKey.get(planned.sourceKey)
        const state = states.get(planned.sourceKey) ?? {}
        if (!current) {
          added.push(planned)
          await tx.insert(workspaceSources).values({
            id: generateObjectId("wsrc"),
            orgId: input.orgId,
            workspaceId: input.workspaceId,
            ...planned,
            state,
            revision: input.revision,
            createdAt: now,
            updatedAt: now,
          })
          continue
        }
        const sameState = sameSourceState(current.state, state)
        if (sameRow(current, planned)) {
          if (current.revision !== input.revision || !sameState)
            await tx
              .update(workspaceSources)
              .set({ revision: input.revision, state })
              .where(eq(workspaceSources.id, current.id))
          continue
        }
        changed.push({ before: current, after: planned })
        await tx
          .update(workspaceSources)
          .set({ ...planned, state, revision: input.revision, updatedAt: now })
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
        workspaceRepositoryUrl: workspaces.workspaceRepositoryUrl,
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
 * The connections of each organization that have at least one `ok` source,
 * with the provider of those sources. Rows are org-isolated, so the read
 * goes through each organization in turn.
 */
export async function listConnectionsWithOkSources(): Promise<
  Array<{ orgId: string; connectionId: string; provider: string }>
> {
  const orgs = await getSystemDb()
    .select({ id: organizations.id })
    .from(organizations)
  const found: Array<{
    orgId: string
    connectionId: string
    provider: string
  }> = []
  for (const { id } of orgs) {
    // One org that fails to read does not stop the scan of the others.
    const rows = await withOrgDbContext(id, (db) =>
      db
        .selectDistinct({
          connectionId: workspaceSources.connectionId,
          provider: workspaceSources.provider,
        })
        .from(workspaceSources)
        .where(eq(workspaceSources.status, "ok")),
    ).catch((error: unknown) => {
      log.error({
        step: "workspace_sources.list_ok_connections",
        orgId: id,
        message: error instanceof Error ? error.message : String(error),
      })
      return []
    })
    for (const row of rows)
      if (row.connectionId && row.provider)
        found.push({
          orgId: id,
          connectionId: row.connectionId,
          provider: row.provider,
        })
  }
  return found
}

/** True when a daily sources sync run exists for the UTC `day` (YYYY-MM-DD). */
export async function hasDailySourcesSyncRun(day: string): Promise<boolean> {
  const found = await getSystemDb().execute(sql`
    select 1 from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()}
      and workflow_name = 'workspace-sources-daily-sync'
      and input->>'day' = ${day}
    limit 1
  `)
  return found.rows.length > 0
}

/**
 * Set the status of one source row when the sync finds its scope out of
 * reach for good. The next projection of the Workspace computes the status
 * again from the file and the provider.
 */
export async function setWorkspaceSourceStatus(input: {
  orgId: string
  id: string
  status: WorkspaceSourceRow["status"]
  statusDetail: string
}): Promise<void> {
  await withOrgDbContext(input.orgId, (db) =>
    db
      .update(workspaceSources)
      .set({
        status: input.status,
        statusDetail: input.statusDetail,
        updatedAt: new Date(),
      })
      .where(eq(workspaceSources.id, input.id)),
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
      listLinkedRepositoryPins(db),
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
