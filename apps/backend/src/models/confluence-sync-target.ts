import { and, eq } from "drizzle-orm"
import {
  type Db,
  getOrgDb,
  getSystemDb,
  withOrgDbContext,
} from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { confluenceSyncTargets } from "../db/schema/confluenceSyncTargets.js"
import { CONNECTION_TYPE_FORGE, connections } from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"
import { generateObjectId } from "../lib/id.js"
import { getConnectionDirectoryByConnectionId } from "./connection-directory.js"

export type ConfluenceSyncTarget = typeof confluenceSyncTargets.$inferSelect

export type ConfluenceSyncTargetWithRepo = ConfluenceSyncTarget & {
  repositoryName: string
  githubConnectionId: string | null
}

async function withOrgDbForConnection<T>(
  connectionId: string,
  fn: (db: Db) => Promise<T>,
): Promise<T | undefined> {
  const directoryRow = await getConnectionDirectoryByConnectionId(connectionId)
  if (!directoryRow) return undefined
  return withOrgDbContext(directoryRow.orgId, fn)
}

export async function getConfluenceSyncTargetByOrgId(
  orgId: string,
): Promise<ConfluenceSyncTarget | undefined> {
  return withOrgDbContext(orgId, async () => {
    const [row] = await getOrgDb()
      .select()
      .from(confluenceSyncTargets)
      .where(eq(confluenceSyncTargets.orgId, orgId))
      .limit(1)
    return row
  })
}

export async function getConfluenceSyncTargetWithRepoByOrgId(
  orgId: string,
): Promise<ConfluenceSyncTargetWithRepo | undefined> {
  return withOrgDbContext(orgId, async () => {
    const [row] = await getOrgDb()
      .select({
        id: confluenceSyncTargets.id,
        orgId: confluenceSyncTargets.orgId,
        connectionId: confluenceSyncTargets.connectionId,
        repositoryId: confluenceSyncTargets.repositoryId,
        branch: confluenceSyncTargets.branch,
        enabled: confluenceSyncTargets.enabled,
        setupPhase: confluenceSyncTargets.setupPhase,
        pendingConfigPullUrl: confluenceSyncTargets.pendingConfigPullUrl,
        pendingConfigPrCreating: confluenceSyncTargets.pendingConfigPrCreating,
        createdAt: confluenceSyncTargets.createdAt,
        updatedAt: confluenceSyncTargets.updatedAt,
        repositoryName: repositories.name,
        githubConnectionId: repositories.githubConnectionId,
      })
      .from(confluenceSyncTargets)
      .innerJoin(
        repositories,
        eq(confluenceSyncTargets.repositoryId, repositories.id),
      )
      .where(
        and(
          eq(confluenceSyncTargets.orgId, orgId),
          eq(repositories.orgId, orgId),
        ),
      )
      .limit(1)
    return row
  })
}

export async function getConfluenceSyncTargetWithRepoByConnectionId(
  orgId: string,
  connectionId: string,
): Promise<ConfluenceSyncTargetWithRepo | undefined> {
  return withOrgDbContext(orgId, async () => {
    const [row] = await getOrgDb()
      .select({
        id: confluenceSyncTargets.id,
        orgId: confluenceSyncTargets.orgId,
        connectionId: confluenceSyncTargets.connectionId,
        repositoryId: confluenceSyncTargets.repositoryId,
        branch: confluenceSyncTargets.branch,
        enabled: confluenceSyncTargets.enabled,
        setupPhase: confluenceSyncTargets.setupPhase,
        pendingConfigPullUrl: confluenceSyncTargets.pendingConfigPullUrl,
        pendingConfigPrCreating: confluenceSyncTargets.pendingConfigPrCreating,
        createdAt: confluenceSyncTargets.createdAt,
        updatedAt: confluenceSyncTargets.updatedAt,
        repositoryName: repositories.name,
        githubConnectionId: repositories.githubConnectionId,
      })
      .from(confluenceSyncTargets)
      .innerJoin(
        repositories,
        eq(confluenceSyncTargets.repositoryId, repositories.id),
      )
      .where(
        and(
          eq(confluenceSyncTargets.orgId, orgId),
          eq(confluenceSyncTargets.connectionId, connectionId),
          eq(repositories.orgId, orgId),
        ),
      )
      .limit(1)
    return row
  })
}

export async function getConfluenceSyncTargetByConnectionId(
  connectionId: string,
): Promise<ConfluenceSyncTarget | undefined> {
  return withOrgDbForConnection(connectionId, async (db) => {
    const [row] = await db
      .select()
      .from(confluenceSyncTargets)
      .where(eq(confluenceSyncTargets.connectionId, connectionId))
      .limit(1)
    return row
  })
}

export async function getOrganizationSlugByOrgId(
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

export async function listConfluenceSyncTargetsByRepositoryId(
  orgId: string,
  repositoryId: string,
): Promise<ConfluenceSyncTarget[]> {
  return withOrgDbContext(orgId, async () => {
    return getOrgDb()
      .select()
      .from(confluenceSyncTargets)
      .where(eq(confluenceSyncTargets.repositoryId, repositoryId))
  })
}

export async function listConfluenceSyncTargetsWithRepoByRepositoryId(
  orgId: string,
  repositoryId: string,
): Promise<ConfluenceSyncTargetWithRepo[]> {
  return withOrgDbContext(orgId, async () => {
    return getOrgDb()
      .select({
        id: confluenceSyncTargets.id,
        orgId: confluenceSyncTargets.orgId,
        connectionId: confluenceSyncTargets.connectionId,
        repositoryId: confluenceSyncTargets.repositoryId,
        branch: confluenceSyncTargets.branch,
        enabled: confluenceSyncTargets.enabled,
        setupPhase: confluenceSyncTargets.setupPhase,
        pendingConfigPullUrl: confluenceSyncTargets.pendingConfigPullUrl,
        pendingConfigPrCreating: confluenceSyncTargets.pendingConfigPrCreating,
        createdAt: confluenceSyncTargets.createdAt,
        updatedAt: confluenceSyncTargets.updatedAt,
        repositoryName: repositories.name,
        githubConnectionId: repositories.githubConnectionId,
      })
      .from(confluenceSyncTargets)
      .innerJoin(
        repositories,
        eq(confluenceSyncTargets.repositoryId, repositories.id),
      )
      .where(eq(confluenceSyncTargets.repositoryId, repositoryId))
  })
}

export async function setPendingConfigPrCreating(input: {
  connectionId: string
  pendingConfigPrCreating: boolean
}): Promise<void> {
  const updated = await withOrgDbForConnection(
    input.connectionId,
    async (db) => {
      const [row] = await db
        .update(confluenceSyncTargets)
        .set({
          pendingConfigPrCreating: input.pendingConfigPrCreating,
          updatedAt: new Date(),
        })
        .where(eq(confluenceSyncTargets.connectionId, input.connectionId))
        .returning({ id: confluenceSyncTargets.id })
      return row
    },
  )
  if (!updated) return
}

export async function updateConfluenceSyncTargetPrState(input: {
  connectionId: string
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  setupPhase: string
}): Promise<void> {
  const updated = await withOrgDbForConnection(
    input.connectionId,
    async (db) => {
      const [row] = await db
        .update(confluenceSyncTargets)
        .set({
          pendingConfigPullUrl: input.pendingConfigPullUrl,
          pendingConfigPrCreating: input.pendingConfigPrCreating,
          setupPhase: input.setupPhase,
          updatedAt: new Date(),
        })
        .where(eq(confluenceSyncTargets.connectionId, input.connectionId))
        .returning({ id: confluenceSyncTargets.id })
      return row
    },
  )
  if (!updated) return
}

/** Before enqueueing config PR workflow — shows loading / awaiting-merge in UI */
export async function markAwaitingConfigMergeSetup(input: {
  connectionId: string
}): Promise<void> {
  const updated = await withOrgDbForConnection(
    input.connectionId,
    async (db) => {
      const [row] = await db
        .update(confluenceSyncTargets)
        .set({
          setupPhase: "awaiting_merge",
          pendingConfigPrCreating: true,
          updatedAt: new Date(),
        })
        .where(eq(confluenceSyncTargets.connectionId, input.connectionId))
        .returning({ id: confluenceSyncTargets.id })
      return row
    },
  )
  if (!updated) return
}

/** After config push webhook: first full reconcile from Git before flipping to `live`. */
export async function markConfluenceSyncTargetInitialSync(input: {
  connectionId: string
}): Promise<void> {
  const updated = await withOrgDbForConnection(
    input.connectionId,
    async (db) => {
      const [row] = await db
        .update(confluenceSyncTargets)
        .set({
          setupPhase: "initial_sync",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          enabled: true,
          updatedAt: new Date(),
        })
        .where(eq(confluenceSyncTargets.connectionId, input.connectionId))
        .returning({ id: confluenceSyncTargets.id })
      return row
    },
  )
  if (!updated) return
}

export async function markConfluenceSyncTargetLive(input: {
  connectionId: string
}): Promise<void> {
  const updated = await withOrgDbForConnection(
    input.connectionId,
    async (db) => {
      const [row] = await db
        .update(confluenceSyncTargets)
        .set({
          setupPhase: "live",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          enabled: true,
          updatedAt: new Date(),
        })
        .where(eq(confluenceSyncTargets.connectionId, input.connectionId))
        .returning({ id: confluenceSyncTargets.id })
      return row
    },
  )
  if (!updated) return
}

/**
 * When `confluence-sync-content` finishes: move from `initial_sync` to `live` if the run
 * did not fully fail (allows `partial_failed` so the connector is not stuck).
 */
export async function finalizeConfluenceSyncTargetAfterContentWorkflow(input: {
  connectionId: string
  workflowStatus: "completed" | "partial_failed" | "failed"
}): Promise<void> {
  if (input.workflowStatus === "failed") return
  const updated = await withOrgDbForConnection(
    input.connectionId,
    async (db) => {
      const [row] = await db
        .update(confluenceSyncTargets)
        .set({
          setupPhase: "live",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(confluenceSyncTargets.connectionId, input.connectionId),
            eq(confluenceSyncTargets.setupPhase, "initial_sync"),
          ),
        )
        .returning({ id: confluenceSyncTargets.id })
      return row
    },
  )
  if (!updated) return
}

export async function upsertConfluenceSyncTargetForOrg(input: {
  orgId: string
  connectionId: string
  repositoryId: string
  branch: string
  enabled: boolean
}): Promise<ConfluenceSyncTarget> {
  return withOrgDbContext(input.orgId, async (tx) => {
    const [conn] = await tx
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_FORGE),
        ),
      )
      .limit(1)

    if (!conn) {
      throw new Error("Forge connection does not belong to organization")
    }

    const [row] = await tx
      .insert(confluenceSyncTargets)
      .values({
        id: generateObjectId("cst"),
        orgId: input.orgId,
        connectionId: input.connectionId,
        repositoryId: input.repositoryId,
        branch: input.branch,
        enabled: input.enabled,
        setupPhase: "draft",
        pendingConfigPullUrl: null,
        pendingConfigPrCreating: false,
      })
      .onConflictDoUpdate({
        target: confluenceSyncTargets.connectionId,
        set: {
          repositoryId: input.repositoryId,
          branch: input.branch,
          enabled: input.enabled,
          updatedAt: new Date(),
        },
      })
      .returning()

    if (!row) {
      throw new Error("Failed to upsert Confluence sync target")
    }
    return row
  })
}
