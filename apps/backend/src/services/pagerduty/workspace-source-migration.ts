import { and, eq, sql } from "drizzle-orm"
import { parse as parseYaml } from "yaml"
import type { Env } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  CONNECTION_TYPE_PAGERDUTY,
  connections,
} from "../../db/schema/connections.js"
import { repositories } from "../../db/schema/repositories.js"
import { configBoundRepositoryUrl } from "../../domain/workspace-sources/legacy-handover.js"
import { parseLegacyScope } from "../../domain/workspace-sources/legacy-scope.js"
import type {
  LegacySourceBinding,
  SourceMigrationHook,
} from "../../domain/workspace-sources/migration-plan.js"
import {
  type PagerdutySourceScope,
  pagerdutyServiceIdSchema,
  pagerdutySourceScopeSchema,
} from "../../domain/workspace-sources/providers/pagerduty.js"
import { parsePagerdutyConnectionStored } from "../../lib/connection-config.js"
import { loadPagerdutyScopeFromRepo } from "./config-from-repo.js"
import type { ParsedPagerdutyRepoConfig } from "./config-yaml.js"
import { pagerdutyServiceIncidentsRoot } from "./converter.js"

/**
 * Map the old `pagerduty/config.yaml` scope to a source scope: the selected
 * service ids. The source writes under
 * `pagerduty/services/<serviceId>/incidents/`.
 */
export function pagerdutyScopeFromLegacyConfig(
  config: ParsedPagerdutyRepoConfig,
): { scope: PagerdutySourceScope } | { unmapped: string } {
  const parsed = parseLegacyScope(pagerdutySourceScopeSchema, {
    services: config.services.map((service) => service.id),
  })
  return parsed.success
    ? { scope: parsed.data }
    : {
        unmapped: `The PagerDuty scope does not map to a source: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      }
}

/** The service id in the front matter of an incident file, or null. */
function frontMatterServiceId(markdown: string): string | null {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(markdown)
  if (!match?.[1]) return null
  let front: unknown
  try {
    front = parseYaml(match[1])
  } catch {
    return null
  }
  const id = pagerdutyServiceIdSchema.safeParse(
    (front as { service_id?: unknown } | null)?.service_id,
  )
  return id.success ? id.data : null
}

/**
 * The moves of the old mirror files (ADR-034): each
 * `pagerduty/incidents/<number>--<id>.md` and its asset folder go to
 * `pagerduty/services/<service_id>/incidents/`, by blob sha. Only the
 * incident Markdown is read, for its `service_id` front matter. A file
 * without a readable service id stays where it is.
 */
export async function planPagerdutyLegacyMoves(input: {
  files: ReadonlyArray<{ path: string; sha: string }>
  read: (path: string) => Promise<string | null | undefined>
}): Promise<Array<{ from: string; to: string; sha: string }>> {
  const moves: Array<{ from: string; to: string; sha: string }> = []
  for (const file of input.files) {
    const stem = /^pagerduty\/incidents\/([^/]+)\.md$/.exec(file.path)?.[1]
    if (!stem) continue
    const serviceId = frontMatterServiceId((await input.read(file.path)) ?? "")
    if (!serviceId) continue
    const root = pagerdutyServiceIncidentsRoot(serviceId)
    moves.push({ from: file.path, to: `${root}${stem}.md`, sha: file.sha })
    const assets = `pagerduty/incidents/${stem}/`
    for (const asset of input.files)
      if (asset.path.startsWith(assets))
        moves.push({
          from: asset.path,
          to: `${root}${stem}/${asset.path.slice(assets.length)}`,
          sha: asset.sha,
        })
  }
  return moves
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
 * In a Workspace whose repository is that sync repository, the migration
 * commit moves the old `pagerduty/incidents/` files into their service
 * folders (see {@link planPagerdutyLegacyMoves}).
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
    legacyRepositoryUrl: configBoundRepositoryUrl,
    legacyMoves: planPagerdutyLegacyMoves,
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
