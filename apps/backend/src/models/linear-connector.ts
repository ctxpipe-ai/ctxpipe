import { and, desc, eq, sql } from "drizzle-orm"
import type { Env } from "../config/env.js"
import type { Db } from "../db/client.js"
import {
  assertNotInOrgDbContext,
  getOrgDb,
  withOrgDbContext,
} from "../db/client.js"
import {
  CONNECTION_TYPE_LINEAR,
  connections,
} from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import {
  type LinearSetupPhase,
  parseLinearConnectionStored,
  serialiseLinearConnectionConfigForDb,
} from "../lib/connection-config.js"
import { generateObjectId } from "../lib/id.js"
import {
  deleteConnectionDirectory,
  getConnectionDirectoryByConnectionId,
  listConnectionDirectoryByLinearWorkspaceId,
  loadConnectionViaDirectory,
  upsertConnectionDirectory,
} from "./connection-directory.js"
import {
  type ConnectionRow,
  type LinearConnectionShape,
  linearConnectionToShape,
  linearShapeToConfig,
} from "./connection-rows.js"
import { listGithubConnectionsForOrg } from "./github-installation.js"
import { DEFAULT_CHECKOUT_KEY } from "./repositories.js"

function orgSql<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return withOrgDbContext(orgId, fn)
}

export type { LinearSetupPhase } from "../lib/connection-config.js"

export type LinearConnection = LinearConnectionShape
export interface LinearScope {
  externalId: string
  type: "team" | "project" | "document" | "initiative"
  title: string
  url: string | null
  parentExternalId: string | null
  teamId: string | null
  teamKey: string | null
}
/** Sync binding projected from `connections.config` (+ timestamps from the connection row). */
export type LinearBinding = {
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

export type LinearBindingWithRepo = LinearBinding & {
  repositoryName: string
  githubConnectionId: string | null
}

function bindingFromConnectionRow(
  row: ConnectionRow,
): LinearBinding | undefined {
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

export class LinearSyncBindingBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LinearSyncBindingBusyError"
  }
}

/** Pure rebind rules for sync binding on `connections.config`. */
export function planLinearSyncBindingUpdate(input: {
  existing: LinearBinding | undefined
  repositoryId: string
  branch: string
  enabled: boolean
}): {
  changed: boolean
  repositoryOrBranchChanged: boolean
  resetLifecycle: boolean
  /** Prior PR URL to close when lifecycle resets (best-effort). */
  previousConfigPullUrlToClose: string | null
  previousRepositoryIdToClose: string | null
} {
  const repositoryOrBranchChanged =
    !input.existing ||
    input.existing.repositoryId !== input.repositoryId ||
    input.existing.branch !== input.branch
  const changed =
    repositoryOrBranchChanged ||
    (input.existing?.enabled ?? true) !== input.enabled

  // Only block true in-flight content sync. Stuck pendingConfigPrCreating is
  // recovered by rebind itself (resetLifecycle clears the flag).
  if (
    input.existing &&
    repositoryOrBranchChanged &&
    input.existing.setupPhase === "initial_sync"
  ) {
    throw new LinearSyncBindingBusyError(
      "Cannot change Linear sync repository while initial sync is running",
    )
  }

  const resetLifecycle = !input.existing || repositoryOrBranchChanged
  return {
    changed,
    repositoryOrBranchChanged,
    resetLifecycle,
    previousConfigPullUrlToClose:
      resetLifecycle && input.existing?.pendingConfigPullUrl
        ? input.existing.pendingConfigPullUrl
        : null,
    previousRepositoryIdToClose:
      resetLifecycle && input.existing?.pendingConfigPullUrl
        ? input.existing.repositoryId
        : null,
  }
}

function linearConfigWorkspaceIdRef() {
  return sql<string>`${connections.config}->>'workspaceId'`
}

export async function listLinearConnectionsForOrg(
  orgId: string,
  env: Env,
): Promise<LinearConnection[]> {
  return orgSql(orgId, async () => {
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
  })
}

export async function getLinearConnectionByConnectionId(
  orgId: string,
  connectionId: string,
  env: Env,
): Promise<LinearConnection | undefined> {
  return orgSql(orgId, async () => {
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
  })
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
  const row = await orgSql(input.orgId, async () => {
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
        return row
      }

      const [row] = await tx
        .update(connections)
        .set({ config, updatedAt: new Date() })
        .where(eq(connections.id, existing.id))
        .returning()
      if (!row) throw new Error("Failed to update Linear connection")
      return row
    })
  })
  await upsertConnectionDirectory(row)
  return linearConnectionToShape(row, input.env)
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
  assertNotInOrgDbContext()
  const snapshot = await withOrgDbContext(input.orgId, async (tx) => {
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
    return linearConnectionToShape(row, input.env)
  })
  if (
    snapshot.accessToken !== input.expectedAccessToken ||
    (snapshot.refreshToken &&
      snapshot.refreshToken !== input.expectedRefreshToken)
  ) {
    return {
      accessToken: snapshot.accessToken,
      refreshToken: snapshot.refreshToken,
      accessTokenExpiresAt: snapshot.accessTokenExpiresAt,
    }
  }
  if (!snapshot.refreshToken) {
    throw new Error("Linear connection has no refresh token")
  }
  const refreshed = await input.refresh(snapshot.refreshToken)
  const result = await withOrgDbContext(input.orgId, async (tx) => {
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
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_LINEAR),
        ),
      )
      .returning({ id: connections.id })
    if (updated) {
      return { tokens: refreshed, row: { ...row, config } }
    }
    throw new Error("Linear connection was removed during token refresh")
  })
  if ("row" in result) {
    await upsertConnectionDirectory(result.row)
    return result.tokens
  }
  return result
}

export async function listLinearConnectionsByWorkspaceId(
  workspaceId: string,
  env: Env,
): Promise<LinearConnection[]> {
  const directoryRows =
    await listConnectionDirectoryByLinearWorkspaceId(workspaceId)
  const rows = await Promise.all(
    directoryRows.map((row) => loadConnectionViaDirectory(row.connectionId)),
  )
  return rows.map((row) => linearConnectionToShape(row, env))
}

export async function recordLinearOAuthRevocation(input: {
  connectionId: string
  env: Env
  payload: unknown
}): Promise<void> {
  const directoryRow = await getConnectionDirectoryByConnectionId(
    input.connectionId,
  )
  if (!directoryRow) return
  const updated = await withOrgDbContext(directoryRow.orgId, async () => {
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
            eq(connections.type, CONNECTION_TYPE_LINEAR),
          ),
        )
        .limit(1)
      if (!row) return
      const current = linearConnectionToShape(row, input.env)
      const [result] = await tx
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
        .returning()
      if (!result)
        throw new Error("Linear connection was removed during revocation")
      return result
    })
  })
  await upsertConnectionDirectory(updated)
}

export async function deleteLinearConnectionById(
  orgId: string,
  connectionId: string,
): Promise<boolean> {
  const removed = await orgSql(orgId, async () => {
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
  })
  await deleteConnectionDirectory(connectionId)
  return removed
}

export async function getLinearBindingWithRepoByConnectionId(
  orgId: string,
  connectionId: string,
): Promise<LinearBindingWithRepo | undefined> {
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
          eq(connections.type, CONNECTION_TYPE_LINEAR),
          eq(repositories.orgId, orgId),
        ),
      )
      .limit(1)
    if (!row) return undefined
    const target = bindingFromConnectionRow(row.connection)
    if (!target) return undefined
    return {
      ...target,
      repositoryName: row.repositoryName,
      githubConnectionId: row.githubConnectionId,
    }
  })
}

async function assertLinearBindingSnapshot(input: {
  orgId?: string
  connectionId: string
  repositoryId: string
  branch: string
  setupPhase: "initial_sync" | "live"
}): Promise<void> {
  const directoryRow = input.orgId
    ? { orgId: input.orgId }
    : await getConnectionDirectoryByConnectionId(input.connectionId)
  if (!directoryRow) throw new Error("Linear sync target not found")
  await withOrgDbContext(directoryRow.orgId, async (tx) => {
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
    const target = row ? bindingFromConnectionRow(row) : undefined
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
  })
}

/** Verify binding, run GitHub I/O outside the lock, re-verify afterward. */
export async function withLinearBindingSnapshot<T>(
  input: {
    orgId?: string
    connectionId: string
    repositoryId: string
    branch: string
    setupPhase: "initial_sync" | "live"
  },
  operation: () => Promise<T>,
): Promise<T> {
  await assertLinearBindingSnapshot(input)
  const result = await operation()
  await assertLinearBindingSnapshot(input)
  return result
}

export async function getLinearBindingByConnectionId(
  connectionId: string,
): Promise<LinearBinding | undefined> {
  const row = await loadConnectionViaDirectory(connectionId)
  if (row?.type !== CONNECTION_TYPE_LINEAR) return undefined
  return row ? bindingFromConnectionRow(row) : undefined
}

export async function listLinearBindingsWithRepoByRepositoryId(
  orgId: string,
  repositoryId: string,
): Promise<LinearBindingWithRepo[]> {
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
          eq(connections.type, CONNECTION_TYPE_LINEAR),
          eq(sql`${connections.config}->>'repositoryId'`, repositoryId),
        ),
      )
    return rows.flatMap((row) => {
      const target = bindingFromConnectionRow(row.connection)
      if (!target) return []
      return [
        {
          ...target,
          repositoryName: row.repositoryName,
          githubConnectionId: row.githubConnectionId,
        },
      ]
    })
  })
}

export async function resetLinearConnectorAfterMissingConfig(input: {
  orgId: string
  connectionId: string
}): Promise<void> {
  const updated = await withOrgDbContext(input.orgId, async () => {
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
      if (!row) return
      const [result] = await tx
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
        .returning()
      if (!result) throw new Error("Linear connection was removed during reset")
      return result
    })
  })
  if (updated) await upsertConnectionDirectory(updated)
}

type LinearBindingPatchInput = {
  repositoryId?: string
  repositoryName?: string
  gitUrl?: string
  githubConnectionId?: string
  branch: string
  enabled: boolean
}

async function resolveRepositoryIdForLinearSync(
  tx: Db,
  orgId: string,
  sync: LinearBindingPatchInput,
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
      orgId,
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
  const target = row ? bindingFromConnectionRow(row) : undefined
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
  /** Scopes for config-PR workflow input only — not stored in Postgres. */
  scopes?: LinearScope[]
  binding?: LinearBindingPatchInput
  claimConfigPrCreation?: boolean
}): Promise<{
  /** Scopes submitted for workflow enqueue only (not persisted as draft). */
  scopes: LinearScope[]
  configPrClaimed: boolean
  previousConfigPrState?: {
    pendingConfigPullUrl: string | null
    setupPhase: LinearSetupPhase
  }
  /** Stale config PR on the previous repo/branch; caller should close best-effort. */
  supersededConfigPullUrl?: string | null
  supersededConfigRepositoryId?: string | null
  repositoryIngestion?: {
    orgId: string
    repositoryId: string
    targetBranch?: string
  }
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

    let supersededConfigPullUrl: string | null | undefined
    let supersededConfigRepositoryId: string | null | undefined
    let repositoryIngestion:
      | {
          orgId: string
          repositoryId: string
          targetBranch?: string
        }
      | undefined

    if (input.binding !== undefined) {
      const { repositoryId, didCreate } =
        await resolveRepositoryIdForLinearSync(
          tx,
          input.orgId,
          input.binding,
          defaultGithubConnectionId,
        )
      if (didCreate) {
        repositoryIngestion = {
          orgId: input.orgId,
          repositoryId,
          targetBranch: input.binding.branch,
        }
      }
      const [connectionRow] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, input.connectionId))
        .limit(1)
      if (!connectionRow) {
        throw new Error("Linear connection does not belong to organization")
      }
      const existingTarget = bindingFromConnectionRow(connectionRow)
      const plan = planLinearSyncBindingUpdate({
        existing: existingTarget,
        repositoryId,
        branch: input.binding.branch,
        enabled: input.binding.enabled,
      })
      supersededConfigPullUrl = plan.previousConfigPullUrlToClose
      supersededConfigRepositoryId = plan.previousRepositoryIdToClose

      await tx
        .update(connections)
        .set({
          config: mergeLinearStoredConfig(connectionRow, {
            repositoryId,
            branch: input.binding.branch,
            enabled: input.binding.enabled,
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
    }

    let previousConfigPrState:
      | {
          pendingConfigPullUrl: string | null
          setupPhase: LinearSetupPhase
        }
      | undefined
    if (input.claimConfigPrCreation && input.scopes !== undefined) {
      previousConfigPrState = await claimLinearConfigPrCreation(
        tx,
        input.connectionId,
      )
    }

    return {
      scopes: input.scopes ?? [],
      configPrClaimed: Boolean(previousConfigPrState),
      previousConfigPrState,
      supersededConfigPullUrl,
      supersededConfigRepositoryId,
      repositoryIngestion,
    }
  })
}

export async function updateLinearBindingPrState(input: {
  connectionId: string
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  setupPhase: LinearSetupPhase
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
          eq(connections.type, CONNECTION_TYPE_LINEAR),
        ),
      )
      .limit(1)
    if (!row) return
    const [result] = await tx
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
      .returning()
    if (!result)
      throw new Error("Linear connection was removed during PR state update")
    return result
  })
  if (updated) await upsertConnectionDirectory(updated)
}

export async function transitionLinearBindingState(input: {
  connectionId: string
  expectedSetupPhase: LinearSetupPhase
  expectedPendingConfigPrCreating: boolean
  repositoryId: string
  branch: string
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  setupPhase: LinearSetupPhase
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
          eq(connections.type, CONNECTION_TYPE_LINEAR),
        ),
      )
      .limit(1)
    const target = row ? bindingFromConnectionRow(row) : undefined
    if (
      !row ||
      !target ||
      target.repositoryId !== input.repositoryId ||
      target.branch !== input.branch ||
      !target.enabled ||
      target.setupPhase !== input.expectedSetupPhase ||
      target.pendingConfigPrCreating !== input.expectedPendingConfigPrCreating
    ) {
      return
    }
    const [result] = await tx
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
      .returning()
    return result
  })
  if (!updated) return false
  await upsertConnectionDirectory(updated)
  return true
}

export async function releaseLinearConfigPrCreationClaim(input: {
  connectionId: string
  previousState: {
    pendingConfigPullUrl: string | null
    setupPhase: LinearSetupPhase
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
          eq(connections.type, CONNECTION_TYPE_LINEAR),
        ),
      )
      .limit(1)
    const target = row ? bindingFromConnectionRow(row) : undefined
    // Only restore if we still own the in-progress claim; skip if rebound.
    if (
      !row ||
      !target ||
      target.setupPhase !== "awaiting_merge" ||
      !target.pendingConfigPrCreating
    ) {
      return
    }
    const [result] = await tx
      .update(connections)
      .set({
        config: mergeLinearStoredConfig(row, {
          pendingConfigPullUrl: input.previousState.pendingConfigPullUrl,
          pendingConfigPrCreating: false,
          setupPhase: input.previousState.setupPhase,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
      .returning()
    if (!result)
      throw new Error("Linear connection was removed during claim release")
    return result
  })
  if (updated) await upsertConnectionDirectory(updated)
}

/** CAS into initial_sync only when binding still matches the activating push. */
export async function claimLinearBindingInitialSync(input: {
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
          eq(connections.type, CONNECTION_TYPE_LINEAR),
        ),
      )
      .limit(1)
    const target = row ? bindingFromConnectionRow(row) : undefined
    if (
      !row ||
      !target ||
      !target.enabled ||
      target.repositoryId !== input.repositoryId ||
      target.branch !== input.branch ||
      !(
        target.setupPhase === "awaiting_merge" ||
        target.setupPhase === "sync_failed" ||
        target.setupPhase === "live"
      )
    ) {
      return
    }
    const [result] = await tx
      .update(connections)
      .set({
        config: mergeLinearStoredConfig(row, {
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          setupPhase: "initial_sync",
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

export async function claimLinearContentSyncRetry(
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
          eq(connections.type, CONNECTION_TYPE_LINEAR),
        ),
      )
      .limit(1)
    const target = row ? bindingFromConnectionRow(row) : undefined
    if (!row || !target || target.setupPhase !== "sync_failed") return
    const [result] = await tx
      .update(connections)
      .set({
        config: mergeLinearStoredConfig(row, {
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

export async function finalizeLinearBindingAfterContentWorkflow(input: {
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
          eq(connections.type, CONNECTION_TYPE_LINEAR),
        ),
      )
      .limit(1)
    const target = row ? bindingFromConnectionRow(row) : undefined
    if (!row || !target || target.setupPhase !== "initial_sync") return
    const [result] = await tx
      .update(connections)
      .set({
        config: mergeLinearStoredConfig(row, {
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

/** Clear Linear sync bindings that pointed at a repository about to be deleted. */
export async function clearLinearSyncBindingsForRepository(input: {
  orgId: string
  repositoryId: string
}): Promise<number> {
  const updatedRows = await orgSql(input.orgId, async () => {
    const tx = getOrgDb()
    const ids = await tx
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_LINEAR),
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
            eq(connections.type, CONNECTION_TYPE_LINEAR),
            eq(sql`${connections.config}->>'repositoryId'`, input.repositoryId),
          ),
        )
        .limit(1)
      if (!row) continue
      const [updated] = await tx
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
        .where(eq(connections.id, id))
        .returning()
      if (updated) rows.push(updated)
    }
    return rows
  })
  await Promise.all(updatedRows.map((row) => upsertConnectionDirectory(row)))
  return updatedRows.length
}
