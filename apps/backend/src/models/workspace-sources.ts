import { isDeepStrictEqual } from "node:util"
import { and, eq, inArray, sql } from "drizzle-orm"
import { getSystemDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { repositories } from "../db/schema/repositories.js"
import { workspaceSources } from "../db/schema/workspace_sources.js"
import { workspaces } from "../db/schema/workspaces.js"
import type { PlannedSourceRow } from "../domain/workspace-sources/projection-plan.js"
import {
  githubScopeRepositories,
  githubScopeSchema,
} from "../domain/workspace-sources/providers/github.js"
import { normalizeWorkspaceRepositoryUrl } from "../domain/workspaces/slug.js"
import { generateObjectId } from "../lib/id.js"
import { log } from "../observability/logger.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"
import {
  githubPins,
  listLinkedRepositoryPins,
  reconcileGithubState,
  type SourceState,
} from "./workspace-source-state.js"

export type WorkspaceSourceRow = typeof workspaceSources.$inferSelect

/** The same source entry: provider, connection and scope, not the status. */
export function sameSource(
  row: Pick<WorkspaceSourceRow, "provider" | "connectionId" | "scope">,
  planned: Pick<PlannedSourceRow, "provider" | "connectionId" | "scope">,
): boolean {
  return (
    row.provider === planned.provider &&
    row.connectionId === planned.connectionId &&
    JSON.stringify(row.scope) === JSON.stringify(planned.scope)
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
 * The repositories that a planned GitHub row links, in file order. Only a
 * row with a usable connection links (`ok` or `out_of_access`). A repository
 * in `seen` (the Workspace repository, or one that an earlier row links) is
 * not linked again; the new ones go into `seen`.
 */
function plannedGithubRepositories(
  planned: PlannedSourceRow,
  seen: Set<string>,
): Array<{ gitUrl: string; ref: string | null }> {
  if (
    planned.provider !== "github" ||
    (planned.status !== "ok" && planned.status !== "out_of_access")
  )
    return []
  const scope = githubScopeSchema.safeParse(planned.scope)
  if (!scope.success) return []
  return githubScopeRepositories(scope.data).flatMap(({ name, ref }) => {
    const gitUrl = normalizeWorkspaceRepositoryUrl(`https://github.com/${name}`)
    if (seen.has(gitUrl)) return []
    seen.add(gitUrl)
    return [{ gitUrl, ref }]
  })
}

function nextState(
  current: WorkspaceSourceRow | undefined,
  planned: PlannedSourceRow,
  seen: Set<string>,
): SourceState | Record<string, never> {
  if (planned.provider !== "github") return {}
  return reconcileGithubState(
    current && current.provider === "github" ? githubPins(current) : [],
    plannedGithubRepositories(planned, seen),
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
      const [workspace] = await tx
        .select({ url: workspaces.workspaceRepositoryUrl })
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId))
      // The pinned state of each GitHub row (ADR-046): a repository keeps
      // its link id and SHAs while its URL and ref stay in the file.
      const seen = new Set<string>(
        workspace?.url ? [normalizeWorkspaceRepositoryUrl(workspace.url)] : [],
      )
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
        const state = nextState(current, planned, seen)
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
        // jsonb does not keep the key order, so compare by value.
        const sameState = isDeepStrictEqual(current.state, state)
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
