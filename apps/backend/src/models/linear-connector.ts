import { and, asc, desc, eq, sql } from "drizzle-orm"
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
import {
  type LinearSetupPhase,
  linearSyncTargets,
} from "../db/schema/linearSyncTargets.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import { generateObjectId } from "../lib/id.js"
import {
  type LinearConnectionShape,
  linearConnectionToShape,
  linearShapeToConfig,
} from "./connection-rows.js"
import { listGithubConnectionsForOrg } from "./github-installation.js"
import { DEFAULT_CHECKOUT_KEY } from "./repositories.js"

export type LinearConnection = LinearConnectionShape
export type LinearScope = typeof linearScopes.$inferSelect
export type LinearSyncTarget = typeof linearSyncTargets.$inferSelect
export type LinearDirtyEntity = typeof linearDirtyEntities.$inferSelect

export type LinearSyncTargetWithRepo = LinearSyncTarget & {
  repositoryName: string
  githubConnectionId: string | null
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
  const [existing] = await db
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
        existing &&
        typeof (existing.config as Record<string, unknown>).lastEventPayload !==
          "undefined"
          ? (existing.config as Record<string, unknown>).lastEventPayload
          : null,
    },
    input.env,
  )

  if (existing) {
    const [row] = await db
      .update(connections)
      .set({ config, updatedAt: new Date() })
      .where(eq(connections.id, existing.id))
      .returning()
    if (!row) throw new Error("Failed to update Linear connection")
    return linearConnectionToShape(row, input.env)
  }

  const [row] = await db
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

export async function updateLinearConnectionTokens(input: {
  orgId: string
  connectionId: string
  env: Env
  accessToken: string
  refreshToken: string | null
  accessTokenExpiresAt: string | null
}): Promise<void> {
  const db = getOrgDb()
  const [row] = await db
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
  const config = linearShapeToConfig(
    {
      ...current,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
    },
    input.env,
  )
  await db
    .update(connections)
    .set({ config, updatedAt: new Date() })
    .where(eq(connections.id, input.connectionId))
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

export async function deleteLinearConnectionById(
  orgId: string,
  connectionId: string,
): Promise<boolean> {
  const db = getOrgDb()
  const removed = await db
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
      id: linearSyncTargets.id,
      orgId: linearSyncTargets.orgId,
      connectionId: linearSyncTargets.connectionId,
      repositoryId: linearSyncTargets.repositoryId,
      branch: linearSyncTargets.branch,
      enabled: linearSyncTargets.enabled,
      setupPhase: linearSyncTargets.setupPhase,
      pendingConfigPullUrl: linearSyncTargets.pendingConfigPullUrl,
      pendingConfigPrCreating: linearSyncTargets.pendingConfigPrCreating,
      createdAt: linearSyncTargets.createdAt,
      updatedAt: linearSyncTargets.updatedAt,
      repositoryName: repositories.name,
      githubConnectionId: repositories.githubConnectionId,
    })
    .from(linearSyncTargets)
    .innerJoin(
      repositories,
      eq(linearSyncTargets.repositoryId, repositories.id),
    )
    .where(
      and(
        eq(linearSyncTargets.orgId, orgId),
        eq(linearSyncTargets.connectionId, connectionId),
        eq(repositories.orgId, orgId),
      ),
    )
    .limit(1)
  return row
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
  const [target] = await tx
    .select({
      pendingConfigPullUrl: linearSyncTargets.pendingConfigPullUrl,
      setupPhase: linearSyncTargets.setupPhase,
    })
    .from(linearSyncTargets)
    .where(eq(linearSyncTargets.connectionId, connectionId))
    .limit(1)
  if (!target) throw new Error("Linear sync target not found")

  const claimed = await tx
    .update(linearSyncTargets)
    .set({
      setupPhase: "awaiting_merge",
      pendingConfigPrCreating: true,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(linearSyncTargets.connectionId, connectionId),
        eq(linearSyncTargets.pendingConfigPrCreating, false),
      ),
    )
    .returning({ id: linearSyncTargets.id })
  if (claimed.length === 0) {
    throw new LinearConfigPrCreationInProgressError()
  }
  return target
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
      const [existingTarget] = await tx
        .select()
        .from(linearSyncTargets)
        .where(eq(linearSyncTargets.connectionId, input.connectionId))
        .limit(1)
      syncTargetChanged =
        !existingTarget ||
        existingTarget.repositoryId !== repositoryId ||
        existingTarget.branch !== input.syncTarget.branch ||
        existingTarget.enabled !== input.syncTarget.enabled

      const [target] = await tx
        .insert(linearSyncTargets)
        .values({
          id: generateObjectId("lst"),
          orgId: input.orgId,
          connectionId: input.connectionId,
          repositoryId,
          branch: input.syncTarget.branch,
          enabled: input.syncTarget.enabled,
          setupPhase: "draft",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
        })
        .onConflictDoUpdate({
          target: linearSyncTargets.connectionId,
          set: {
            repositoryId,
            branch: input.syncTarget.branch,
            enabled: input.syncTarget.enabled,
            updatedAt: new Date(),
          },
        })
        .returning()
      if (!target) throw new Error("Failed to save Linear sync target")
    }

    let previousConfigPrState:
      | {
          pendingConfigPullUrl: string | null
          setupPhase: LinearSetupPhase
        }
      | undefined
    if (input.claimConfigPrCreation) {
      previousConfigPrState = await claimLinearConfigPrCreation(
        tx,
        input.connectionId,
      )
    }

    const scopes = await tx
      .select()
      .from(linearScopes)
      .where(eq(linearScopes.connectionId, input.connectionId))

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
  const {
    connectionId,
    pendingConfigPullUrl,
    pendingConfigPrCreating,
    setupPhase,
  } = input
  await db
    .update(linearSyncTargets)
    .set({
      pendingConfigPullUrl,
      pendingConfigPrCreating,
      setupPhase,
      updatedAt: new Date(),
    })
    .where(eq(linearSyncTargets.connectionId, connectionId))
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
}): Promise<void> {
  if (input.workflowStatus !== "completed") return
  const db = getSystemDb()
  await db
    .update(linearSyncTargets)
    .set({
      setupPhase: "live",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(linearSyncTargets.connectionId, input.connectionId),
        eq(linearSyncTargets.setupPhase, "initial_sync"),
      ),
    )
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
        action: input.action,
        lastEventAt: eventAt,
        revision: sql`${linearDirtyEntities.revision} + 1`,
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
    .where(eq(linearDirtyEntities.connectionId, input.connectionId))
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

export function withLinearOrgContext<T>(
  orgId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withOrgDbContext(orgId, fn)
}
