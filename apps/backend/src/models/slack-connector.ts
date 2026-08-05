import { and, asc, desc, eq, sql } from "drizzle-orm"
import type { Env } from "../config/env.js"
import type { Db } from "../db/client.js"
import {
  getOrgDb,
  getSystemDb,
  withOrgDbContext,
} from "../db/client.js"
import {
  CONNECTION_TYPE_SLACK,
  connections,
} from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import { slackChannels } from "../db/schema/slackChannels.js"
import { slackDirtyThreads } from "../db/schema/slackDirtyThreads.js"
import { slackSyncTargets } from "../db/schema/slackSyncTargets.js"
import {
  encodeSlackBotTokenForDb,
  serialiseSlackConnectionConfigForDb,
} from "../lib/connection-config.js"
import { generateObjectId } from "../lib/id.js"
import {
  type SlackConnectionShape,
  slackConnectionToShape,
  slackShapeToConfig,
} from "./connection-rows.js"
import { listGithubConnectionsForOrg } from "./github-installation.js"
import { DEFAULT_CHECKOUT_KEY } from "./repositories.js"

export type SlackConnection = SlackConnectionShape
export type SlackChannelRow = typeof slackChannels.$inferSelect
export type SlackSyncTarget = typeof slackSyncTargets.$inferSelect

export type SlackSyncTargetWithRepo = SlackSyncTarget & {
  repositoryName: string
  githubConnectionId: string | null
}

function slackConfigTeamIdRef() {
  return sql<string>`${connections.config}->>'teamId'`
}

export async function listSlackConnectionsForOrg(
  orgId: string,
): Promise<SlackConnection[]> {
  const db = getOrgDb()
  const rows = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.orgId, orgId),
        eq(connections.type, CONNECTION_TYPE_SLACK),
      ),
    )
    .orderBy(desc(connections.updatedAt))
  return rows.map(slackConnectionToShape)
}

export async function getSlackConnectionByConnectionId(
  orgId: string,
  connectionId: string,
): Promise<SlackConnection | undefined> {
  const db = getOrgDb()
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.orgId, orgId),
        eq(connections.type, CONNECTION_TYPE_SLACK),
      ),
    )
    .limit(1)
  return row ? slackConnectionToShape(row) : undefined
}

export const MULTIPLE_SLACK_CONNECTIONS_MESSAGE =
  "Multiple Slack connections for this organization; specify connectionId query parameter"

export type ResolveSlackConnectionResult =
  | { status: "ok"; connection: SlackConnection }
  | { status: "none" }
  | { status: "ambiguous" }

export async function resolveSlackConnectionForOrgDetailed(
  orgId: string,
  connectionId?: string | null,
): Promise<ResolveSlackConnectionResult> {
  if (connectionId) {
    const connection = await getSlackConnectionByConnectionId(
      orgId,
      connectionId,
    )
    return connection ? { status: "ok", connection } : { status: "none" }
  }
  const list = await listSlackConnectionsForOrg(orgId)
  if (list.length === 0) return { status: "none" }
  const [connection] = list
  if (list.length === 1 && connection) {
    return { status: "ok", connection }
  }
  return { status: "ambiguous" }
}

export async function upsertSlackConnectionFromOAuth(input: {
  orgId: string
  env: Env
  ownerUserId: string
  botToken: string
  teamId: string
  teamName?: string | null
  botUserId?: string | null
  appId?: string | null
}): Promise<SlackConnection> {
  const db = getOrgDb()
  const [existing] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.orgId, input.orgId),
        eq(connections.type, CONNECTION_TYPE_SLACK),
        eq(slackConfigTeamIdRef(), input.teamId),
      ),
    )
    .orderBy(desc(connections.updatedAt))
    .limit(1)

  const botTokenEnc = encodeSlackBotTokenForDb(input.botToken, input.env)
  const config = serialiseSlackConnectionConfigForDb({
    botTokenEnc,
    teamId: input.teamId,
    teamName: input.teamName ?? null,
    botUserId: input.botUserId ?? null,
    appId: input.appId ?? null,
    ownerUserId: input.ownerUserId,
    status: "installed",
    lastEventPayload:
      existing &&
      typeof (existing.config as Record<string, unknown>).lastEventPayload !==
        "undefined"
        ? (existing.config as Record<string, unknown>).lastEventPayload
        : null,
  })

  if (existing) {
    const [row] = await db
      .update(connections)
      .set({ config, updatedAt: new Date() })
      .where(eq(connections.id, existing.id))
      .returning()
    if (!row) throw new Error("Failed to update Slack connection")
    return slackConnectionToShape(row)
  }

  const [row] = await db
    .insert(connections)
    .values({
      id: generateObjectId("con"),
      orgId: input.orgId,
      type: CONNECTION_TYPE_SLACK,
      config,
    })
    .returning()
  if (!row) throw new Error("Failed to create Slack connection")
  return slackConnectionToShape(row)
}

export async function deleteSlackConnectionById(
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
        eq(connections.type, CONNECTION_TYPE_SLACK),
      ),
    )
    .returning({ id: connections.id })
  return removed.length > 0
}

export async function listSlackChannelsByConnectionId(
  connectionId: string,
): Promise<SlackChannelRow[]> {
  const db = getOrgDb()
  return db
    .select()
    .from(slackChannels)
    .where(eq(slackChannels.connectionId, connectionId))
    .orderBy(asc(slackChannels.name))
}

export async function replaceSlackChannelsForConnection(input: {
  connectionId: string
  channels: Array<{ channelId: string; name: string; isPrivate: boolean }>
}): Promise<SlackChannelRow[]> {
  const db = getOrgDb()
  return db.transaction(async (tx) => {
    await tx
      .delete(slackChannels)
      .where(eq(slackChannels.connectionId, input.connectionId))
    if (input.channels.length === 0) return []
    return tx
      .insert(slackChannels)
      .values(
        input.channels.map((channel) => ({
          id: generateObjectId("sch"),
          connectionId: input.connectionId,
          channelId: channel.channelId,
          name: channel.name,
          isPrivate: channel.isPrivate,
        })),
      )
      .returning()
  })
}

export async function getSlackSyncTargetWithRepoByConnectionId(
  orgId: string,
  connectionId: string,
): Promise<SlackSyncTargetWithRepo | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({
      id: slackSyncTargets.id,
      orgId: slackSyncTargets.orgId,
      connectionId: slackSyncTargets.connectionId,
      repositoryId: slackSyncTargets.repositoryId,
      branch: slackSyncTargets.branch,
      enabled: slackSyncTargets.enabled,
      setupPhase: slackSyncTargets.setupPhase,
      pendingConfigPullUrl: slackSyncTargets.pendingConfigPullUrl,
      pendingConfigPrCreating: slackSyncTargets.pendingConfigPrCreating,
      oldestDays: slackSyncTargets.oldestDays,
      createdAt: slackSyncTargets.createdAt,
      updatedAt: slackSyncTargets.updatedAt,
      repositoryName: repositories.name,
      githubConnectionId: repositories.githubConnectionId,
    })
    .from(slackSyncTargets)
    .innerJoin(
      repositories,
      eq(slackSyncTargets.repositoryId, repositories.id),
    )
    .where(
      and(
        eq(slackSyncTargets.orgId, orgId),
        eq(slackSyncTargets.connectionId, connectionId),
        eq(repositories.orgId, orgId),
      ),
    )
    .limit(1)
  return row
}

export async function getSlackConnectionByTeamId(
  teamId: string,
): Promise<SlackConnection | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.type, CONNECTION_TYPE_SLACK),
        eq(slackConfigTeamIdRef(), teamId),
      ),
    )
    .orderBy(desc(connections.updatedAt))
    .limit(1)
  return row ? slackConnectionToShape(row) : undefined
}

/** Mark a thread dirty for coalesced flush. Safe under concurrent Events. */
export async function markSlackThreadDirty(input: {
  connectionId: string
  channelId: string
  threadTs: string
  eventAt?: Date
}): Promise<void> {
  const db = getSystemDb()
  const now = input.eventAt ?? new Date()
  const [existing] = await db
    .select()
    .from(slackDirtyThreads)
    .where(
      and(
        eq(slackDirtyThreads.connectionId, input.connectionId),
        eq(slackDirtyThreads.channelId, input.channelId),
        eq(slackDirtyThreads.threadTs, input.threadTs),
      ),
    )
    .limit(1)

  if (existing) {
    await db
      .update(slackDirtyThreads)
      .set({ lastEventAt: now })
      .where(eq(slackDirtyThreads.id, existing.id))
    return
  }

  await db.insert(slackDirtyThreads).values({
    id: generateObjectId("sdt"),
    connectionId: input.connectionId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    firstDirtyAt: now,
    lastEventAt: now,
  })
}

export async function withSlackOrgContext<T>(
  orgId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withOrgDbContext(orgId, fn)
}

/** Update non-secret metadata on a Slack connection config. */
export async function updateSlackConnectionStatus(input: {
  orgId: string
  connectionId: string
  status: string
}): Promise<void> {
  const db = getOrgDb()
  const [current] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, input.connectionId),
        eq(connections.orgId, input.orgId),
        eq(connections.type, CONNECTION_TYPE_SLACK),
      ),
    )
    .limit(1)
  if (!current) throw new Error("Slack connection not found")
  const shape = slackConnectionToShape(current)
  const config = slackShapeToConfig({
    ...shape,
    status: input.status,
  })
  await db
    .update(connections)
    .set({ config, updatedAt: new Date() })
    .where(eq(connections.id, input.connectionId))
}

export type SlackDirtyThreadRow = typeof slackDirtyThreads.$inferSelect

export async function listReadySlackDirtyThreads(
  connectionId: string,
): Promise<SlackDirtyThreadRow[]> {
  const db = getSystemDb()
  return db
    .select()
    .from(slackDirtyThreads)
    .where(eq(slackDirtyThreads.connectionId, connectionId))
    .orderBy(asc(slackDirtyThreads.firstDirtyAt))
}

export async function clearSlackDirtyThreads(input: {
  connectionId: string
  keys: Array<{ channelId: string; threadTs: string }>
}): Promise<void> {
  if (input.keys.length === 0) return
  const db = getSystemDb()
  for (const key of input.keys) {
    await db
      .delete(slackDirtyThreads)
      .where(
        and(
          eq(slackDirtyThreads.connectionId, input.connectionId),
          eq(slackDirtyThreads.channelId, key.channelId),
          eq(slackDirtyThreads.threadTs, key.threadTs),
        ),
      )
  }
}

export async function getSlackSyncTargetByConnectionId(
  connectionId: string,
): Promise<SlackSyncTarget | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(slackSyncTargets)
    .where(eq(slackSyncTargets.connectionId, connectionId))
    .limit(1)
  return row
}

export async function listSlackSyncTargetsWithRepoByRepositoryId(
  repositoryId: string,
): Promise<SlackSyncTargetWithRepo[]> {
  const db = getSystemDb()
  return db
    .select({
      id: slackSyncTargets.id,
      orgId: slackSyncTargets.orgId,
      connectionId: slackSyncTargets.connectionId,
      repositoryId: slackSyncTargets.repositoryId,
      branch: slackSyncTargets.branch,
      enabled: slackSyncTargets.enabled,
      setupPhase: slackSyncTargets.setupPhase,
      pendingConfigPullUrl: slackSyncTargets.pendingConfigPullUrl,
      pendingConfigPrCreating: slackSyncTargets.pendingConfigPrCreating,
      oldestDays: slackSyncTargets.oldestDays,
      createdAt: slackSyncTargets.createdAt,
      updatedAt: slackSyncTargets.updatedAt,
      repositoryName: repositories.name,
      githubConnectionId: repositories.githubConnectionId,
    })
    .from(slackSyncTargets)
    .innerJoin(
      repositories,
      eq(slackSyncTargets.repositoryId, repositories.id),
    )
    .where(eq(slackSyncTargets.repositoryId, repositoryId))
}

export async function claimSlackConfigPrCreation(input: {
  connectionId: string
}): Promise<void> {
  const db = getSystemDb()
  await db
    .update(slackSyncTargets)
    .set({
      setupPhase: "awaiting_merge",
      pendingConfigPrCreating: true,
      updatedAt: new Date(),
    })
    .where(eq(slackSyncTargets.connectionId, input.connectionId))
}

export async function releaseSlackConfigPrCreationClaim(input: {
  connectionId: string
  pendingConfigPullUrl: string | null
  setupPhase: string
}): Promise<void> {
  const db = getSystemDb()
  await db
    .update(slackSyncTargets)
    .set({
      pendingConfigPullUrl: input.pendingConfigPullUrl,
      pendingConfigPrCreating: false,
      setupPhase: input.setupPhase,
      updatedAt: new Date(),
    })
    .where(eq(slackSyncTargets.connectionId, input.connectionId))
}

export async function updateSlackSyncTargetPrState(input: {
  connectionId: string
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  setupPhase: string
}): Promise<void> {
  const db = getSystemDb()
  await db
    .update(slackSyncTargets)
    .set({
      pendingConfigPullUrl: input.pendingConfigPullUrl,
      pendingConfigPrCreating: input.pendingConfigPrCreating,
      setupPhase: input.setupPhase,
      updatedAt: new Date(),
    })
    .where(eq(slackSyncTargets.connectionId, input.connectionId))
}

export async function markSlackSyncTargetLive(input: {
  connectionId: string
}): Promise<void> {
  const db = getSystemDb()
  await db
    .update(slackSyncTargets)
    .set({
      setupPhase: "live",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      enabled: true,
      updatedAt: new Date(),
    })
    .where(eq(slackSyncTargets.connectionId, input.connectionId))
}

export async function markSlackSyncTargetInitialSync(input: {
  connectionId: string
}): Promise<void> {
  const db = getSystemDb()
  await db
    .update(slackSyncTargets)
    .set({
      setupPhase: "initial_sync",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      enabled: true,
      updatedAt: new Date(),
    })
    .where(eq(slackSyncTargets.connectionId, input.connectionId))
}

export async function finalizeSlackSyncTargetAfterContentWorkflow(input: {
  connectionId: string
  workflowStatus: "completed" | "partial_failed" | "failed"
}): Promise<void> {
  if (input.workflowStatus === "failed") return
  const db = getSystemDb()
  await db
    .update(slackSyncTargets)
    .set({
      setupPhase: "live",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(slackSyncTargets.connectionId, input.connectionId),
        eq(slackSyncTargets.setupPhase, "initial_sync"),
      ),
    )
}

type SyncTargetPatchInput = {
  repositoryId?: string
  repositoryName?: string
  gitUrl?: string
  githubConnectionId?: string
  branch: string
  enabled: boolean
  oldestDays?: number
}

async function resolveRepositoryIdForSlackSync(
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
      githubConnectionId:
        sync.githubConnectionId ?? defaultGithubConnectionId ?? null,
    })
    .returning()
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
  if (!checkout) {
    throw new Error("Failed to create repository checkout")
  }

  return { repositoryId: id, didCreate: true }
}

export async function patchSlackConnectorConfig(input: {
  orgId: string
  connectionId: string
  channels?: Array<{ channelId: string; name: string; isPrivate: boolean }>
  syncTarget?: SyncTargetPatchInput
}): Promise<{
  channels: SlackChannelRow[]
  repositoryIngestion?: { orgId: string; repositoryId: string }
}> {
  const defaultGithubConnectionId = (
    await listGithubConnectionsForOrg(input.orgId)
  )[0]?.id

  const db = getOrgDb()
  return db.transaction(async (tx) => {
    let repositoryIngestion: { orgId: string; repositoryId: string } | undefined

    if (input.channels !== undefined) {
      await tx
        .delete(slackChannels)
        .where(eq(slackChannels.connectionId, input.connectionId))
      if (input.channels.length > 0) {
        await tx.insert(slackChannels).values(
          input.channels.map((channel) => ({
            id: generateObjectId("sch"),
            connectionId: input.connectionId,
            channelId: channel.channelId,
            name: channel.name,
            isPrivate: channel.isPrivate,
          })),
        )
      }
    }

    if (input.syncTarget !== undefined) {
      const { repositoryId, didCreate } = await resolveRepositoryIdForSlackSync(
        tx,
        input.orgId,
        input.syncTarget,
        defaultGithubConnectionId,
      )
      if (didCreate) {
        repositoryIngestion = { orgId: input.orgId, repositoryId }
      }

      const [row] = await tx
        .insert(slackSyncTargets)
        .values({
          id: generateObjectId("sst"),
          orgId: input.orgId,
          connectionId: input.connectionId,
          repositoryId,
          branch: input.syncTarget.branch,
          enabled: input.syncTarget.enabled,
          oldestDays: input.syncTarget.oldestDays ?? 90,
          setupPhase: "draft",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
        })
        .onConflictDoUpdate({
          target: slackSyncTargets.connectionId,
          set: {
            repositoryId,
            branch: input.syncTarget.branch,
            enabled: input.syncTarget.enabled,
            oldestDays: input.syncTarget.oldestDays ?? 90,
            updatedAt: new Date(),
          },
        })
        .returning()
      if (!row) throw new Error("Failed to save Slack sync target")
    }

    const channels = await tx
      .select()
      .from(slackChannels)
      .where(eq(slackChannels.connectionId, input.connectionId))

    return { channels, repositoryIngestion }
  })
}
