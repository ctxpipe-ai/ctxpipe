import { and, desc, eq, sql } from "drizzle-orm"
import type { Env } from "../config/env.js"
import { getOrgDb, getSystemDb } from "../db/client.js"
import { CONNECTION_TYPE_SLACK, connections } from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import {
  derivedSlackSetupPhase,
  encodeSlackBotTokenForDb,
  parseSlackConnectionStored,
  serialiseSlackConnectionConfigForDb,
  type SlackSetupPhase,
} from "../lib/connection-config.js"
import { generateObjectId } from "../lib/id.js"
import {
  type ConnectionRow,
  type SlackConnectionShape,
  slackConnectionToShape,
  slackShapeToConfig,
} from "./connection-rows.js"
import { DEFAULT_CHECKOUT_KEY } from "./repositories.js"

export type { SlackSetupPhase } from "../lib/connection-config.js"
export {
  derivedSlackSetupPhase,
  SLACK_SETUP_PHASES,
} from "../lib/connection-config.js"

export type SlackConnection = SlackConnectionShape

/** Sync binding projected from `connections.config` (+ timestamps from the connection row). */
export type SlackBinding = {
  id: string
  orgId: string
  connectionId: string
  repositoryId: string
  branch: string
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

export type SlackBindingWithRepo = SlackBinding & {
  repositoryName: string
  githubConnectionId: string | null
}

/** Capture/write path still uses this name; same shape as {@link SlackBinding}. */
export type SlackSyncTarget = SlackBinding
export type SlackSyncTargetWithRepo = SlackBindingWithRepo

function bindingFromConnectionRow(
  row: ConnectionRow,
): SlackBinding | undefined {
  const config = parseSlackConnectionStored(
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function mergeSlackStoredConfig(
  row: ConnectionRow,
  patch: Partial<{
    repositoryId: string | null
    branch: string | null
    enabled: boolean
    status: string
  }>,
): Record<string, unknown> {
  const stored = parseSlackConnectionStored(
    row.config as Record<string, unknown>,
  )
  return serialiseSlackConnectionConfigForDb({
    ...stored,
    ...patch,
  } as Parameters<typeof serialiseSlackConnectionConfigForDb>[0])
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
  const existingStored = existing
    ? parseSlackConnectionStored(existing.config as Record<string, unknown>)
    : undefined
  const config = serialiseSlackConnectionConfigForDb({
    ...existingStored,
    botTokenEnc,
    teamId: input.teamId,
    teamName: input.teamName ?? existingStored?.teamName ?? null,
    botUserId: input.botUserId ?? existingStored?.botUserId ?? null,
    botHandle:
      input.botHandle ??
      existingStored?.botHandle ??
      existingForTeam?.botHandle ??
      null,
    appId: input.appId ?? existingStored?.appId ?? null,
    ownerUserId: input.ownerUserId,
    status: "installed",
  } as Parameters<typeof serialiseSlackConnectionConfigForDb>[0])

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
  await db
    .update(connections)
    .set({
      config: slackShapeToConfig({
        ...shape,
        status: "revoked",
        enabled: false,
      }),
      updatedAt: new Date(),
    })
    .where(eq(connections.id, connection.id))
  return true
}

export async function getSlackBindingWithRepoByConnectionId(
  orgId: string,
  connectionId: string,
): Promise<SlackBindingWithRepo | undefined> {
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
        eq(connections.type, CONNECTION_TYPE_SLACK),
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

/** @deprecated Prefer {@link getSlackBindingWithRepoByConnectionId}. */
export const getSlackSyncTargetWithRepoByConnectionId =
  getSlackBindingWithRepoByConnectionId

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

export async function getSlackBindingByConnectionId(
  connectionId: string,
): Promise<SlackBinding | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.type, CONNECTION_TYPE_SLACK),
      ),
    )
    .limit(1)
  return row ? bindingFromConnectionRow(row) : undefined
}

/** @deprecated Prefer {@link getSlackBindingByConnectionId}. */
export const getSlackSyncTargetByConnectionId = getSlackBindingByConnectionId

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

export type SlackBindRepositoryResult = SlackBinding & {
  setupPhase: SlackSetupPhase
  repositoryIngestion?: {
    orgId: string
    repositoryId: string
    targetBranch?: string
  }
}

/**
 * Resolve an existing org repository or create one from GitHub installation
 * metadata — same create-on-bind path Notion/Linear use so a newly
 * created `ctxpipe-context` can be selected without a repositories-page detour.
 */
async function resolveRepositoryIdForSlackSync(
  db: ReturnType<typeof getOrgDb>,
  input: SlackBindRepositoryInput,
): Promise<{ repositoryId: string; branch: string; didCreate: boolean }> {
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
      didCreate: false,
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
      didCreate: false,
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

  return { repositoryId, branch, didCreate: true }
}

/**
 * Bind (or rebind) a context repository to a Slack connection.
 * Capture is live as soon as the repo is bound — there is no config PR gate
 * (ADR-025 §5).
 */
export async function bindSlackSyncTargetRepository(
  input: SlackBindRepositoryInput,
): Promise<SlackBindRepositoryResult> {
  const db = getOrgDb()
  return db.transaction(async (tx) => {
    const { repositoryId, branch, didCreate } =
      await resolveRepositoryIdForSlackSync(tx, input)

    const [connectionRow] = await tx
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
    if (!connectionRow) {
      throw new Error("Slack connection does not belong to organization")
    }

    const [updated] = await tx
      .update(connections)
      .set({
        config: mergeSlackStoredConfig(connectionRow, {
          repositoryId,
          branch,
          enabled: true,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
      .returning()
    if (!updated) throw new Error("Failed to save Slack sync binding")
    const binding = bindingFromConnectionRow(updated)
    if (!binding) throw new Error("Failed to save Slack sync binding")
    return {
      ...binding,
      setupPhase: derivedSlackSetupPhase(binding),
      ...(didCreate
        ? {
            repositoryIngestion: {
              orgId: input.orgId,
              repositoryId,
              targetBranch: branch,
            },
          }
        : {}),
    }
  })
}

/** Clear Slack capture bindings that pointed at a repository about to be deleted. */
export async function clearSlackSyncBindingsForRepository(input: {
  orgId: string
  repositoryId: string
}): Promise<number> {
  const db = getOrgDb()
  const ids = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.orgId, input.orgId),
        eq(connections.type, CONNECTION_TYPE_SLACK),
        eq(sql`${connections.config}->>'repositoryId'`, input.repositoryId),
      ),
    )
  let cleared = 0
  for (const { id } of ids) {
    const [row] = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, id),
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_SLACK),
          eq(sql`${connections.config}->>'repositoryId'`, input.repositoryId),
        ),
      )
      .limit(1)
    if (!row) continue
    await db
      .update(connections)
      .set({
        config: mergeSlackStoredConfig(row, {
          repositoryId: null,
          branch: null,
          enabled: false,
        }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, id))
    cleared += 1
  }
  return cleared
}
