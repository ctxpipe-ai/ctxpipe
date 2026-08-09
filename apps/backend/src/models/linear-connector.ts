import { and, asc, desc, eq, isNull, sql } from "drizzle-orm"
import type { Env } from "../config/env.js"
import type { Db } from "../db/client.js"
import { getOrgDb, getSystemDb, withOrgDbContext } from "../db/client.js"
import {
  CONNECTION_TYPE_LINEAR,
  connections,
} from "../db/schema/connections.js"
import {
  type LinearDirtyEntityType,
  linearDirtyEntities,
} from "../db/schema/linearDirtyEntities.js"
import {
  type LinearScopeResourceType,
  linearScopes,
} from "../db/schema/linearScopes.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import {
  type LinearSetupPhase,
  parseLinearConnectionStored,
  serialiseLinearConnectionConfigForDb,
} from "../lib/connection-config.js"
import { generateObjectId } from "../lib/id.js"
import type { ParsedLinearRepoConfig } from "../services/linear/config-yaml.js"
import {
  type ConnectionRow,
  type LinearConnectionShape,
  linearConnectionToShape,
  linearShapeToConfig,
} from "./connection-rows.js"
import { listGithubConnectionsForOrg } from "./github-installation.js"
import { DEFAULT_CHECKOUT_KEY } from "./repositories.js"

export type { LinearSetupPhase } from "../lib/connection-config.js"

export type LinearConnection = LinearConnectionShape
export type LinearScope = typeof linearScopes.$inferSelect
/** Sync binding projected from `connections.config` (+ timestamps from the connection row). */
export type LinearSyncTarget = {
  id: string
  orgId: string
  connectionId: string
  repositoryId: string
  branch: string
  enabled: boolean
  setupPhase: LinearSetupPhase
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  createdAt: Date
  updatedAt: Date
}
export type LinearDirtyEntity = typeof linearDirtyEntities.$inferSelect

export type LinearSyncTargetWithRepo = LinearSyncTarget & {
  repositoryName: string
  githubConnectionId: string | null
}

function syncTargetFromConnectionRow(
  row: ConnectionRow,
): LinearSyncTarget | undefined {
  const config = parseLinearConnectionStored(
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

function mergeLinearStoredConfig(
  row: ConnectionRow,
  patch: Partial<{
    repositoryId: string | null
    branch: string | null
    enabled: boolean
    setupPhase: LinearSetupPhase
    pendingConfigPullUrl: string | null
    pendingConfigPrCreating: boolean
  }>,
): Record<string, unknown> {
  const stored = parseLinearConnectionStored(
    row.config as Record<string, unknown>,
  )
  return serialiseLinearConnectionConfigForDb({
    ...stored,
    ...patch,
  })
}

export class LinearConfigPrCreationInProgressError extends Error {
  constructor() {
    super("A Linear configuration pull request is already being created")
    this.name = "LinearConfigPrCreationInProgressError"
  }
}

function linearConfigWorkspaceIdRef() {
  return sql<string>`${connections.config}->>'workspaceId'`
}

export async function listLinearConnectionsForOrg(
  orgId: string,
  env: Env,
): Promise<LinearConnection[]> {
  const db = getOrgDb()
  const rows = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.orgId, orgId),
        eq(connections.type, CONNECTION_TYPE_LINEAR),
      ),
    )
    .orderBy(desc(connections.updatedAt))
  return rows.map((row) => linearConnectionToShape(row, env))
}

export async function getLinearConnectionByConnectionId(
  orgId: string,
  connectionId: string,
  env: Env,
): Promise<LinearConnection | undefined> {
  const db = getOrgDb()
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.orgId, orgId),
        eq(connections.type, CONNECTION_TYPE_LINEAR),
      ),
    )
    .limit(1)
  return row ? linearConnectionToShape(row, env) : undefined
}

export const MULTIPLE_LINEAR_CONNECTIONS_MESSAGE =
  "Multiple Linear connections for this organization; specify connectionId query parameter"

export type ResolveLinearConnectionResult =
  | { status: "ok"; connection: LinearConnection }
  | { status: "none" }
  | { status: "ambiguous" }

export async function resolveLinearConnectionForOrgDetailed(
  orgId: string,
  env: Env,
  connectionId?: string | null,
): Promise<ResolveLinearConnectionResult> {
  if (connectionId) {
    const connection = await getLinearConnectionByConnectionId(
      orgId,
      connectionId,
      env,
    )
    return connection ? { status: "ok", connection } : { status: "none" }
  }
  const connectionsForOrg = await listLinearConnectionsForOrg(orgId, env)
  if (connectionsForOrg.length === 0) return { status: "none" }
  const [connection] = connectionsForOrg
  if (connectionsForOrg.length === 1 && connection) {
    return { status: "ok", connection }
  }
  return { status: "ambiguous" }
}

export async function upsertLinearConnectionFromOAuth(input: {
  orgId: string
  env: Env
  ownerUserId: string
  accessToken: string
  refreshToken: string | null
  accessTokenExpiresAt: string | null
  workspaceId: string
  workspaceName: string
  workspaceUrlKey: string | null
  actorUserId: string | null
}): Promise<LinearConnection> {
  const db = getOrgDb()
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${input.orgId}:${input.workspaceId}`}, 0))`,
    )
    const [matched] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_LINEAR),
          eq(linearConfigWorkspaceIdRef(), input.workspaceId),
        ),
      )
      .orderBy(desc(connections.updatedAt))
      .limit(1)
    let existing = matched
    if (existing) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${existing.id}, 0))`,
      )
      const [latestExisting] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, existing.id))
        .limit(1)
      existing = latestExisting
    }

    const existingShape = existing
      ? linearConnectionToShape(existing, input.env)
      : undefined
    const config = linearShapeToConfig(
      {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        workspaceId: input.workspaceId,
        workspaceName: input.workspaceName,
        workspaceUrlKey: input.workspaceUrlKey,
        actorUserId: input.actorUserId,
        ownerUserId: input.ownerUserId,
        status: "installed",
        lastEventPayload:
          existingShape?.lastEventPayload !== undefined
            ? existingShape.lastEventPayload
            : null,
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

    if (!existing) {
      const [row] = await tx
        .insert(connections)
        .values({
          id: generateObjectId("con"),
          orgId: input.orgId,
          type: CONNECTION_TYPE_LINEAR,
          config,
        })
        .returning()
      if (!row) throw new Error("Failed to create Linear connection")
      return linearConnectionToShape(row, input.env)
    }

    const [row] = await tx
      .update(connections)
      .set({ config, updatedAt: new Date() })
      .where(eq(connections.id, existing.id))
      .returning()
    if (!row) throw new Error("Failed to update Linear connection")
    return linearConnectionToShape(row, input.env)
  })
}

export async function refreshLinearConnectionTokensWithLock(input: {
  orgId: string
  connectionId: string
  env: Env
  expectedRefreshToken: string
  expectedAccessToken: string
  refresh: (refreshToken: string) => Promise<{
    accessToken: string
    refreshToken: string | null
    accessTokenExpiresAt: string | null
  }>
}): Promise<{
  accessToken: string
  refreshToken: string | null
  accessTokenExpiresAt: string | null
}> {
  const db = getOrgDb()
  return db.transaction(async (tx) => {
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
          eq(connections.type, CONNECTION_TYPE_LINEAR),
        ),
      )
      .limit(1)
    if (!row) throw new Error("Linear connection not found")
    const current = linearConnectionToShape(row, input.env)
    if (
      current.accessToken !== input.expectedAccessToken ||
      (current.refreshToken &&
        current.refreshToken !== input.expectedRefreshToken)
    ) {
      return {
        accessToken: current.accessToken,
        refreshToken: current.refreshToken,
        accessTokenExpiresAt: current.accessTokenExpiresAt,
      }
    }
    if (!current.refreshToken) {
      throw new Error("Linear connection has no refresh token")
    }
    const refreshed = await input.refresh(current.refreshToken)
    const config = linearShapeToConfig(
      {
        ...current,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
      },
      input.env,
    )
    const [updated] = await tx
      .update(connections)
      .set({ config, updatedAt: new Date() })
      .where(eq(connections.id, input.connectionId))
      .returning({ id: connections.id })
    if (updated) return refreshed
    throw new Error("Linear connection was removed during token refresh")
  })
}

export async function getLinearConnectionForWebhook(
  connectionId: string,
  env: Env,
): Promise<LinearConnection | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.type, CONNECTION_TYPE_LINEAR),
      ),
    )
    .limit(1)
  return row ? linearConnectionToShape(row, env) : undefined
}

export async function listLinearConnectionsByWorkspaceId(
  workspaceId: string,
  env: Env,
): Promise<LinearConnection[]> {
  const db = getSystemDb()
  const rows = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.type, CONNECTION_TYPE_LINEAR),
        eq(sql<string>`${connections.config}->>'workspaceId'`, workspaceId),
      ),
    )
  return rows.map((row) => linearConnectionToShape(row, env))
}

export async function recordLinearOAuthRevocation(input: {
  connectionId: string
  env: Env
  payload: unknown
}): Promise<void> {
  const db = getSystemDb()
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_LINEAR),
        ),
      )
      .limit(1)
    if (!row) return
    const current = linearConnectionToShape(row, input.env)
    await tx
      .update(connections)
      .set({
        config: linearShapeToConfig(
          {
            ...current,
            status: "revoked",
            lastEventPayload: input.payload,
          },
          input.env,
        ),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
  })
}

export async function deleteLinearConnectionById(
  orgId: string,
  connectionId: string,
): Promise<boolean> {
  const db = getOrgDb()
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${connectionId}, 0))`,
    )
    const removed = await tx
      .delete(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.orgId, orgId),
          eq(connections.type, CONNECTION_TYPE_LINEAR),
        ),
      )
      .returning({ id: connections.id })
    return removed.length > 0
  })
}

export async function listLinearScopesByConnectionId(
  connectionId: string,
): Promise<LinearScope[]> {
  const db = getOrgDb()
  return db
    .select()
    .from(linearScopes)
    .where(eq(linearScopes.connectionId, connectionId))
    .orderBy(asc(linearScopes.type), asc(linearScopes.title))
}

export async function getLinearSyncTargetWithRepoByConnectionId(
  orgId: string,
  connectionId: string,
): Promise<LinearSyncTargetWithRepo | undefined> {
  const db = getSystemDb()
  const [row] = await db
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
        eq(
          repositories.id,
          sql`${connections.config}->>'repositoryId'`,
        ),
      ),
    )
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.orgId, orgId),
        eq(connections.type, CONNECTION_TYPE_LINEAR),
        eq(repositories.orgId, orgId),
      ),
    )
    .limit(1)
  if (!row) return undefined
  const target = syncTargetFromConnectionRow(row.connection)
  if (!target) return undefined
  return {
    ...target,
    repositoryName: row.repositoryName,
    githubConnectionId: row.githubConnectionId,
  }
}

export async function withLinearSyncTargetSnapshot<T>(
  input: {
    connectionId: string
    repositoryId: string
    branch: string
    setupPhase: "initial_sync" | "live"
  },
  operation: () => Promise<T>,
): Promise<T> {
  const db = getSystemDb()
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_LINEAR),
        ),
      )
      .limit(1)
    const target = row ? syncTargetFromConnectionRow(row) : undefined
    if (
      !target ||
      target.repositoryId !== input.repositoryId ||
      target.branch !== input.branch ||
      !target.enabled ||
      target.setupPhase !== input.setupPhase
    ) {
      throw new Error(
        "Linear sync target changed while content was being built",
      )
    }
    return operation()
  })
}

export async function getLinearSyncTargetByConnectionId(
  connectionId: string,
): Promise<LinearSyncTarget | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.type, CONNECTION_TYPE_LINEAR),
      ),
    )
    .limit(1)
  return row ? syncTargetFromConnectionRow(row) : undefined
}

export async function listLinearSyncTargetsWithRepoByRepositoryId(
  repositoryId: string,
): Promise<LinearSyncTargetWithRepo[]> {
  const db = getSystemDb()
  const rows = await db
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
        eq(connections.type, CONNECTION_TYPE_LINEAR),
        eq(sql`${connections.config}->>'repositoryId'`, repositoryId),
      ),
    )
  return rows.flatMap((row) => {
    const target = syncTargetFromConnectionRow(row.connection)
    if (!target) return []
    return [
      {
        ...target,
        repositoryName: row.repositoryName,
        githubConnectionId: row.githubConnectionId,
      },
    ]
  })
}

export async function applyLinearRepoConfig(input: {
  connectionId: string
  config: ParsedLinearRepoConfig
}): Promise<void> {
  const db = getSystemDb()
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    await tx
      .delete(linearScopes)
      .where(eq(linearScopes.connectionId, input.connectionId))
    if (input.config.scopes.length > 0) {
      await tx.insert(linearScopes).values(
        input.config.scopes.map((scope) => ({
          id: generateObjectId("lsc"),
          connectionId: input.connectionId,
          externalId: scope.externalId,
          type: scope.type,
          title: scope.title,
          url: scope.url,
          parentExternalId: scope.parentExternalId,
          teamId: scope.teamId,
          teamKey: scope.teamKey,
        })),
      )
    }
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_LINEAR),
        ),
      )
      .limit(1)
    if (!row) return
    await tx
      .update(connections)
      .set({
        config: mergeLinearStoredConfig(row, { enabled: true }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
  })
}

export async function resetLinearConnectorAfterMissingConfig(input: {
  orgId: string
  connectionId: string
}): Promise<void> {
  const db = getSystemDb()
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    await tx
      .delete(linearScopes)
      .where(eq(linearScopes.connectionId, input.connectionId))
    await tx
      .delete(linearDirtyEntities)
      .where(eq(linearDirtyEntities.connectionId, input.connectionId))
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_LINEAR),
        ),
      )
      .limit(1)
    if (!row) return
    await tx
      .update(connections)
      .set({
        config: mergeLinearStoredConfig(row, {
          setupPhase: "draft",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          enabled: false,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
  })
}

type LinearScopePatchInput = {
  externalId: string
  type: LinearScopeResourceType
  title: string
  url?: string | null
  parentExternalId?: string | null
  teamId?: string | null
  teamKey?: string | null
}

type LinearSyncTargetPatchInput = {
  repositoryId?: string
  repositoryName?: string
  gitUrl?: string
  githubConnectionId?: string
  branch: string
  enabled: boolean
}

export function linearScopeSelectionChanged(
  existing: Array<
    Pick<
      LinearScope,
      | "externalId"
      | "type"
      | "title"
      | "url"
      | "parentExternalId"
      | "teamId"
      | "teamKey"
    >
  >,
  requested: LinearScopePatchInput[],
): boolean {
  if (existing.length !== requested.length) return true
  const requestedKeys = requested.map(
    (scope) => `${scope.type}:${scope.externalId}`,
  )
  if (new Set(requestedKeys).size !== requested.length) return true

  const existingByKey = new Map(
    existing.map((scope) => [`${scope.type}:${scope.externalId}`, scope]),
  )
  return requested.some((scope) => {
    const current = existingByKey.get(`${scope.type}:${scope.externalId}`)
    return (
      !current ||
      current.title !== scope.title ||
      current.url !== (scope.url ?? null) ||
      current.parentExternalId !== (scope.parentExternalId ?? null) ||
      current.teamId !== (scope.teamId ?? null) ||
      current.teamKey !== (scope.teamKey ?? null)
    )
  })
}

async function resolveRepositoryIdForLinearSync(
  tx: Db,
  orgId: string,
  sync: LinearSyncTargetPatchInput,
  defaultGithubConnectionId: string | undefined,
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
    throw new Error("Repository not found for organization")
  }

  if (!sync.gitUrl || !sync.repositoryName) {
    throw new Error("Repository not found for organization")
  }

  const [byUrl] = await tx
    .select({ id: repositories.id })
    .from(repositories)
    .where(
      and(eq(repositories.orgId, orgId), eq(repositories.gitUrl, sync.gitUrl)),
    )
    .limit(1)
  if (byUrl) return { repositoryId: byUrl.id, didCreate: false }

  const repositoryId = generateObjectId("repo")
  const [created] = await tx
    .insert(repositories)
    .values({
      id: repositoryId,
      orgId,
      name: sync.repositoryName,
      gitUrl: sync.gitUrl,
      githubConnectionId:
        sync.githubConnectionId ?? defaultGithubConnectionId ?? null,
    })
    .returning({ id: repositories.id })
  if (!created) throw new Error("Failed to create repository")

  const [checkout] = await tx
    .insert(repositoryCheckouts)
    .values({
      id: generateObjectId("co"),
      repositoryId,
      ref: sync.branch,
      checkoutKey: DEFAULT_CHECKOUT_KEY,
    })
    .returning({ id: repositoryCheckouts.id })
  if (!checkout) throw new Error("Failed to create repository checkout")

  return { repositoryId, didCreate: true }
}

export async function claimLinearConfigPrCreation(
  tx: Db,
  connectionId: string,
): Promise<{
  pendingConfigPullUrl: string | null
  setupPhase: LinearSetupPhase
}> {
  const [row] = await tx
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.type, CONNECTION_TYPE_LINEAR),
      ),
    )
    .limit(1)
  const target = row ? syncTargetFromConnectionRow(row) : undefined
  if (!target) throw new Error("Linear sync target not found")

  const claimed = await tx
    .update(connections)
    .set({
      config: mergeLinearStoredConfig(row!, {
        setupPhase: "awaiting_merge",
        pendingConfigPrCreating: true,
      }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.type, CONNECTION_TYPE_LINEAR),
        sql`coalesce((${connections.config}->>'pendingConfigPrCreating')::boolean, false) = false`,
      ),
    )
    .returning({ id: connections.id })
  if (claimed.length === 0) {
    throw new LinearConfigPrCreationInProgressError()
  }
  return {
    pendingConfigPullUrl: target.pendingConfigPullUrl,
    setupPhase: target.setupPhase,
  }
}

export async function patchLinearConnectorConfig(input: {
  orgId: string
  connectionId: string
  scopes?: LinearScopePatchInput[]
  syncTarget?: LinearSyncTargetPatchInput
  claimConfigPrCreation?: boolean
}): Promise<{
  scopes: LinearScope[]
  scopesChanged: boolean
  syncTargetChanged: boolean
  configPrClaimed: boolean
  previousConfigPrState?: {
    pendingConfigPullUrl: string | null
    setupPhase: LinearSetupPhase
  }
  repositoryIngestion?: { orgId: string; repositoryId: string }
}> {
  const defaultGithubConnectionId = (
    await listGithubConnectionsForOrg(input.orgId)
  )[0]?.id
  const db = getOrgDb()
  return db.transaction(async (tx) => {
    const [connection] = await tx
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_LINEAR),
        ),
      )
      .limit(1)
    if (!connection) {
      throw new Error("Linear connection does not belong to organization")
    }
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )

    let scopesChanged = false
    let syncTargetChanged = false
    let repositoryIngestion: { orgId: string; repositoryId: string } | undefined

    if (input.scopes !== undefined) {
      const existingScopes = await tx
        .select()
        .from(linearScopes)
        .where(eq(linearScopes.connectionId, input.connectionId))
      scopesChanged = linearScopeSelectionChanged(existingScopes, input.scopes)
      if (scopesChanged) {
        await tx
          .delete(linearScopes)
          .where(eq(linearScopes.connectionId, input.connectionId))
        if (input.scopes.length > 0) {
          await tx.insert(linearScopes).values(
            input.scopes.map((scope) => ({
              id: generateObjectId("lsc"),
              connectionId: input.connectionId,
              externalId: scope.externalId,
              type: scope.type,
              title: scope.title,
              url: scope.url ?? null,
              parentExternalId: scope.parentExternalId ?? null,
              teamId: scope.teamId ?? null,
              teamKey: scope.teamKey ?? null,
            })),
          )
        }
      }
    }

    if (input.syncTarget !== undefined) {
      const { repositoryId, didCreate } =
        await resolveRepositoryIdForLinearSync(
          tx,
          input.orgId,
          input.syncTarget,
          defaultGithubConnectionId,
        )
      if (didCreate) {
        repositoryIngestion = { orgId: input.orgId, repositoryId }
      }
      const [connectionRow] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, input.connectionId))
        .limit(1)
      if (!connectionRow) {
        throw new Error("Linear connection does not belong to organization")
      }
      const existingTarget = syncTargetFromConnectionRow(connectionRow)
      syncTargetChanged =
        !existingTarget ||
        existingTarget.repositoryId !== repositoryId ||
        existingTarget.branch !== input.syncTarget.branch ||
        existingTarget.enabled !== input.syncTarget.enabled

      await tx
        .update(connections)
        .set({
          config: mergeLinearStoredConfig(connectionRow, {
            repositoryId,
            branch: input.syncTarget.branch,
            enabled: input.syncTarget.enabled,
            // Keep existing phase/PR state on repo updates; only seed draft when new.
            ...(existingTarget
              ? {}
              : {
                  setupPhase: "draft" as const,
                  pendingConfigPullUrl: null,
                  pendingConfigPrCreating: false,
                }),
          }),
          updatedAt: new Date(),
        })
        .where(eq(connections.id, input.connectionId))
    }

    const scopes = await tx
      .select()
      .from(linearScopes)
      .where(eq(linearScopes.connectionId, input.connectionId))

    let previousConfigPrState:
      | {
          pendingConfigPullUrl: string | null
          setupPhase: LinearSetupPhase
        }
      | undefined
    if (input.claimConfigPrCreation && scopes.length > 0) {
      previousConfigPrState = await claimLinearConfigPrCreation(
        tx,
        input.connectionId,
      )
    }

    return {
      scopes,
      scopesChanged,
      syncTargetChanged,
      configPrClaimed: Boolean(previousConfigPrState),
      previousConfigPrState,
      repositoryIngestion,
    }
  })
}

export async function updateLinearSyncTargetPrState(input: {
  connectionId: string
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  setupPhase: LinearSetupPhase
}): Promise<void> {
  const db = getSystemDb()
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_LINEAR),
        ),
      )
      .limit(1)
    if (!row) return
    await tx
      .update(connections)
      .set({
        config: mergeLinearStoredConfig(row, {
          pendingConfigPullUrl: input.pendingConfigPullUrl,
          pendingConfigPrCreating: input.pendingConfigPrCreating,
          setupPhase: input.setupPhase,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
  })
}

export async function transitionLinearSyncTargetState(input: {
  connectionId: string
  expectedSetupPhase: LinearSetupPhase
  expectedPendingConfigPrCreating: boolean
  repositoryId: string
  branch: string
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  setupPhase: LinearSetupPhase
}): Promise<boolean> {
  const db = getSystemDb()
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_LINEAR),
        ),
      )
      .limit(1)
    const target = row ? syncTargetFromConnectionRow(row) : undefined
    if (
      !target ||
      target.repositoryId !== input.repositoryId ||
      target.branch !== input.branch ||
      !target.enabled ||
      target.setupPhase !== input.expectedSetupPhase ||
      target.pendingConfigPrCreating !== input.expectedPendingConfigPrCreating
    ) {
      return false
    }
    const [updated] = await tx
      .update(connections)
      .set({
        config: mergeLinearStoredConfig(row!, {
          pendingConfigPullUrl: input.pendingConfigPullUrl,
          pendingConfigPrCreating: input.pendingConfigPrCreating,
          setupPhase: input.setupPhase,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
      .returning({ id: connections.id })
    return Boolean(updated)
  })
}

export async function releaseLinearConfigPrCreationClaim(input: {
  connectionId: string
  previousState: {
    pendingConfigPullUrl: string | null
    setupPhase: LinearSetupPhase
  }
}): Promise<void> {
  await updateLinearSyncTargetPrState({
    connectionId: input.connectionId,
    pendingConfigPullUrl: input.previousState.pendingConfigPullUrl,
    pendingConfigPrCreating: false,
    setupPhase: input.previousState.setupPhase,
  })
}

export async function markLinearSyncTargetInitialSync(
  connectionId: string,
): Promise<void> {
  await updateLinearSyncTargetPrState({
    connectionId,
    pendingConfigPullUrl: null,
    pendingConfigPrCreating: false,
    setupPhase: "initial_sync",
  })
}

export async function claimLinearContentSyncRetry(
  connectionId: string,
): Promise<boolean> {
  const db = getSystemDb()
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.type, CONNECTION_TYPE_LINEAR),
        ),
      )
      .limit(1)
    const target = row ? syncTargetFromConnectionRow(row) : undefined
    if (!target || target.setupPhase !== "sync_failed") return false
    const [claimed] = await tx
      .update(connections)
      .set({
        config: mergeLinearStoredConfig(row!, {
          setupPhase: "initial_sync",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, connectionId))
      .returning({ id: connections.id })
    return Boolean(claimed)
  })
}

export async function markLinearSyncTargetFailed(
  connectionId: string,
): Promise<void> {
  await updateLinearSyncTargetPrState({
    connectionId,
    pendingConfigPullUrl: null,
    pendingConfigPrCreating: false,
    setupPhase: "sync_failed",
  })
}

export async function markLinearSyncTargetLive(
  connectionId: string,
): Promise<void> {
  await updateLinearSyncTargetPrState({
    connectionId,
    pendingConfigPullUrl: null,
    pendingConfigPrCreating: false,
    setupPhase: "live",
  })
}

export async function finalizeLinearSyncTargetAfterContentWorkflow(input: {
  connectionId: string
  workflowStatus: "completed" | "partial_failed" | "failed"
}): Promise<boolean> {
  const db = getSystemDb()
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))`,
    )
    const [row] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.type, CONNECTION_TYPE_LINEAR),
        ),
      )
      .limit(1)
    const target = row ? syncTargetFromConnectionRow(row) : undefined
    if (!target || target.setupPhase !== "initial_sync") return false
    const [updated] = await tx
      .update(connections)
      .set({
        config: mergeLinearStoredConfig(row!, {
          setupPhase:
            input.workflowStatus === "completed" ? "live" : "sync_failed",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
      .returning({ id: connections.id })
    return Boolean(updated)
  })
}

export async function markLinearEntityDirty(input: {
  connectionId: string
  entityType: LinearDirtyEntityType
  externalId: string
  action: "upsert" | "delete"
  eventAt?: Date
}): Promise<void> {
  const db = getSystemDb()
  const eventAt = input.eventAt ?? new Date()
  await db
    .insert(linearDirtyEntities)
    .values({
      id: generateObjectId("lde"),
      connectionId: input.connectionId,
      entityType: input.entityType,
      externalId: input.externalId,
      action: input.action,
      firstDirtyAt: eventAt,
      lastEventAt: eventAt,
    })
    .onConflictDoUpdate({
      target: [
        linearDirtyEntities.connectionId,
        linearDirtyEntities.entityType,
        linearDirtyEntities.externalId,
      ],
      set: {
        action: sql`CASE WHEN excluded.last_event_at >= ${linearDirtyEntities.lastEventAt} THEN excluded.action ELSE ${linearDirtyEntities.action} END`,
        lastEventAt: sql`GREATEST(${linearDirtyEntities.lastEventAt}, excluded.last_event_at)`,
        revision: sql`${linearDirtyEntities.revision} + 1`,
        deadLetteredAt: null,
      },
    })
}

export async function listLinearDirtyEntities(input: {
  connectionId: string
  limit: number
}): Promise<LinearDirtyEntity[]> {
  const db = getSystemDb()
  return db
    .select()
    .from(linearDirtyEntities)
    .where(
      and(
        eq(linearDirtyEntities.connectionId, input.connectionId),
        isNull(linearDirtyEntities.deadLetteredAt),
      ),
    )
    .orderBy(
      asc(linearDirtyEntities.lastEventAt),
      asc(linearDirtyEntities.firstDirtyAt),
    )
    .limit(input.limit)
}

export async function clearLinearDirtyEntities(
  rows: Array<{ id: string; revision: number }>,
): Promise<void> {
  if (rows.length === 0) return
  const db = getSystemDb()
  await db.transaction(async (tx) => {
    for (const row of rows) {
      await tx
        .delete(linearDirtyEntities)
        .where(
          and(
            eq(linearDirtyEntities.id, row.id),
            eq(linearDirtyEntities.revision, row.revision),
          ),
        )
    }
  })
}

export async function deadLetterLinearDirtyEntities(
  rows: Array<{ id: string; revision: number }>,
): Promise<void> {
  if (rows.length === 0) return
  const db = getSystemDb()
  await db.transaction(async (tx) => {
    for (const row of rows) {
      await tx
        .update(linearDirtyEntities)
        .set({ deadLetteredAt: new Date() })
        .where(
          and(
            eq(linearDirtyEntities.id, row.id),
            eq(linearDirtyEntities.revision, row.revision),
          ),
        )
    }
  })
}

/** Clear Linear sync bindings that pointed at a repository about to be deleted. */
export async function clearLinearSyncBindingsForRepository(input: {
  orgId: string
  repositoryId: string
}): Promise<number> {
  const db = getOrgDb()
  const rows = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.orgId, input.orgId),
        eq(connections.type, CONNECTION_TYPE_LINEAR),
        eq(sql`${connections.config}->>'repositoryId'`, input.repositoryId),
      ),
    )
  let cleared = 0
  for (const row of rows) {
    await db
      .update(connections)
      .set({
        config: mergeLinearStoredConfig(row, {
          repositoryId: null,
          branch: null,
          enabled: false,
          setupPhase: "draft",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, row.id))
    cleared += 1
  }
  return cleared
}

export function withLinearOrgContext<T>(
  orgId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withOrgDbContext(orgId, fn)
}
