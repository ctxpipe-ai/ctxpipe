import { and, eq, sql } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { repositories } from "../../db/schema/repositories.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { getLogger, log } from "../../observability/logger.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import type { SourceMigrationHook } from "./migration-plan.js"
import type { SourceProvider } from "./sources-file.js"

type LegacyHandoverInput = {
  orgId: string
  connectionId: string
  /** The old sync repository of the legacy binding. */
  repositoryGitUrl: string
}

/**
 * True when a Workspace on this repository has an `ok` source of the same
 * connection (ADR-050). Then only the Workspace sources sync writes the
 * provider content there, and the legacy binding must not write.
 */
export async function isLegacyBindingHandedOver(
  provider: SourceProvider,
  input: LegacyHandoverInput,
): Promise<boolean> {
  const target = normalizeWorkspaceRepositoryUrl(input.repositoryGitUrl)
  const rows = await withOrgDbContext(input.orgId, (db) =>
    db
      .selectDistinct({ url: workspaces.workspaceRepositoryUrl })
      .from(workspaceSources)
      .innerJoin(workspaces, eq(workspaces.id, workspaceSources.workspaceId))
      .where(
        and(
          eq(workspaceSources.orgId, input.orgId),
          eq(workspaceSources.provider, provider),
          eq(workspaceSources.connectionId, input.connectionId),
          eq(workspaceSources.status, "ok"),
        ),
      ),
  )
  return rows.some((row) => normalizeWorkspaceRepositoryUrl(row.url) === target)
}

/**
 * The legacy sync gate. A failed lookup logs a warning and lets the legacy
 * sync run, so a database problem never stops the mirror. The warning uses
 * the global logger, because some callers have no logger in their context.
 */
export async function legacyBindingHandedOver(
  provider: SourceProvider,
  input: LegacyHandoverInput,
  check: typeof isLegacyBindingHandedOver = isLegacyBindingHandedOver,
): Promise<boolean> {
  try {
    return await check(provider, input)
  } catch (error) {
    log.warn({
      step: "workspace_sources.legacy_handover",
      message: "The legacy handover check failed; the legacy sync runs",
      provider,
      connectionId: input.connectionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * The git URL of the old sync repository that `connections.config.repositoryId`
 * names (Linear, Notion, PagerDuty, Slack), or null.
 */
export async function configBoundRepositoryUrl(input: {
  orgId: string
  connectionId: string
}): Promise<string | null> {
  const [row] = await withOrgDbContext(input.orgId, (db) =>
    db
      .select({ gitUrl: repositories.gitUrl })
      .from(connections)
      .innerJoin(
        repositories,
        and(
          eq(repositories.orgId, connections.orgId),
          eq(repositories.id, sql`${connections.config}->>'repositoryId'`),
        ),
      )
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.orgId, input.orgId),
        ),
      )
      .limit(1),
  )
  return row?.gitUrl ?? null
}

/**
 * Turn off a migrated legacy binding when a source of its connection first
 * projects as `ok` in the Workspace whose repository is the old sync
 * repository, that is after the migration PR merges (ADR-050). Until then
 * the legacy sync keeps writing, so no content is lost in the window. A
 * failure logs a warning; the next projection tries again.
 */
export async function handOverLegacyBindings(input: {
  orgId: string
  workspaceId: string
  rows: ReadonlyArray<{
    provider: SourceProvider | string | null
    connectionId: string | null
    status: string
  }>
  hooks?: Partial<Record<SourceProvider, SourceMigrationHook>>
}): Promise<void> {
  const pairs = new Map<string, { provider: string; connectionId: string }>()
  for (const row of input.rows)
    if (row.status === "ok" && row.provider && row.connectionId)
      pairs.set(`${row.provider}:${row.connectionId}`, {
        provider: row.provider,
        connectionId: row.connectionId,
      })
  if (!pairs.size) return
  const hooks =
    input.hooks ?? (await import("./migration-plan.js")).SOURCE_MIGRATION_HOOKS
  const [workspace] = await withOrgDbContext(input.orgId, (db) =>
    db
      .select({ url: workspaces.workspaceRepositoryUrl })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .limit(1),
  )
  if (!workspace) return
  const target = normalizeWorkspaceRepositoryUrl(workspace.url)
  for (const { provider, connectionId } of pairs.values()) {
    const hook = hooks[provider as SourceProvider]
    if (!hook?.disableLegacy || !hook.legacyRepositoryUrl) continue
    try {
      const url = await hook.legacyRepositoryUrl({
        orgId: input.orgId,
        connectionId,
      })
      if (url && normalizeWorkspaceRepositoryUrl(url) === target)
        await hook.disableLegacy({ orgId: input.orgId, connectionId })
    } catch (error) {
      getLogger().warn(
        "The legacy handover failed; the next projection tries again",
        {
          step: "workspace_sources.legacy_handover",
          provider,
          connectionId,
          error: error instanceof Error ? error.message : String(error),
        },
      )
    }
  }
}
