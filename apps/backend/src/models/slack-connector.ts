import { and, desc, eq, sql } from "drizzle-orm"
import type { Env } from "../config/env.js"
import { getOrgDb, getSystemDb } from "../db/client.js"
import { CONNECTION_TYPE_SLACK, connections } from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import {
  type SlackSetupPhase,
  slackSyncTargets,
} from "../db/schema/slackSyncTargets.js"
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
import { DEFAULT_CHECKOUT_KEY } from "./repositories.js"

export type SlackConnection = SlackConnectionShape
export type SlackSyncTarget = typeof slackSyncTargets.$inferSelect

export type SlackSyncTargetWithRepo = SlackSyncTarget & {
  repositoryName: string
  githubConnectionId: string | null
}

/**
 * Coerce legacy channel-mirror phases onto the capture-only `draft` | `live`
 * contract so existing preview/prod rows keep working after ADR-025 revisit.
 */
export function normalizeSlackSetupPhase(
  phase: string | null | undefined,
): SlackSetupPhase {
  if (
    phase === "live" ||
    phase === "awaiting_merge" ||
    phase === "initial_sync" ||
    phase === "sync_failed"
  ) {
    return "live"
  }
  return "draft"
}

function withNormalizedSlackSetupPhase<T extends { setupPhase: string }>(
  row: T,
): T & { setupPhase: SlackSetupPhase } {
  return { ...row, setupPhase: normalizeSlackSetupPhase(row.setupPhase) }
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

export const SLACK_TEAM_ALREADY_CONNECTED_MESSAGE =
  "This Slack workspace is already connected to another ctx| organization"

export class SlackTeamAlreadyConnectedError extends Error {
  constructor() {
    super(SLACK_TEAM_ALREADY_CONNECTED_MESSAGE)
    this.name = "SlackTeamAlreadyConnectedError"
  }
}

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
  botHandle?: string | null
  appId?: string | null
}): Promise<SlackConnection> {
  const existingForTeam = await getSlackConnectionByTeamId(input.teamId)
  if (existingForTeam && existingForTeam.orgId !== input.orgId) {
    throw new SlackTeamAlreadyConnectedError()
  }

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
    botHandle: input.botHandle ?? existingForTeam?.botHandle ?? null,
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

export async function revokeSlackConnectionByTeamId(
  teamId: string,
): Promise<boolean> {
  const connection = await getSlackConnectionByTeamId(teamId)
  if (!connection) return false
  const db = getSystemDb()
  const {
    id: _id,
    orgId: _orgId,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...shape
  } = connection
  await db.transaction(async (tx) => {
    await tx
      .update(connections)
      .set({
        config: slackShapeToConfig({ ...shape, status: "revoked" }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, connection.id))
    await tx
      .update(slackSyncTargets)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(slackSyncTargets.connectionId, connection.id))
  })
  return true
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
      createdAt: slackSyncTargets.createdAt,
      updatedAt: slackSyncTargets.updatedAt,
      repositoryName: repositories.name,
      githubConnectionId: repositories.githubConnectionId,
    })
    .from(slackSyncTargets)
    .innerJoin(repositories, eq(slackSyncTargets.repositoryId, repositories.id))
    .where(
      and(
        eq(slackSyncTargets.orgId, orgId),
        eq(slackSyncTargets.connectionId, connectionId),
        eq(repositories.orgId, orgId),
      ),
    )
    .limit(1)
  return row ? withNormalizedSlackSetupPhase(row) : undefined
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

/** @deprecated Use getSlackConnectionByTeamId — one Slack team maps to one org. */
export async function listSlackConnectionsByTeamId(
  teamId: string,
): Promise<SlackConnection[]> {
  const connection = await getSlackConnectionByTeamId(teamId)
  return connection ? [connection] : []
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
  return row ? withNormalizedSlackSetupPhase(row) : undefined
}

export class SlackRepositoryNotFoundError extends Error {
  constructor() {
    super("Repository not found for organization")
    this.name = "SlackRepositoryNotFoundError"
  }
}

export type SlackBindRepositoryInput = {
  orgId: string
  connectionId: string
  repositoryId?: string
  repositoryName?: string
  gitUrl?: string
  githubConnectionId?: string
  branch?: string
}

/**
 * Resolve an existing org repository or create one from GitHub installation
 * metadata — same create-on-bind path Notion/Linear/Confluence use so a newly
 * created `ctxpipe-context` can be selected without a repositories-page detour.
 */
async function resolveRepositoryIdForSlackSync(
  db: ReturnType<typeof getOrgDb>,
  input: SlackBindRepositoryInput,
): Promise<{ repositoryId: string; branch: string }> {
  if (input.repositoryId) {
    const [byId] = await db
      .select({
        id: repositories.id,
        defaultBranch: repositoryCheckouts.ref,
      })
      .from(repositories)
      .leftJoin(
        repositoryCheckouts,
        and(
          eq(repositoryCheckouts.repositoryId, repositories.id),
          eq(repositoryCheckouts.checkoutKey, DEFAULT_CHECKOUT_KEY),
        ),
      )
      .where(
        and(
          eq(repositories.id, input.repositoryId),
          eq(repositories.orgId, input.orgId),
        ),
      )
      .limit(1)
    if (!byId) throw new SlackRepositoryNotFoundError()
    return {
      repositoryId: byId.id,
      branch: input.branch ?? byId.defaultBranch ?? "main",
    }
  }

  const gitUrl = input.gitUrl
  const name = input.repositoryName
  if (!gitUrl || !name) throw new SlackRepositoryNotFoundError()

  const [byUrl] = await db
    .select({
      id: repositories.id,
      defaultBranch: repositoryCheckouts.ref,
    })
    .from(repositories)
    .leftJoin(
      repositoryCheckouts,
      and(
        eq(repositoryCheckouts.repositoryId, repositories.id),
        eq(repositoryCheckouts.checkoutKey, DEFAULT_CHECKOUT_KEY),
      ),
    )
    .where(
      and(eq(repositories.orgId, input.orgId), eq(repositories.gitUrl, gitUrl)),
    )
    .limit(1)
  if (byUrl) {
    return {
      repositoryId: byUrl.id,
      branch: input.branch ?? byUrl.defaultBranch ?? "main",
    }
  }

  const repositoryId = generateObjectId("repo")
  const branch = input.branch ?? "main"
  const [created] = await db
    .insert(repositories)
    .values({
      id: repositoryId,
      orgId: input.orgId,
      name,
      gitUrl,
      githubConnectionId: input.githubConnectionId ?? null,
    })
    .returning({ id: repositories.id })
  if (!created) throw new Error("Failed to create repository")

  const [checkout] = await db
    .insert(repositoryCheckouts)
    .values({
      id: generateObjectId("co"),
      repositoryId,
      ref: branch,
      checkoutKey: DEFAULT_CHECKOUT_KEY,
    })
    .returning({ id: repositoryCheckouts.id })
  if (!checkout) throw new Error("Failed to create repository checkout")

  return { repositoryId, branch }
}

/**
 * Bind (or rebind) a context repository to a Slack connection and flip the
 * setup phase straight to `live` — there is no channel scope or config PR
 * gate to wait on for capture-based ingest (ADR-025 §5).
 */
export async function bindSlackSyncTargetRepository(
  input: SlackBindRepositoryInput,
): Promise<SlackSyncTarget> {
  const db = getOrgDb()
  return db.transaction(async (tx) => {
    const { repositoryId, branch } = await resolveRepositoryIdForSlackSync(
      tx,
      input,
    )

    const [row] = await tx
      .insert(slackSyncTargets)
      .values({
        id: generateObjectId("sst"),
        orgId: input.orgId,
        connectionId: input.connectionId,
        repositoryId,
        branch,
        enabled: true,
        setupPhase: "live",
      })
      .onConflictDoUpdate({
        target: slackSyncTargets.connectionId,
        set: {
          repositoryId,
          branch,
          enabled: true,
          setupPhase: "live",
          updatedAt: new Date(),
        },
      })
      .returning()
    if (!row) throw new Error("Failed to save Slack sync target")
    return row
  })
}
