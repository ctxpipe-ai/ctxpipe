import { and, eq, sql } from "drizzle-orm"
import type { Env } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  CONNECTION_TYPE_PAGERDUTY,
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
  type PagerdutySourceScope,
  pagerdutySourceScopeSchema,
} from "../../domain/workspace-sources/providers/pagerduty.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import { parsePagerdutyConnectionStored } from "../../lib/connection-config.js"
import { log } from "../../observability/logger.js"
import { loadPagerdutyScopeFromRepo } from "./config-from-repo.js"
import type { ParsedPagerdutyRepoConfig } from "./config-yaml.js"

/**
 * Map the old `pagerduty/config.yaml` scope to a source scope: the selected
 * service ids. The incidents that the old mirror wrote stay in
 * `pagerduty/incidents/`; the source writes new copies under
 * `pagerduty/services/<serviceId>/incidents/`.
 */
export function pagerdutyScopeFromLegacyConfig(
  config: ParsedPagerdutyRepoConfig,
): { scope: PagerdutySourceScope } | { unmapped: string } {
  const parsed = pagerdutySourceScopeSchema.safeParse({
    services: config.services.map((service) => service.id),
  })
  return parsed.success
    ? { scope: parsed.data }
    : {
        unmapped: `The PagerDuty scope does not map to a source: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      }
}

type HandoverInput = {
  orgId: string
  connectionId: string
  repositoryGitUrl: string
}

/**
 * True when a Workspace on this repository has an `ok` source of the same
 * PagerDuty connection (ADR-050). Then only the Workspace sources sync
 * writes PagerDuty content there, and the legacy binding must not write.
 */
export async function isPagerdutyBindingHandedOver(
  input: HandoverInput,
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
          eq(workspaceSources.provider, "pagerduty"),
          eq(workspaceSources.connectionId, input.connectionId),
          eq(workspaceSources.status, "ok"),
        ),
      ),
  )
  return rows.some((row) => normalizeWorkspaceRepositoryUrl(row.url) === target)
}

/**
 * The legacy sync gate. A failed lookup logs a warning and lets the legacy
 * sync run, so a database problem never stops the mirror.
 */
export async function pagerdutyLegacyHandedOver(
  input: HandoverInput,
  check: (
    input: HandoverInput,
  ) => Promise<boolean> = isPagerdutyBindingHandedOver,
): Promise<boolean> {
  try {
    return await check(input)
  } catch (error) {
    log.warn({
      step: "pagerduty.legacy.handover_check",
      connectionId: input.connectionId,
      message: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/** Turn off the legacy binding of a connection (migration `--apply`). */
export async function disablePagerdutyLegacySync(input: {
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
          eq(connections.type, CONNECTION_TYPE_PAGERDUTY),
        ),
      ),
  )
}

/**
 * ADR-050 migration: the live `pagerduty/config.yaml` scope of each
 * PagerDuty connection's sync repository becomes a source entry in each
 * Workspace that links that repository. `readScope` reads the old file.
 * The migration does not move or delete the old `pagerduty/incidents/`
 * files.
 */
export function createPagerdutySourceMigrationHook(
  readScope: (input: {
    orgId: string
    env: Env
    repositoryName: string
    githubConnectionId: string
    branch: string
  }) => Promise<
    ParsedPagerdutyRepoConfig | undefined
  > = loadPagerdutyScopeFromRepo,
): SourceMigrationHook {
  return {
    provider: "pagerduty",
    disableLegacy: disablePagerdutyLegacySync,
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
          .where(eq(connections.type, CONNECTION_TYPE_PAGERDUTY)),
      )
      const bindings: LegacySourceBinding[] = []
      for (const row of rows) {
        const unmapped = (reason: string) =>
          bindings.push({
            provider: "pagerduty",
            connectionId: row.connectionId,
            unmapped: reason,
          })
        const parsed = (() => {
          try {
            return parsePagerdutyConnectionStored(
              row.config as Record<string, unknown>,
            )
          } catch {
            return null
          }
        })()
        if (!parsed) {
          unmapped("The connection has no complete PagerDuty account")
          continue
        }
        if (!row.gitUrl || !row.repositoryName || !parsed.branch) {
          unmapped("The connection has no sync repository")
          continue
        }
        if (!parsed.enabled) {
          unmapped("The connection sync is turned off")
          continue
        }
        if (
          !["initial_sync", "sync_failed", "live"].includes(parsed.setupPhase)
        ) {
          unmapped(
            "The PagerDuty scope is not merged into the sync repository yet",
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
          branch: parsed.branch,
        })
        if (!legacy) {
          unmapped("The sync repository has no valid pagerduty/config.yaml")
          continue
        }
        const mapped = pagerdutyScopeFromLegacyConfig(legacy)
        if ("unmapped" in mapped) {
          unmapped(mapped.unmapped)
          continue
        }
        bindings.push({
          provider: "pagerduty",
          connectionId: row.connectionId,
          syncRepositoryUrl: row.gitUrl,
          scope: mapped.scope,
        })
      }
      return bindings
    },
  }
}

export const pagerdutySourceMigrationHook = createPagerdutySourceMigrationHook()
