import { and, eq, sql } from "drizzle-orm"
import type { Env } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  CONNECTION_TYPE_NOTION,
  connections,
} from "../../db/schema/connections.js"
import { repositories } from "../../db/schema/repositories.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { workspaces } from "../../db/schema/workspaces.js"
import type {
  LegacySourceBinding,
  SourceMigrationHook,
} from "../../domain/workspace-sources/migration-plan.js"
import {
  canonicalNotionId,
  type NotionSourceScope,
  notionSourceScopeSchema,
} from "../../domain/workspace-sources/providers/notion.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import { parseNotionConnectionConfig } from "../../lib/connection-config.js"
import { loadNotionScopeFromRepo } from "./config-from-repo.js"
import type { ParsedNotionRepoConfig } from "./config-yaml.js"

/**
 * Map the old `notion/config.yaml` scope to a source scope. Each selected
 * page and database becomes a root with its title.
 */
export function notionScopeFromLegacyConfig(
  config: ParsedNotionRepoConfig,
): { scope: NotionSourceScope } | { unmapped: string } {
  const roots = (type: "page" | "database") =>
    config.resources
      .filter((resource) => resource.type === type)
      .map((resource) => ({
        id: canonicalNotionId(resource.externalId) ?? resource.externalId,
        title: resource.title.trim() || "Untitled",
      }))
  const pages = roots("page")
  const databases = roots("database")
  const parsed = notionSourceScopeSchema.safeParse({
    ...(pages.length ? { pages } : {}),
    ...(databases.length ? { databases } : {}),
  })
  return parsed.success
    ? { scope: parsed.data }
    : {
        unmapped: `The Notion scope does not map to a source: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      }
}

/**
 * True when a Workspace on this repository has an `ok` Notion source
 * (ADR-050). Then only the Workspace sources sync writes `notion/`, and the
 * legacy binding of the repository must not write.
 */
export async function isNotionBindingHandedOver(input: {
  orgId: string
  repositoryGitUrl: string
}): Promise<boolean> {
  const target = normalizeWorkspaceRepositoryUrl(input.repositoryGitUrl)
  const rows = await withOrgDbContext(input.orgId, (db) =>
    db
      .selectDistinct({ url: workspaces.workspaceRepositoryUrl })
      .from(workspaceSources)
      .innerJoin(workspaces, eq(workspaces.id, workspaceSources.workspaceId))
      .where(
        and(
          eq(workspaceSources.orgId, input.orgId),
          eq(workspaceSources.provider, "notion"),
          eq(workspaceSources.status, "ok"),
        ),
      ),
  )
  return rows.some((row) => normalizeWorkspaceRepositoryUrl(row.url) === target)
}

/** Turn off the legacy binding of a connection (migration `--apply`). */
export async function disableNotionLegacySync(input: {
  orgId: string
  connectionId: string
}): Promise<void> {
  await withOrgDbContext(input.orgId, (db) =>
    db
      .update(connections)
      .set({
        config: sql`jsonb_set(${connections.config}, '{enabled}', 'false'::jsonb)`,
      })
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      ),
  )
}

/**
 * ADR-050 migration: the `notion/config.yaml` scope of each Notion
 * connection's sync repository becomes a source entry in each Workspace that
 * links that repository. `readScope` reads the old config file.
 */
export function createNotionSourceMigrationHook(
  readScope: (input: {
    orgId: string
    env: Env
    repositoryName: string
    githubConnectionId: string
    branch: string
  }) => Promise<ParsedNotionRepoConfig | undefined> = loadNotionScopeFromRepo,
): SourceMigrationHook {
  return {
    provider: "notion",
    disableLegacy: disableNotionLegacySync,
    async listLegacyBindings({ orgId, env }) {
      const rows = await withOrgDbContext(orgId, (db) =>
        db
          .select({
            connectionId: connections.id,
            config: connections.config,
            gitUrl: repositories.gitUrl,
            repositoryName: repositories.name,
            githubConnectionId: repositories.githubConnectionId,
          })
          .from(connections)
          .leftJoin(
            repositories,
            and(
              eq(repositories.orgId, connections.orgId),
              eq(repositories.id, sql`${connections.config}->>'repositoryId'`),
            ),
          )
          .where(eq(connections.type, CONNECTION_TYPE_NOTION)),
      )
      const bindings: LegacySourceBinding[] = []
      for (const row of rows) {
        const unmapped = (reason: string) =>
          bindings.push({
            provider: "notion",
            connectionId: row.connectionId,
            unmapped: reason,
          })
        const config = parseNotionConnectionConfig(
          row.config as Record<string, unknown>,
        )
        if (!row.gitUrl || !row.repositoryName || !config.branch) {
          unmapped("The connection has no sync repository")
          continue
        }
        if (!config.enabled) {
          unmapped("The connection sync is turned off")
          continue
        }
        if (
          !["initial_sync", "sync_failed", "live"].includes(config.setupPhase)
        ) {
          unmapped(
            "The Notion scope is not merged into the sync repository yet",
          )
          continue
        }
        if (!row.githubConnectionId) {
          unmapped("The sync repository has no GitHub connection")
          continue
        }
        const legacy = await readScope({
          orgId,
          env,
          repositoryName: row.repositoryName,
          githubConnectionId: row.githubConnectionId,
          branch: config.branch,
        })
        if (!legacy) {
          unmapped("The sync repository has no valid notion/config.yaml")
          continue
        }
        const mapped = notionScopeFromLegacyConfig(legacy)
        if ("unmapped" in mapped) {
          unmapped(mapped.unmapped)
          continue
        }
        bindings.push({
          provider: "notion",
          connectionId: row.connectionId,
          syncRepositoryUrl: row.gitUrl,
          scope: mapped.scope,
        })
      }
      return bindings
    },
  }
}

export const notionSourceMigrationHook = createNotionSourceMigrationHook()
