import { and, desc, eq, sql } from "drizzle-orm"
import type { Env } from "../config/env.js"
import {
  type Db,
  getOrgDb,
  getSystemDb,
  withOrgDbContext,
} from "../db/client.js"
import { withAmbientOrgDb } from "../db/org-sql.js"
import { organizations } from "../db/schema/auth.js"
import {
  CONNECTION_TYPE_NOTION,
  connections,
} from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import {
  encodeNotionTokensForDb,
  migrateLegacyNotionTokensForDb,
  type NotionSetupPhase,
  parseNotionConnectionConfig,
  serialiseNotionConnectionConfigForDb,
} from "../lib/connection-config.js"
import { generateObjectId } from "../lib/id.js"
import { log } from "../observability/logger.js"
import {
  deleteConnectionDirectory,
  getConnectionDirectoryByConnectionId,
  listConnectionDirectoryByNotionBotId,
  listConnectionDirectoryByNotionWorkspaceId,
  loadConnectionViaDirectory,
  upsertConnectionDirectory,
} from "./connection-directory.js"
import {
  type ConnectionRow,
  type NotionConnectionShape,
  notionConnectionToShape,
  notionShapeToConfig,
} from "./connection-rows.js"
import { listGithubConnectionsForOrg } from "./github-installation.js"
import { DEFAULT_CHECKOUT_KEY } from "./repositories.js"

function orgSql<T>(fn: () => Promise<T>): Promise<T> {
  return withAmbientOrgDb(fn)
}

export type { NotionSetupPhase } from "../lib/connection-config.js"

export type NotionConnection = NotionConnectionShape

/**
 * Notion scope entry. Scope now lives in git (`notion/config.yaml`), not in
 * Postgres, so this is a plain shape rather than a table row inference.
 */
export interface NotionResource {
  externalId: string
  type: "page" | "database"
  title: string
  url: string | null
  parentExternalId: string | null
}

/** Sync binding projected from `connections.config` (+ timestamps from the connection row). */
export type NotionBinding = {
  id: string
  orgId: string
  connectionId: string
  repositoryId: string
  branch: string
  enabled: boolean
  setupPhase: NotionSetupPhase
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  createdAt: Date
  updatedAt: Date
}

export type NotionBindingWithRepo = NotionBinding & {
  repositoryName: string
  githubConnectionId: string | null
}

/** Project a Notion sync binding from a connection row, or `undefined` when unbound. */
function bindingFromConnectionRow(
  row: ConnectionRow,
): NotionBinding | undefined {
  const config = parseNotionConnectionConfig(
    row.config as Record<string, unknown>,
  )
  if (!config.repositoryId || !config.branch) return undefined
  return {
    id: row.id,
    orgId: row.orgId,
    connectionId: row.id,
    repositoryId: config.repositoryId,
    branch: config.branch,
    enabled: config.enabled,
    setupPhase: config.setupPhase,
    pendingConfigPullUrl: config.pendingConfigPullUrl,
    pendingConfigPrCreating: config.pendingConfigPrCreating,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Merge a binding patch into the stored Notion connection config JSON. */
function mergeNotionStoredConfig(
  row: ConnectionRow,
  patch: Partial<{
    repositoryId: string | null
    branch: string | null
    enabled: boolean
    setupPhase: NotionSetupPhase
    pendingConfigPullUrl: string | null
    pendingConfigPrCreating: boolean
  }>,
): Record<string, unknown> {
  const stored = parseNotionConnectionConfig(
    row.config as Record<string, unknown>,
  )
  return serialiseNotionConnectionConfigForDb({
    ...stored,
    ...patch,
  })
}

/** Pure rebind rules for the Notion sync binding stored on `connections.config`. */
export function planNotionSyncBindingUpdate(input: {
  existing: NotionBinding | undefined
  repositoryId: string
  branch: string
  enabled: boolean
}): {
  changed: boolean
  repositoryOrBranchChanged: boolean
  resetLifecycle: boolean
} {
  const repositoryOrBranchChanged =
    !input.existing ||
    input.existing.repositoryId !== input.repositoryId ||
    input.existing.branch !== input.branch
  const changed =
    repositoryOrBranchChanged ||
    (input.existing?.enabled ?? true) !== input.enabled
  const resetLifecycle = !input.existing || repositoryOrBranchChanged
  return { changed, repositoryOrBranchChanged, resetLifecycle }
}

function notionConfigBotIdRef() {
  return sql<string>`${connections.config}->>'botId'`
}

async function migrateLegacyNotionTokensOnRead(
  db: Db,
  row: ConnectionRow,
  env: Env,
): Promise<void> {
  const stored = parseNotionConnectionConfig(
    row.config as Record<string, unknown>,
  )
  if (!stored.accessToken && !stored.refreshToken) return

  try {
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${row.id}, 0))`,
    )
    const [current] = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, row.id),
          eq(connections.orgId, row.orgId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    if (!current) return
    const config = migrateLegacyNotionTokensForDb(
      parseNotionConnectionConfig(current.config as Record<string, unknown>),
      env,
    )
    if (!config) return
    await db
      .update(connections)
      .set({ config, updatedAt: new Date() })
      .where(
        and(
          eq(connections.id, row.id),
          eq(connections.orgId, row.orgId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
  } catch (error) {
    log.warn({
      step: "notionConnection.migrateLegacyTokens",
      message: "Failed to migrate legacy Notion tokens on read",
      connectionId: row.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function notionConnectionRowToShape(
  db: Db,
  row: ConnectionRow,
  env: Env,
): Promise<NotionConnection> {
  const shape = notionConnectionToShape(row, env)
  await migrateLegacyNotionTokensOnRead(db, row, env)
  return shape
}

export async function listNotionConnectionsForOrg(
  orgId: string,
  env: Env,
): Promise<NotionConnection[]> {
  return orgSql(async () => {
    const db = getOrgDb()
    const rows = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.orgId, orgId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .orderBy(desc(connections.updatedAt))
    return Promise.all(
      rows.map((row) => notionConnectionRowToShape(db, row, env)),
    )
  })
}

export async function getNotionConnectionByConnectionId(
  orgId: string,
  connectionId: string,
  env: Env,
): Promise<NotionConnection | undefined> {
  return orgSql(async () => {
    const db = getOrgDb()
    const [row] = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.orgId, orgId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    return row ? notionConnectionRowToShape(db, row, env) : undefined
  })
}

export const MULTIPLE_NOTION_CONNECTIONS_MESSAGE =
  "Multiple Notion connections for this organization; specify connectionId query parameter"

export type ResolveNotionConnectionResult =
  | { status: "ok"; connection: NotionConnection }
  | { status: "none" }
  | { status: "ambiguous" }

export async function resolveNotionConnectionForOrgDetailed(
  orgId: string,
  env: Env,
  connectionId?: string | null,
): Promise<ResolveNotionConnectionResult> {
  if (connectionId) {
    const connection = await getNotionConnectionByConnectionId(
      orgId,
      connectionId,
      env,
    )
    return connection ? { status: "ok", connection } : { status: "none" }
  }
  const list = await listNotionConnectionsForOrg(orgId, env)
  if (list.length === 0) return { status: "none" }
  const [connection] = list
  if (list.length === 1 && connection) {
    return { status: "ok", connection }
  }
  return { status: "ambiguous" }
}

export async function resolveNotionConnectionForOrg(
  orgId: string,
  env: Env,
  connectionId?: string | null,
): Promise<NotionConnection | undefined> {
  const r = await resolveNotionConnectionForOrgDetailed(
    orgId,
    env,
    connectionId,
  )
  return r.status === "ok" ? r.connection : undefined
}

export async function upsertNotionConnectionFromOAuth(input: {
  orgId: string
  env: Env
  ownerUserId: string
  accessToken: string
  refreshToken?: string | null
  botId: string
  workspaceId?: string | null
  workspaceName?: string | null
  workspaceIcon?: string | null
}): Promise<NotionConnection> {
  const row = await orgSql(async () => {
    const db = getOrgDb()
    const [existing] = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
          eq(notionConfigBotIdRef(), input.botId),
        ),
      )
      .orderBy(desc(connections.updatedAt))
      .limit(1)

    const existingShape = existing
      ? notionConnectionToShape(existing, input.env)
      : undefined
    const config = notionShapeToConfig(
      {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken ?? null,
        botId: input.botId,
        workspaceId: input.workspaceId ?? null,
        workspaceName: input.workspaceName ?? null,
        workspaceIcon: input.workspaceIcon ?? null,
        ownerUserId: input.ownerUserId,
        status: "installed",
        lastEventPayload: null,
        // Preserve the sync binding when re-running OAuth for an existing connection.
        repositoryId: existingShape?.repositoryId ?? null,
        branch: existingShape?.branch ?? null,
        enabled: existingShape?.enabled ?? true,
        setupPhase: existingShape?.setupPhase ?? "draft",
        pendingConfigPullUrl: existingShape?.pendingConfigPullUrl ?? null,
        pendingConfigPrCreating:
          existingShape?.pendingConfigPrCreating ?? false,
      },
      input.env,
    )

    if (existing) {
      const [updated] = await db
        .update(connections)
        .set({ config, updatedAt: new Date() })
        .where(eq(connections.id, existing.id))
        .returning()
      if (!updated) throw new Error("Failed to update Notion connection")
      return updated
    }

    const [created] = await db
      .insert(connections)
      .values({
        id: generateObjectId("con"),
        orgId: input.orgId,
        type: CONNECTION_TYPE_NOTION,
        config,
      })
      .returning()
    if (!created) throw new Error("Failed to create Notion connection")
    return created
  })
  await upsertConnectionDirectory(row)
  return notionConnectionToShape(row, input.env)
}

export async function updateNotionConnectionTokens(input: {
  orgId: string
  connectionId: string
  accessToken: string
  refreshToken: string | null
  env: Env
}): Promise<void> {
  const updated = await orgSql(async () => {
    const db = getOrgDb()
    const [current] = await db
      .select({ config: connections.config })
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    if (!current) throw new Error("Notion connection not found")
    // Drop any legacy plaintext tokens; tokens are always persisted as ciphertext.
    const {
      accessToken: _legacyAccessToken,
      refreshToken: _legacyRefreshToken,
      ...rest
    } = current.config as Record<string, unknown>
    const config = serialiseNotionConnectionConfigForDb({
      ...rest,
      ...encodeNotionTokensForDb(
        {
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
        },
        input.env,
      ),
    })
    const [row] = await db
      .update(connections)
      .set({ config, updatedAt: new Date() })
      .where(eq(connections.id, input.connectionId))
      .returning()
    if (!row)
      throw new Error("Notion connection was removed during token update")
    return row
  })
  await upsertConnectionDirectory(updated)
}

export async function listNotionConnectionsForWebhook(input: {
  integrationId?: string | null
  workspaceId?: string | null
  env: Env
}): Promise<NotionConnection[]> {
  if (!input.workspaceId && !input.integrationId) return []

  const directoryRows = input.workspaceId
    ? await listConnectionDirectoryByNotionWorkspaceId(input.workspaceId)
    : await listConnectionDirectoryByNotionBotId(input.integrationId ?? "")
  const shapes = await Promise.all(
    directoryRows.map((directoryRow) =>
      withOrgDbContext(directoryRow.orgId, async () => {
        const db = getOrgDb()
        const [row] = await db
          .select()
          .from(connections)
          .where(
            and(
              eq(connections.id, directoryRow.connectionId),
              eq(connections.type, CONNECTION_TYPE_NOTION),
            ),
          )
          .limit(1)
        return row ? notionConnectionRowToShape(db, row, input.env) : undefined
      }),
    ),
  )
  return shapes.filter((row): row is NotionConnection => row !== undefined)
}

export async function deleteNotionConnectionById(
  orgId: string,
  connectionId: string,
): Promise<boolean> {
  const removed = await orgSql(async () => {
    const db = getOrgDb()
    const deleted = await db
      .delete(connections)
      .where(
        and(
          eq(connections.orgId, orgId),
          eq(connections.id, connectionId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .returning({ id: connections.id })
    return deleted.length > 0
  })
  if (removed) await deleteConnectionDirectory(connectionId)
  return removed
}

export async function getNotionBindingByConnectionId(
  connectionId: string,
): Promise<NotionBinding | undefined> {
  const row = await loadConnectionViaDirectory(connectionId)
  if (row?.type !== CONNECTION_TYPE_NOTION) return undefined
  return bindingFromConnectionRow(row)
}

export async function getNotionBindingWithRepoByConnectionId(
  orgId: string,
  connectionId: string,
): Promise<NotionBindingWithRepo | undefined> {
  return withOrgDbContext(orgId, async () => {
    const [row] = await getOrgDb()
      .select({
        connection: connections,
        repositoryName: repositories.name,
        githubConnectionId: repositories.githubConnectionId,
      })
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
          eq(connections.id, connectionId),
          eq(connections.orgId, orgId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
          eq(repositories.orgId, orgId),
        ),
      )
      .limit(1)
    if (!row) return undefined
    const binding = bindingFromConnectionRow(row.connection)
    if (!binding) return undefined
    return {
      ...binding,
      repositoryName: row.repositoryName,
      githubConnectionId: row.githubConnectionId,
    }
  })
}

export async function listNotionBindingsWithRepoByRepositoryId(
  orgId: string,
  repositoryId: string,
): Promise<NotionBindingWithRepo[]> {
  return withOrgDbContext(orgId, async () => {
    const rows = await getOrgDb()
      .select({
        connection: connections,
        repositoryName: repositories.name,
        githubConnectionId: repositories.githubConnectionId,
      })
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
          eq(connections.type, CONNECTION_TYPE_NOTION),
          eq(sql`${connections.config}->>'repositoryId'`, repositoryId),
        ),
      )
    return rows.flatMap((row) => {
      const binding = bindingFromConnectionRow(row.connection)
      if (!binding) return []
      return [
        {
          ...binding,
          repositoryName: row.repositoryName,
          githubConnectionId: row.githubConnectionId,
        },
      ]
    })
  })
}

export async function claimNotionConfigPrCreation(input: {
  connectionId: string
}): Promise<
  | {
      pendingConfigPullUrl: string | null
      setupPhase: NotionSetupPhase
    }
  | undefined
> {
  const directoryRow = await getConnectionDirectoryByConnectionId(
    input.connectionId,
  )
  if (!directoryRow) return undefined
  const claimed = await withOrgDbContext(directoryRow.orgId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    if (!row) return
    const binding = bindingFromConnectionRow(row)
    if (!binding) return
    const [updated] = await tx
      .update(connections)
      .set({
        config: mergeNotionStoredConfig(row, {
          setupPhase: "awaiting_merge",
          pendingConfigPrCreating: true,
        }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
          sql`coalesce((${connections.config}->>'pendingConfigPrCreating')::boolean, false) = false`,
        ),
      )
      .returning()
    if (!updated) return
    return {
      row: updated,
      pendingConfigPullUrl: binding.pendingConfigPullUrl,
      setupPhase: binding.setupPhase,
    }
  })
  if (!claimed) return undefined
  await upsertConnectionDirectory(claimed.row)
  return {
    pendingConfigPullUrl: claimed.pendingConfigPullUrl,
    setupPhase: claimed.setupPhase,
  }
}

export async function releaseNotionConfigPrCreationClaim(input: {
  connectionId: string
  previousState: {
    pendingConfigPullUrl: string | null
    setupPhase: NotionSetupPhase
  }
}): Promise<void> {
  const directoryRow = await getConnectionDirectoryByConnectionId(
    input.connectionId,
  )
  if (!directoryRow) return
  const updated = await withOrgDbContext(directoryRow.orgId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    const binding = row ? bindingFromConnectionRow(row) : undefined
    if (
      !row ||
      !binding ||
      binding.setupPhase !== "awaiting_merge" ||
      !binding.pendingConfigPrCreating
    ) {
      return
    }
    const [result] = await tx
      .update(connections)
      .set({
        config: mergeNotionStoredConfig(row, {
          pendingConfigPullUrl: input.previousState.pendingConfigPullUrl,
          pendingConfigPrCreating: false,
          setupPhase: input.previousState.setupPhase,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
      .returning()
    if (!result)
      throw new Error("Notion connection was removed during claim release")
    return result
  })
  if (updated) await upsertConnectionDirectory(updated)
}

export async function transitionNotionBindingState(input: {
  connectionId: string
  expectedSetupPhase: NotionSetupPhase
  expectedPendingConfigPrCreating: boolean
  repositoryId: string
  branch: string
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  setupPhase: NotionSetupPhase
}): Promise<boolean> {
  const directoryRow = await getConnectionDirectoryByConnectionId(
    input.connectionId,
  )
  if (!directoryRow) return false
  const updated = await withOrgDbContext(directoryRow.orgId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    const binding = row ? bindingFromConnectionRow(row) : undefined
    if (
      !row ||
      !binding ||
      !binding.enabled ||
      binding.repositoryId !== input.repositoryId ||
      binding.branch !== input.branch ||
      binding.setupPhase !== input.expectedSetupPhase ||
      binding.pendingConfigPrCreating !== input.expectedPendingConfigPrCreating
    ) {
      return
    }
    const [result] = await tx
      .update(connections)
      .set({
        config: mergeNotionStoredConfig(row, {
          pendingConfigPullUrl: input.pendingConfigPullUrl,
          pendingConfigPrCreating: input.pendingConfigPrCreating,
          setupPhase: input.setupPhase,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
      .returning()
    return result
  })
  if (!updated) return false
  await upsertConnectionDirectory(updated)
  return true
}

/** CAS into initial_sync only while the binding still matches the activating push. */
export async function claimNotionBindingInitialSync(input: {
  connectionId: string
  repositoryId: string
  branch: string
}): Promise<boolean> {
  const directoryRow = await getConnectionDirectoryByConnectionId(
    input.connectionId,
  )
  if (!directoryRow) return false
  const updated = await withOrgDbContext(directoryRow.orgId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    const binding = row ? bindingFromConnectionRow(row) : undefined
    if (
      !row ||
      !binding ||
      !binding.enabled ||
      binding.repositoryId !== input.repositoryId ||
      binding.branch !== input.branch ||
      !(
        binding.setupPhase === "awaiting_merge" ||
        binding.setupPhase === "sync_failed" ||
        binding.setupPhase === "live"
      )
    ) {
      return
    }
    const [result] = await tx
      .update(connections)
      .set({
        config: mergeNotionStoredConfig(row, {
          setupPhase: "initial_sync",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
      .returning()
    return result
  })
  if (!updated) return false
  await upsertConnectionDirectory(updated)
  return true
}

export async function claimNotionContentSyncRetry(
  connectionId: string,
): Promise<boolean> {
  const directoryRow = await getConnectionDirectoryByConnectionId(connectionId)
  if (!directoryRow) return false
  const updated = await withOrgDbContext(directoryRow.orgId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    const binding = row ? bindingFromConnectionRow(row) : undefined
    if (
      !row ||
      !binding ||
      !binding.enabled ||
      binding.setupPhase !== "sync_failed"
    ) {
      return
    }
    const [result] = await tx
      .update(connections)
      .set({
        config: mergeNotionStoredConfig(row, {
          setupPhase: "initial_sync",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, connectionId))
      .returning()
    return result
  })
  if (!updated) return false
  await upsertConnectionDirectory(updated)
  return true
}

export async function resetNotionConnectorAfterMissingConfig(input: {
  orgId: string
  connectionId: string
}): Promise<void> {
  const updated = await withOrgDbContext(input.orgId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    if (!row) return
    const [result] = await tx
      .update(connections)
      .set({
        config: mergeNotionStoredConfig(row, {
          setupPhase: "draft",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          enabled: false,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
      .returning()
    if (!result) throw new Error("Notion connection was removed during reset")
    return result
  })
  if (updated) await upsertConnectionDirectory(updated)
}

/** Clear Notion sync bindings that point at a repository about to be deleted. */
export async function clearNotionSyncBindingsForRepository(input: {
  orgId: string
  repositoryId: string
}): Promise<number> {
  const updatedRows = await orgSql(async () => {
    const tx = getOrgDb()
    const ids = await tx
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
          eq(sql`${connections.config}->>'repositoryId'`, input.repositoryId),
        ),
      )
    const rows: ConnectionRow[] = []
    for (const { id } of ids) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`,
      )
      const [row] = await tx
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.id, id),
            eq(connections.orgId, input.orgId),
            eq(connections.type, CONNECTION_TYPE_NOTION),
            eq(sql`${connections.config}->>'repositoryId'`, input.repositoryId),
          ),
        )
        .limit(1)
      if (!row) continue
      const [updated] = await tx
        .update(connections)
        .set({
          config: mergeNotionStoredConfig(row, {
            repositoryId: null,
            branch: null,
            enabled: false,
            setupPhase: "draft",
            pendingConfigPullUrl: null,
            pendingConfigPrCreating: false,
          }),
          updatedAt: new Date(),
        })
        .where(eq(connections.id, id))
        .returning()
      if (updated) rows.push(updated)
    }
    return rows
  })
  await Promise.all(updatedRows.map((row) => upsertConnectionDirectory(row)))
  return updatedRows.length
}

export async function finalizeNotionBindingAfterContentWorkflow(input: {
  connectionId: string
  workflowStatus: "completed" | "partial_failed" | "failed"
}): Promise<boolean> {
  const directoryRow = await getConnectionDirectoryByConnectionId(
    input.connectionId,
  )
  if (!directoryRow) return false
  const updated = await withOrgDbContext(directoryRow.orgId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    const binding = row ? bindingFromConnectionRow(row) : undefined
    if (!row || !binding || binding.setupPhase !== "initial_sync") return
    const [result] = await tx
      .update(connections)
      .set({
        config: mergeNotionStoredConfig(row, {
          setupPhase:
            input.workflowStatus === "completed" ? "live" : "sync_failed",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
      .returning()
    return result
  })
  if (!updated) return false
  await upsertConnectionDirectory(updated)
  return true
}

type BindingPatchInput = {
  repositoryId?: string
  repositoryName?: string
  gitUrl?: string
  githubConnectionId?: string
  branch: string
  enabled: boolean
}

async function resolveRepositoryIdForNotionSync(
  tx: Db,
  orgId: string,
  sync: BindingPatchInput,
  githubConnectionId: string | undefined,
): Promise<{ repositoryId: string; didCreate: boolean }> {
  if (sync.repositoryId) {
    const [byId] = await tx
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.id, sync.repositoryId),
          eq(repositories.orgId, orgId),
        ),
      )
      .limit(1)
    if (byId) return { repositoryId: byId.id, didCreate: false }
  }

  const gitUrl = sync.gitUrl
  const name = sync.repositoryName
  if (!gitUrl || !name) {
    throw new Error("Repository not found for organization")
  }
  if (!githubConnectionId) {
    throw new Error("GitHub connection is required for a new repository")
  }

  const [byUrl] = await tx
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.orgId, orgId), eq(repositories.gitUrl, gitUrl)))
    .limit(1)
  if (byUrl) return { repositoryId: byUrl.id, didCreate: false }

  const id = generateObjectId("repo")
  const checkoutId = generateObjectId("co")
  const [created] = await tx
    .insert(repositories)
    .values({
      id,
      orgId,
      name,
      gitUrl,
      githubConnectionId,
    })
    .returning({ id: repositories.id })
  if (!created) throw new Error("Failed to create repository")

  const [checkout] = await tx
    .insert(repositoryCheckouts)
    .values({
      id: checkoutId,
      orgId,
      repositoryId: id,
      ref: "main",
      checkoutKey: DEFAULT_CHECKOUT_KEY,
    })
    .returning({ id: repositoryCheckouts.id })
  if (!checkout) throw new Error("Failed to create repository checkout")

  return { repositoryId: id, didCreate: true }
}

/**
 * Persist the repository binding (repo/branch/enabled) on `connections.config`.
 * Scope selection is git-native and is no longer stored in Postgres, so this
 * only ever touches the connection row. `bindingChanged` reports whether the
 * binding actually changed.
 */
export async function patchNotionConnectorConfig(input: {
  orgId: string
  connectionId: string
  syncTarget?: BindingPatchInput
}): Promise<{
  bindingChanged: boolean
  repositoryIngestion?: {
    orgId: string
    repositoryId: string
    targetBranch?: string
  }
}> {
  if (input.syncTarget === undefined) {
    return { bindingChanged: false }
  }
  const syncTarget = input.syncTarget

  const githubConnections = await listGithubConnectionsForOrg(input.orgId)
  const requestedGithubConnectionId = syncTarget.githubConnectionId
  if (
    requestedGithubConnectionId &&
    !githubConnections.some(
      (connection) => connection.id === requestedGithubConnectionId,
    )
  ) {
    throw new Error("GitHub connection not found for organization")
  }
  const githubConnectionId =
    requestedGithubConnectionId ??
    (githubConnections.length === 1 ? githubConnections[0]?.id : undefined)

  const result = await withOrgDbContext(input.orgId, async (tx) => {
    let repositoryIngestion:
      | {
          orgId: string
          repositoryId: string
          targetBranch?: string
        }
      | undefined

    const { repositoryId, didCreate } = await resolveRepositoryIdForNotionSync(
      tx,
      input.orgId,
      syncTarget,
      githubConnectionId,
    )
    if (didCreate) {
      repositoryIngestion = {
        orgId: input.orgId,
        repositoryId,
        targetBranch: syncTarget.branch,
      }
    }

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [connectionRow] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    if (!connectionRow) {
      throw new Error("Notion connection does not belong to organization")
    }
    const existingTarget = bindingFromConnectionRow(connectionRow)
    const plan = planNotionSyncBindingUpdate({
      existing: existingTarget,
      repositoryId,
      branch: syncTarget.branch,
      enabled: syncTarget.enabled,
    })

    let updated: ConnectionRow | undefined
    if (plan.changed) {
      const [row] = await tx
        .update(connections)
        .set({
          config: mergeNotionStoredConfig(connectionRow, {
            repositoryId,
            branch: syncTarget.branch,
            enabled: syncTarget.enabled,
            ...(plan.resetLifecycle
              ? {
                  setupPhase: "draft" as const,
                  pendingConfigPullUrl: null,
                  pendingConfigPrCreating: false,
                }
              : {}),
          }),
          updatedAt: new Date(),
        })
        .where(eq(connections.id, input.connectionId))
        .returning()
      if (!row) throw new Error("Notion connection was removed during patch")
      updated = row
    }

    return {
      bindingChanged: plan.changed,
      repositoryIngestion,
      updated,
    }
  })
  if (result.updated) await upsertConnectionDirectory(result.updated)
  return {
    bindingChanged: result.bindingChanged,
    repositoryIngestion: result.repositoryIngestion,
  }
}

export async function getOrganizationSlugForNotionOrgId(
  orgId: string,
): Promise<string | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  return row?.slug
}
