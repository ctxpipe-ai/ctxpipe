import { eq } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"
import { confluenceSpaces } from "../../db/schema/confluenceSpaces.js"
import { confluenceSyncTargets } from "../../db/schema/confluenceSyncTargets.js"
import {
  CONNECTION_TYPE_FORGE,
  connections,
} from "../../db/schema/connections.js"
import { repositories } from "../../db/schema/repositories.js"
import type {
  LegacySourceBinding,
  SourceMigrationHook,
} from "../../domain/workspace-sources/migration-plan.js"
import { confluenceSourceScopeSchema } from "../../domain/workspace-sources/providers/confluence.js"
import { disableConfluenceSyncTarget } from "../../models/confluence-sync-target.js"

/**
 * ADR-050 migration: the merged Confluence scope of each Forge connection
 * (`confluence_spaces` of a live sync target) becomes a source entry in each
 * Workspace that links the old sync repository.
 */
export const confluenceSourceMigrationHook: SourceMigrationHook = {
  provider: "confluence",
  disableLegacy: disableConfluenceSyncTarget,
  legacyRepositoryUrl: async ({ orgId, connectionId }) => {
    const [row] = await withOrgDbContext(orgId, (db) =>
      db
        .select({ gitUrl: repositories.gitUrl })
        .from(confluenceSyncTargets)
        .innerJoin(
          repositories,
          eq(repositories.id, confluenceSyncTargets.repositoryId),
        )
        .where(eq(confluenceSyncTargets.connectionId, connectionId))
        .limit(1),
    )
    return row?.gitUrl ?? null
  },
  listLegacyBindings: ({ orgId }) =>
    withOrgDbContext(orgId, async (db) => {
      const targets = await db
        .select({
          connectionId: connections.id,
          enabled: confluenceSyncTargets.enabled,
          setupPhase: confluenceSyncTargets.setupPhase,
          gitUrl: repositories.gitUrl,
        })
        .from(connections)
        .leftJoin(
          confluenceSyncTargets,
          eq(confluenceSyncTargets.connectionId, connections.id),
        )
        .leftJoin(
          repositories,
          eq(repositories.id, confluenceSyncTargets.repositoryId),
        )
        .where(eq(connections.type, CONNECTION_TYPE_FORGE))
      const spaces = await db.select().from(confluenceSpaces)
      return targets.map((target): LegacySourceBinding => {
        const unmapped = (reason: string): LegacySourceBinding => ({
          provider: "confluence",
          connectionId: target.connectionId,
          unmapped: reason,
        })
        if (!target.gitUrl)
          return unmapped("The connection has no sync repository")
        if (!target.enabled)
          return unmapped("The connection sync is turned off")
        if (
          target.setupPhase !== "live" &&
          target.setupPhase !== "initial_sync"
        )
          return unmapped(
            "The Confluence scope is not merged into the sync repository yet",
          )
        const scope = confluenceSourceScopeSchema.safeParse({
          spaces: spaces
            .filter((space) => space.connectionId === target.connectionId)
            .sort((a, b) => a.spaceKey.localeCompare(b.spaceKey))
            .map((space) => ({
              key: space.spaceKey,
              pages: space.selectedPageIds?.length
                ? space.selectedPageIds
                : "all",
            })),
        })
        if (!scope.success)
          return unmapped(
            `The Confluence scope does not map to a source: ${scope.error.issues[0]?.message ?? "invalid"}`,
          )
        return {
          provider: "confluence",
          connectionId: target.connectionId,
          syncRepositoryUrl: target.gitUrl,
          scope: scope.data,
        }
      })
    }),
}
