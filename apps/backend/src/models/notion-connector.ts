import { and, desc, eq, ne, sql } from "drizzle-orm"
import {
  type Db,
  getOrgDb,
  getSystemDb,
  withOrgDbContext,
} from "../db/client.js"
import { members, organizations } from "../db/schema/auth.js"
import {
  CONNECTION_TYPE_GITHUB,
  CONNECTION_TYPE_NOTION,
  connections,
} from "../db/schema/connections.js"
import { notionWebhookConfigs } from "../db/schema/notionWebhookConfigs.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import {
  type NotionSetupPhase,
  parseNotionConnectionConfig,
  serialiseNotionConnectionConfigForDb,
} from "../lib/connection-config.js"
import { generateObjectId } from "../lib/id.js"
import {
  type ConnectionRow,
  type NotionConnectionShape,
  notionConnectionToShape,
  notionShapeToConfig,
} from "./connection-rows.js"
import { listGithubConnectionsForOrg } from "./github-installation.js"
import { DEFAULT_CHECKOUT_KEY } from "./repositories.js"

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
export type NotionSyncTarget = {
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

export type NotionSyncTargetWithRepo = NotionSyncTarget & {
  repositoryName: string
  githubConnectionId: string | null
}

/** Project a Notion sync binding from a connection row, or `undefined` when unbound. */
function bindingFromConnectionRow(
  row: ConnectionRow,
): NotionSyncTarget | undefined {
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
  existing: NotionSyncTarget | undefined
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

function notionConfigWorkspaceIdRef() {
  return sql<string>`${connections.config}->>'workspaceId'`
}

function notionConfigOwnerUserIdRef() {
  return sql<string>`${connections.config}->>'ownerUserId'`
}

function notionConfigStatusRef() {
  return sql<string>`${connections.config}->>'status'`
}

export async function listNotionConnectionsForOrg(
  orgId: string,
): Promise<NotionConnection[]> {
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
  return rows.map(notionConnectionToShape)
}

export async function getNotionConnectionByConnectionId(
  orgId: string,
  connectionId: string,
): Promise<NotionConnection | undefined> {
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
  return row ? notionConnectionToShape(row) : undefined
}

export const MULTIPLE_NOTION_CONNECTIONS_MESSAGE =
  "Multiple Notion connections for this organization; specify connectionId query parameter"

export type ResolveNotionConnectionResult =
  | { status: "ok"; connection: NotionConnection }
  | { status: "none" }
  | { status: "ambiguous" }

export async function resolveNotionConnectionForOrgDetailed(
  orgId: string,
  connectionId?: string | null,
): Promise<ResolveNotionConnectionResult> {
  if (connectionId) {
    const connection = await getNotionConnectionByConnectionId(
      orgId,
      connectionId,
    )
    return connection ? { status: "ok", connection } : { status: "none" }
  }
  const list = await listNotionConnectionsForOrg(orgId)
  if (list.length === 0) return { status: "none" }
  const [connection] = list
  if (list.length === 1 && connection) {
    return { status: "ok", connection }
  }
  return { status: "ambiguous" }
}

export async function resolveNotionConnectionForOrg(
  orgId: string,
  connectionId?: string | null,
): Promise<NotionConnection | undefined> {
  const r = await resolveNotionConnectionForOrgDetailed(orgId, connectionId)
  return r.status === "ok" ? r.connection : undefined
}

export async function upsertNotionConnectionFromOAuth(input: {
  orgId: string
  ownerUserId: string
  accessToken: string
  refreshToken?: string | null
  botId: string
  workspaceId?: string | null
  workspaceName?: string | null
  workspaceIcon?: string | null
}): Promise<NotionConnection> {
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

  const existingShape = existing ? notionConnectionToShape(existing) : undefined
  const config = notionShapeToConfig({
    accessToken: input.accessToken,
    refreshToken: input.refreshToken ?? null,
    botId: input.botId,
    workspaceId: input.workspaceId ?? null,
    workspaceName: input.workspaceName ?? null,
    workspaceIcon: input.workspaceIcon ?? null,
    ownerUserId: input.ownerUserId,
    webhookVerificationToken:
      existingShape?.webhookVerificationToken ?? null,
    status: "installed",
    lastEventPayload: null,
    // Preserve the sync binding when re-running OAuth for an existing connection.
    repositoryId: existingShape?.repositoryId ?? null,
    branch: existingShape?.branch ?? null,
    enabled: existingShape?.enabled ?? true,
    setupPhase: existingShape?.setupPhase ?? "draft",
    pendingConfigPullUrl: existingShape?.pendingConfigPullUrl ?? null,
    pendingConfigPrCreating: existingShape?.pendingConfigPrCreating ?? false,
  })

  if (existing) {
    const [row] = await db
      .update(connections)
      .set({ config, updatedAt: new Date() })
      .where(eq(connections.id, existing.id))
      .returning()
    if (!row) throw new Error("Failed to update Notion connection")
    return notionConnectionToShape(row)
  }

  const [row] = await db
    .insert(connections)
    .values({
      id: generateObjectId("con"),
      orgId: input.orgId,
      type: CONNECTION_TYPE_NOTION,
      config,
    })
    .returning()
  if (!row) throw new Error("Failed to create Notion connection")
  return notionConnectionToShape(row)
}

export async function updateNotionConnectionTokens(input: {
  orgId: string
  connectionId: string
  accessToken: string
  refreshToken: string | null
}): Promise<void> {
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
  const config = serialiseNotionConnectionConfigForDb({
    ...(current.config as Record<string, unknown>),
    accessToken: input.accessToken,
    refreshToken: input.refreshToken ?? undefined,
  })
  await db
    .update(connections)
    .set({ config, updatedAt: new Date() })
    .where(eq(connections.id, input.connectionId))
}

export async function getNotionConnectionForWebhook(
  connectionId: string,
): Promise<NotionConnection | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.type, CONNECTION_TYPE_NOTION),
      ),
    )
    .limit(1)
  return row ? notionConnectionToShape(row) : undefined
}

export async function getNotionWebhookVerificationToken(): Promise<
  string | null
> {
  const db = getSystemDb()
  const [row] = await db
    .select({ verificationToken: notionWebhookConfigs.verificationToken })
    .from(notionWebhookConfigs)
    .where(eq(notionWebhookConfigs.id, "notion"))
    .limit(1)
  return row?.verificationToken ?? null
}

export async function listNotionConnectionsForWebhook(input: {
  integrationId?: string | null
  workspaceId?: string | null
}): Promise<NotionConnection[]> {
  if (!input.workspaceId && !input.integrationId) return []

  const db = getSystemDb()
  const identityFilter = input.workspaceId
    ? eq(notionConfigWorkspaceIdRef(), input.workspaceId)
    : eq(notionConfigBotIdRef(), input.integrationId ?? "")
  const rows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.type, CONNECTION_TYPE_NOTION), identityFilter))
  return rows.map(notionConnectionToShape)
}

export async function updateNotionWebhookVerificationToken(input: {
  orgId: string
  connectionId: string
  verificationToken: string
}): Promise<void> {
  const db = getSystemDb()
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
  const currentVerificationToken = (current.config as Record<string, unknown>)
    .webhookVerificationToken
  if (
    typeof currentVerificationToken === "string" &&
    currentVerificationToken.length > 0
  ) {
    return
  }
  const config = serialiseNotionConnectionConfigForDb({
    ...(current.config as Record<string, unknown>),
    webhookVerificationToken: input.verificationToken,
  })
  await db
    .update(connections)
    .set({ config, updatedAt: new Date() })
    .where(eq(connections.id, input.connectionId))
}

export async function storeNotionWebhookVerificationConfig(
  verificationToken: string,
  integrationId?: string | null,
): Promise<void> {
  const db = getSystemDb()
  await db
    .insert(notionWebhookConfigs)
    .values({
      id: "notion",
      integrationId: integrationId ?? null,
      verificationToken,
    })
    // The verification callback is public by design. Once provisioned, never
    // let another unauthenticated request replace the signing secret.
    .onConflictDoNothing({ target: notionWebhookConfigs.id })
}

export async function getPendingNotionConnectionForUserInOtherOrg(input: {
  userId: string
  orgId: string
}): Promise<NotionConnection | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({ connection: connections })
    .from(connections)
    .innerJoin(
      members,
      and(
        eq(members.organizationId, connections.orgId),
        eq(members.userId, input.userId),
      ),
    )
    .where(
      and(
        eq(connections.type, CONNECTION_TYPE_NOTION),
        eq(notionConfigStatusRef(), "pending"),
        eq(notionConfigOwnerUserIdRef(), input.userId),
        ne(connections.orgId, input.orgId),
      ),
    )
    .orderBy(desc(connections.updatedAt))
    .limit(1)
  return row?.connection ? notionConnectionToShape(row.connection) : undefined
}

export async function deleteNotionConnectionById(
  orgId: string,
  connectionId: string,
): Promise<boolean> {
  const db = getOrgDb()
  const removed = await db
    .delete(connections)
    .where(
      and(
        eq(connections.orgId, orgId),
        eq(connections.id, connectionId),
        eq(connections.type, CONNECTION_TYPE_NOTION),
      ),
    )
    .returning({ id: connections.id })
  return removed.length > 0
}

export async function getNotionSyncTargetByConnectionId(
  connectionId: string,
): Promise<NotionSyncTarget | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.type, CONNECTION_TYPE_NOTION),
      ),
    )
    .limit(1)
  return row ? bindingFromConnectionRow(row) : undefined
}

export async function getNotionSyncTargetWithRepoByConnectionId(
  orgId: string,
  connectionId: string,
): Promise<NotionSyncTargetWithRepo | undefined> {
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
  const target = bindingFromConnectionRow(row.connection)
  if (!target) return undefined
  return {
    ...target,
    repositoryName: row.repositoryName,
    githubConnectionId: row.githubConnectionId,
  }
}

export async function listNotionSyncTargetsWithRepoByRepositoryId(
  repositoryId: string,
): Promise<NotionSyncTargetWithRepo[]> {
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
        eq(connections.type, CONNECTION_TYPE_NOTION),
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
}

export async function claimNotionConfigPrCreation(input: {
  connectionId: string
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
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    if (!row) return false
    const claimed = await tx
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
      .returning({ id: connections.id })
    return claimed.length > 0
  })
}

export async function releaseNotionConfigPrCreationClaim(input: {
  connectionId: string
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
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    if (!row) return
    await tx
      .update(connections)
      .set({
        config: mergeNotionStoredConfig(row, {
          pendingConfigPrCreating: false,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
  })
}

export async function updateNotionSyncTargetPrState(input: {
  connectionId: string
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  setupPhase: NotionSetupPhase
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
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    if (!row) return
    await tx
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
  })
}

export async function markNotionSyncTargetInitialSync(input: {
  connectionId: string
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
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    if (!row) return
    await tx
      .update(connections)
      .set({
        config: mergeNotionStoredConfig(row, {
          setupPhase: "initial_sync",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          enabled: true,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
  })
}

export async function markNotionSyncTargetLive(input: {
  connectionId: string
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
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    if (!row) return
    await tx
      .update(connections)
      .set({
        config: mergeNotionStoredConfig(row, {
          setupPhase: "live",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          enabled: true,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
  })
}

export async function resetNotionConnectorAfterMissingConfig(input: {
  orgId: string
  connectionId: string
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
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    if (!row) return
    await tx
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
  })
}

export async function finalizeNotionSyncTargetAfterContentWorkflow(input: {
  connectionId: string
  workflowStatus: "completed" | "partial_failed" | "failed"
}): Promise<void> {
  if (input.workflowStatus === "failed") return
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
          eq(connections.type, CONNECTION_TYPE_NOTION),
        ),
      )
      .limit(1)
    const target = row ? bindingFromConnectionRow(row) : undefined
    if (!row || !target || target.setupPhase !== "initial_sync") return
    await tx
      .update(connections)
      .set({
        config: mergeNotionStoredConfig(row, {
          setupPhase: "live",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
  })
}

type SyncTargetPatchInput = {
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
  sync: SyncTargetPatchInput,
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
 * only ever touches the connection row. `syncTargetChanged` reports whether the
 * binding actually changed.
 */
export async function patchNotionConnectorConfig(input: {
  orgId: string
  connectionId: string
  syncTarget?: SyncTargetPatchInput
}): Promise<{
  syncTargetChanged: boolean
  repositoryIngestion?: { orgId: string; repositoryId: string }
}> {
  if (input.syncTarget === undefined) {
    return { syncTargetChanged: false }
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

  const db = getOrgDb()
  return db.transaction(async (tx) => {
    let repositoryIngestion: { orgId: string; repositoryId: string } | undefined

    const { repositoryId, didCreate } = await resolveRepositoryIdForNotionSync(
      tx,
      input.orgId,
      syncTarget,
      githubConnectionId,
    )
    if (didCreate) {
      repositoryIngestion = { orgId: input.orgId, repositoryId }
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

    if (plan.changed) {
      await tx
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
    }

    return {
      syncTargetChanged: plan.changed,
      repositoryIngestion,
    }
  })
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

export async function listNotionConnectionsByBotId(
  botId: string,
): Promise<NotionConnection[]> {
  const db = getSystemDb()
  const rows = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.type, CONNECTION_TYPE_NOTION),
        eq(notionConfigBotIdRef(), botId),
      ),
    )
  return rows.map(notionConnectionToShape)
}

export async function orgHasAnyGithubConnectionForNotion(
  orgId: string,
): Promise<boolean> {
  const db = getSystemDb()
  const [row] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.orgId, orgId),
        eq(connections.type, CONNECTION_TYPE_GITHUB),
      ),
    )
    .limit(1)
  return Boolean(row)
}

export function runNotionOrgContext<T>(
  orgId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withOrgDbContext(orgId, fn)
}
