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
import { notionResources } from "../db/schema/notionResources.js"
import { notionSyncTargets } from "../db/schema/notionSyncTargets.js"
import { notionWebhookConfigs } from "../db/schema/notionWebhookConfigs.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import { serialiseNotionConnectionConfigForDb } from "../lib/connection-config.js"
import { generateObjectId } from "../lib/id.js"
import {
  type NotionConnectionShape,
  notionConnectionToShape,
  notionShapeToConfig,
} from "./connection-rows.js"
import { listGithubConnectionsForOrg } from "./github-installation.js"
import { DEFAULT_CHECKOUT_KEY } from "./repositories.js"

export type NotionConnection = NotionConnectionShape
export type NotionResource = typeof notionResources.$inferSelect
export type NotionSyncTarget = typeof notionSyncTargets.$inferSelect

export type NotionSyncTargetWithRepo = NotionSyncTarget & {
  repositoryName: string
  githubConnectionId: string | null
}

function notionConfigBotIdRef() {
  return sql<string>`${connections.config}->>'botId'`
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

  const config = notionShapeToConfig({
    accessToken: input.accessToken,
    refreshToken: input.refreshToken ?? null,
    botId: input.botId,
    workspaceId: input.workspaceId ?? null,
    workspaceName: input.workspaceName ?? null,
    workspaceIcon: input.workspaceIcon ?? null,
    ownerUserId: input.ownerUserId,
    webhookVerificationToken:
      existing &&
      typeof (existing.config as Record<string, unknown>)
        .webhookVerificationToken === "string"
        ? ((existing.config as Record<string, unknown>)
            .webhookVerificationToken as string)
        : null,
    status: "installed",
    lastEventPayload: null,
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
  const db = getSystemDb()
  const rows = await db
    .select()
    .from(connections)
    .where(eq(connections.type, CONNECTION_TYPE_NOTION))
  return rows.map(notionConnectionToShape).filter((connection) => {
    // Workspace identity is the tenant boundary. Prefer it when present so
    // an integration identifier format change cannot drop a valid event.
    if (input.workspaceId) return connection.workspaceId === input.workspaceId
    if (input.integrationId) return connection.botId === input.integrationId
    return true
  })
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
  const config = serialiseNotionConnectionConfigForDb({
    ...(current.config as Record<string, unknown>),
    webhookVerificationToken: input.verificationToken,
  })
  await db
    .update(connections)
    .set({ config, updatedAt: new Date() })
    .where(eq(connections.id, input.connectionId))
}

export async function upsertNotionWebhookVerificationConfig(
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
    .onConflictDoUpdate({
      target: notionWebhookConfigs.id,
      set: {
        integrationId: integrationId ?? null,
        verificationToken,
        updatedAt: new Date(),
      },
    })
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

export async function listNotionResourcesByConnectionId(
  connectionId: string,
): Promise<NotionResource[]> {
  const db = getOrgDb()
  return db
    .select()
    .from(notionResources)
    .where(eq(notionResources.connectionId, connectionId))
}

export async function replaceNotionResourcesForConnection(input: {
  connectionId: string
  resources: Array<{
    externalId: string
    type: "page" | "database"
    title: string
    url?: string | null
    parentExternalId?: string | null
  }>
}): Promise<NotionResource[]> {
  const db = getOrgDb()
  return db.transaction(async (tx) => {
    await tx
      .delete(notionResources)
      .where(eq(notionResources.connectionId, input.connectionId))

    if (input.resources.length === 0) return []

    return tx
      .insert(notionResources)
      .values(
        input.resources.map((resource) => ({
          id: generateObjectId("nr"),
          connectionId: input.connectionId,
          externalId: resource.externalId,
          type: resource.type,
          title: resource.title,
          url: resource.url ?? null,
          parentExternalId: resource.parentExternalId ?? null,
        })),
      )
      .returning()
  })
}

export async function updateNotionResourceSyncState(input: {
  connectionId: string
  externalId: string
  lastSyncedAt: Date
}): Promise<void> {
  const db = getOrgDb()
  await db
    .update(notionResources)
    .set({ lastSyncedAt: input.lastSyncedAt, updatedAt: new Date() })
    .where(
      and(
        eq(notionResources.connectionId, input.connectionId),
        eq(notionResources.externalId, input.externalId),
      ),
    )
}

export async function getNotionSyncTargetByConnectionId(
  connectionId: string,
): Promise<NotionSyncTarget | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(notionSyncTargets)
    .where(eq(notionSyncTargets.connectionId, connectionId))
    .limit(1)
  return row
}

export async function getNotionSyncTargetWithRepoByConnectionId(
  orgId: string,
  connectionId: string,
): Promise<NotionSyncTargetWithRepo | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({
      id: notionSyncTargets.id,
      orgId: notionSyncTargets.orgId,
      connectionId: notionSyncTargets.connectionId,
      repositoryId: notionSyncTargets.repositoryId,
      branch: notionSyncTargets.branch,
      enabled: notionSyncTargets.enabled,
      setupPhase: notionSyncTargets.setupPhase,
      pendingConfigPullUrl: notionSyncTargets.pendingConfigPullUrl,
      pendingConfigPrCreating: notionSyncTargets.pendingConfigPrCreating,
      createdAt: notionSyncTargets.createdAt,
      updatedAt: notionSyncTargets.updatedAt,
      repositoryName: repositories.name,
      githubConnectionId: repositories.githubConnectionId,
    })
    .from(notionSyncTargets)
    .innerJoin(
      repositories,
      eq(notionSyncTargets.repositoryId, repositories.id),
    )
    .where(
      and(
        eq(notionSyncTargets.orgId, orgId),
        eq(notionSyncTargets.connectionId, connectionId),
        eq(repositories.orgId, orgId),
      ),
    )
    .limit(1)
  return row
}

export async function listNotionSyncTargetsWithRepoByRepositoryId(
  repositoryId: string,
): Promise<NotionSyncTargetWithRepo[]> {
  const db = getSystemDb()
  return db
    .select({
      id: notionSyncTargets.id,
      orgId: notionSyncTargets.orgId,
      connectionId: notionSyncTargets.connectionId,
      repositoryId: notionSyncTargets.repositoryId,
      branch: notionSyncTargets.branch,
      enabled: notionSyncTargets.enabled,
      setupPhase: notionSyncTargets.setupPhase,
      pendingConfigPullUrl: notionSyncTargets.pendingConfigPullUrl,
      pendingConfigPrCreating: notionSyncTargets.pendingConfigPrCreating,
      createdAt: notionSyncTargets.createdAt,
      updatedAt: notionSyncTargets.updatedAt,
      repositoryName: repositories.name,
      githubConnectionId: repositories.githubConnectionId,
    })
    .from(notionSyncTargets)
    .innerJoin(
      repositories,
      eq(notionSyncTargets.repositoryId, repositories.id),
    )
    .where(eq(notionSyncTargets.repositoryId, repositoryId))
}

export async function markAwaitingNotionConfigMerge(input: {
  connectionId: string
}): Promise<void> {
  const db = getSystemDb()
  await db
    .update(notionSyncTargets)
    .set({
      setupPhase: "awaiting_merge",
      pendingConfigPrCreating: true,
      updatedAt: new Date(),
    })
    .where(eq(notionSyncTargets.connectionId, input.connectionId))
}

export async function updateNotionSyncTargetPrState(input: {
  connectionId: string
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  setupPhase: string
}): Promise<void> {
  const db = getSystemDb()
  await db
    .update(notionSyncTargets)
    .set({
      pendingConfigPullUrl: input.pendingConfigPullUrl,
      pendingConfigPrCreating: input.pendingConfigPrCreating,
      setupPhase: input.setupPhase,
      updatedAt: new Date(),
    })
    .where(eq(notionSyncTargets.connectionId, input.connectionId))
}

export async function markNotionSyncTargetInitialSync(input: {
  connectionId: string
}): Promise<void> {
  const db = getSystemDb()
  await db
    .update(notionSyncTargets)
    .set({
      setupPhase: "initial_sync",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      enabled: true,
      updatedAt: new Date(),
    })
    .where(eq(notionSyncTargets.connectionId, input.connectionId))
}

export async function markNotionSyncTargetLive(input: {
  connectionId: string
}): Promise<void> {
  const db = getSystemDb()
  await db
    .update(notionSyncTargets)
    .set({
      setupPhase: "live",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      enabled: true,
      updatedAt: new Date(),
    })
    .where(eq(notionSyncTargets.connectionId, input.connectionId))
}

export async function resetNotionConnectorAfterMissingConfig(input: {
  orgId: string
  connectionId: string
}): Promise<void> {
  const db = getSystemDb()
  await db
    .update(notionSyncTargets)
    .set({
      setupPhase: "draft",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      enabled: false,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(notionSyncTargets.orgId, input.orgId),
        eq(notionSyncTargets.connectionId, input.connectionId),
      ),
    )
}

export async function finalizeNotionSyncTargetAfterContentWorkflow(input: {
  connectionId: string
  workflowStatus: "completed" | "partial_failed" | "failed"
}): Promise<void> {
  if (input.workflowStatus === "failed") return
  const db = getSystemDb()
  await db
    .update(notionSyncTargets)
    .set({
      setupPhase: "live",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(notionSyncTargets.connectionId, input.connectionId),
        eq(notionSyncTargets.setupPhase, "initial_sync"),
      ),
    )
}

type SyncTargetPatchInput = {
  repositoryId?: string
  repositoryName?: string
  gitUrl?: string
  branch: string
  enabled: boolean
}

async function resolveRepositoryIdForNotionSync(
  tx: Db,
  orgId: string,
  sync: SyncTargetPatchInput,
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

  const gitUrl = sync.gitUrl
  const name = sync.repositoryName
  if (!gitUrl || !name) {
    throw new Error("Repository not found for organization")
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
      githubConnectionId: defaultGithubConnectionId ?? null,
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

export async function patchNotionConnectorConfig(input: {
  orgId: string
  connectionId: string
  resources?: Array<{
    externalId: string
    type: "page" | "database"
    title: string
    url?: string | null
    parentExternalId?: string | null
  }>
  syncTarget?: SyncTargetPatchInput
}): Promise<{
  resources: NotionResource[]
  repositoryIngestion?: { orgId: string; repositoryId: string }
}> {
  const defaultGithubConnectionId = (
    await listGithubConnectionsForOrg(input.orgId)
  )[0]?.id

  const db = getOrgDb()
  return db.transaction(async (tx) => {
    let repositoryIngestion: { orgId: string; repositoryId: string } | undefined

    if (input.resources !== undefined) {
      await tx
        .delete(notionResources)
        .where(eq(notionResources.connectionId, input.connectionId))
      if (input.resources.length > 0) {
        await tx.insert(notionResources).values(
          input.resources.map((resource) => ({
            id: generateObjectId("nr"),
            connectionId: input.connectionId,
            externalId: resource.externalId,
            type: resource.type,
            title: resource.title,
            url: resource.url ?? null,
            parentExternalId: resource.parentExternalId ?? null,
          })),
        )
      }
    }

    if (input.syncTarget !== undefined) {
      const { repositoryId, didCreate } =
        await resolveRepositoryIdForNotionSync(
          tx,
          input.orgId,
          input.syncTarget,
          defaultGithubConnectionId,
        )
      if (didCreate) {
        repositoryIngestion = { orgId: input.orgId, repositoryId }
      }

      const [row] = await tx
        .insert(notionSyncTargets)
        .values({
          id: generateObjectId("nst"),
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
          target: notionSyncTargets.connectionId,
          set: {
            repositoryId,
            branch: input.syncTarget.branch,
            enabled: input.syncTarget.enabled,
            updatedAt: new Date(),
          },
        })
        .returning()

      if (!row) throw new Error("Failed to save Notion sync target")
    }

    const resources = await tx
      .select()
      .from(notionResources)
      .where(eq(notionResources.connectionId, input.connectionId))

    return { resources, repositoryIngestion }
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
