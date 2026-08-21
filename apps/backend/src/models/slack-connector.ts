import { and, desc, eq, sql } from "drizzle-orm"
import type { Env } from "../config/env.js"
import { getOrgDb, withOrgDbContext } from "../db/client.js"
import { withAmbientOrgDb } from "../db/org-sql.js"
import { CONNECTION_TYPE_SLACK, connections } from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import {
  derivedSlackSetupPhase,
  encodeSlackBotTokenForDb,
  parseSlackConnectionStored,
  type SlackSetupPhase,
  serialiseSlackConnectionConfigForDb,
} from "../lib/connection-config.js"
import { generateObjectId } from "../lib/id.js"
import {
  deleteConnectionDirectory,
  listConnectionDirectoryBySlackTeamId,
  loadConnectionViaDirectory,
  upsertConnectionDirectory,
} from "./connection-directory.js"
import {
  type ConnectionRow,
  type SlackConnectionShape,
  slackConnectionToShape,
  slackShapeToConfig,
} from "./connection-rows.js"
import { DEFAULT_CHECKOUT_KEY } from "./repositories.js"

function orgSql<T>(fn: () => Promise<T>): Promise<T> {
  return withAmbientOrgDb(fn)
}

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
  return orgSql(async () => {
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
  })
}

export async function getSlackConnectionByConnectionId(
  orgId: string,
  connectionId: string,
): Promise<SlackConnection | undefined> {
  return orgSql(async () => {
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
  })
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

  const row = await orgSql(async () => {
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
      const [updated] = await db
        .update(connections)
        .set({ config, updatedAt: new Date() })
        .where(eq(connections.id, existing.id))
        .returning()
      if (!updated) throw new Error("Failed to update Slack connection")
      return updated
    }

    const [created] = await db
      .insert(connections)
      .values({
        id: generateObjectId("con"),
        orgId: input.orgId,
        type: CONNECTION_TYPE_SLACK,
        config,
      })
      .returning()
    if (!created) throw new Error("Failed to create Slack connection")
    return created
  })
  await upsertConnectionDirectory(row)
  return slackConnectionToShape(row)
}

export async function deleteSlackConnectionById(
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
          eq(connections.type, CONNECTION_TYPE_SLACK),
        ),
      )
      .returning({ id: connections.id })
    return deleted.length > 0
  })
  if (removed) await deleteConnectionDirectory(connectionId)
  return removed
}

export async function revokeSlackConnectionByTeamId(
  teamId: string,
): Promise<boolean> {
  const connection = await getSlackConnectionByTeamId(teamId)
  if (!connection) return false
  const {
    id: _id,
    orgId: _orgId,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...shape
  } = connection
  const updated = await withOrgDbContext(connection.orgId, async (tx) => {
    const [row] = await tx
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
      .returning()
    return row
  })
  if (!updated) return false
  await upsertConnectionDirectory(updated)
  return true
}

export async function getSlackBindingWithRepoByConnectionId(
  orgId: string,
  connectionId: string,
): Promise<SlackBindingWithRepo | undefined> {
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
  })
}

/** @deprecated Prefer {@link getSlackBindingWithRepoByConnectionId}. */
export const getSlackSyncTargetWithRepoByConnectionId =
  getSlackBindingWithRepoByConnectionId

export async function getSlackConnectionByTeamId(
  teamId: string,
): Promise<SlackConnection | undefined> {
  const directoryRows = await listConnectionDirectoryBySlackTeamId(teamId)
  const rows = await Promise.all(
    directoryRows.map((row) => loadConnectionViaDirectory(row.connectionId)),
  )
  const match = rows.find((row) => row?.type === CONNECTION_TYPE_SLACK)
  return match ? slackConnectionToShape(match) : undefined
}

export async function getSlackBindingByConnectionId(
  connectionId: string,
): Promise<SlackBinding | undefined> {
  const row = await loadConnectionViaDirectory(connectionId)
  if (row?.type !== CONNECTION_TYPE_SLACK) return undefined
  return bindingFromConnectionRow(row)
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
      orgId: input.orgId,
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
  const result = await withOrgDbContext(input.orgId, async (tx) => {
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
      row: updated,
      binding,
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
  await upsertConnectionDirectory(result.row)
  return {
    ...result.binding,
    setupPhase: result.setupPhase,
    ...(result.repositoryIngestion
      ? { repositoryIngestion: result.repositoryIngestion }
      : {}),
  }
}

/** Clear Slack capture bindings that pointed at a repository about to be deleted. */
export async function clearSlackSyncBindingsForRepository(input: {
  orgId: string
  repositoryId: string
}): Promise<number> {
  const updatedRows = await orgSql(async () => {
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
    const rows: ConnectionRow[] = []
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
      const [updated] = await db
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
        .returning()
      if (updated) rows.push(updated)
    }
    return rows
  })
  await Promise.all(updatedRows.map((row) => upsertConnectionDirectory(row)))
  return updatedRows.length
}
