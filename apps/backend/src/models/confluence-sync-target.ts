import { and, eq } from "drizzle-orm"
import { type Db, getOrgDb, withOrgDbContext } from "../db/client.js"
import { confluenceSyncTargets } from "../db/schema/confluenceSyncTargets.js"
import { connections } from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"
import { getConnectionDirectoryByConnectionId } from "./connection-directory.js"
import { reconcileConnectorContentSync } from "./connector-content-sync.js"
import {
  type CapturedConnectorBinding,
  lockConnectorFinalizationBinding,
} from "./connector-finalization.js"

export type ConfluenceSyncTarget = typeof confluenceSyncTargets.$inferSelect

type ConfluenceSyncTargetWithRepo = ConfluenceSyncTarget & {
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

async function getConfluenceSyncTargetByOrgId(
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
  const target = await getConfluenceSyncTargetByOrgId(orgId)
  return target
    ? getConfluenceSyncTargetWithRepoByConnectionId(orgId, target.connectionId)
    : undefined
}

export async function getConfluenceSyncTargetWithRepoByConnectionId(
  orgId: string,
  connectionId: string,
): Promise<
  (ConfluenceSyncTargetWithRepo & { repositoryGitUrl: string }) | undefined
> {
  await reconcileConnectorContentSync({ orgId, connectionId })
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
        repositoryGitUrl: repositories.gitUrl,
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

export async function updateConfluenceSyncTargetPrState(input: {
  expectedBinding?: {
    repositoryId: string
    branch: string
    contentSyncGeneration?: number
  }
  connectionId: string
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  setupPhase: string
}): Promise<boolean> {
  const directory = await getConnectionDirectoryByConnectionId(
    input.connectionId,
  )
  if (!directory)
    throw new Error(`connection_directory missing for ${input.connectionId}`)
  return withOrgDbContext(directory.orgId, async (db) => {
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, input.connectionId))
      .for("update")
    if (
      !connection ||
      (input.expectedBinding?.contentSyncGeneration != null &&
        connection.contentSyncGeneration !==
          input.expectedBinding.contentSyncGeneration)
    )
      return false
    const [row] = await db
      .update(confluenceSyncTargets)
      .set({
        pendingConfigPullUrl: input.pendingConfigPullUrl,
        pendingConfigPrCreating: input.pendingConfigPrCreating,
        setupPhase: input.setupPhase,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(confluenceSyncTargets.connectionId, input.connectionId),
          input.expectedBinding
            ? and(
                eq(
                  confluenceSyncTargets.repositoryId,
                  input.expectedBinding.repositoryId,
                ),
                eq(confluenceSyncTargets.branch, input.expectedBinding.branch),
                eq(confluenceSyncTargets.setupPhase, "awaiting_merge"),
                eq(confluenceSyncTargets.pendingConfigPrCreating, true),
              )
            : undefined,
        ),
      )
      .returning({ id: confluenceSyncTargets.id })
    return Boolean(row)
  })
}

export async function finalizeConfluenceSyncTargetAfterContentWorkflow(input: {
  connectionId: string
  binding: CapturedConnectorBinding
  workflowStatus: "completed" | "partial_failed" | "failed"
}): Promise<void> {
  const updated = await withOrgDbForConnection(
    input.connectionId,
    async (db) => {
      if (
        !(await lockConnectorFinalizationBinding(
          db,
          input.binding,
          input.connectionId,
        ))
      )
        return
      const [row] = await db
        .update(confluenceSyncTargets)
        .set({
          setupPhase:
            input.workflowStatus === "completed" ? "live" : "sync_failed",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(confluenceSyncTargets.connectionId, input.connectionId),
            eq(confluenceSyncTargets.setupPhase, "initial_sync"),
            eq(confluenceSyncTargets.repositoryId, input.binding.repositoryId),
            eq(
              confluenceSyncTargets.branch,
              input.binding.revision.defaultBranch,
            ),
            eq(confluenceSyncTargets.enabled, true),
          ),
        )
        .returning({ id: confluenceSyncTargets.id })
      return row
    },
  )
  if (!updated) return
}

/** Turn off the legacy sync target of a connection (migration `--apply`). */
export async function disableConfluenceSyncTarget(input: {
  orgId: string
  connectionId: string
}): Promise<void> {
  await withOrgDbContext(input.orgId, (db) =>
    db
      .update(confluenceSyncTargets)
      .set({ enabled: false, updatedAt: new Date() })
      .where(
        and(
          eq(confluenceSyncTargets.orgId, input.orgId),
          eq(confluenceSyncTargets.connectionId, input.connectionId),
        ),
      ),
  )
}
