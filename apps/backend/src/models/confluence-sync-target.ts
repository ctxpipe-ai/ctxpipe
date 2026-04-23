import { and, eq } from "drizzle-orm"
import { getSystemDb } from "../db/client.js"
import {
  CONNECTION_TYPE_FORGE,
  connections,
} from "../db/schema/connections.js"
import { confluenceSyncTargets } from "../db/schema/confluenceSyncTargets.js"
import { repositories } from "../db/schema/repositories.js"
import { generateObjectId } from "../lib/id.js"

export type ConfluenceSyncTarget = typeof confluenceSyncTargets.$inferSelect

export type ConfluenceSyncTargetWithRepo = ConfluenceSyncTarget & {
  repositoryName: string
}

export async function getConfluenceSyncTargetByOrgId(
  orgId: string,
): Promise<ConfluenceSyncTarget | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(confluenceSyncTargets)
    .where(eq(confluenceSyncTargets.orgId, orgId))
    .limit(1)
  return row
}

export async function getConfluenceSyncTargetWithRepoByOrgId(
  orgId: string,
): Promise<ConfluenceSyncTargetWithRepo | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({
      id: confluenceSyncTargets.id,
      orgId: confluenceSyncTargets.orgId,
      connectionId: confluenceSyncTargets.connectionId,
      repositoryId: confluenceSyncTargets.repositoryId,
      branch: confluenceSyncTargets.branch,
      enabled: confluenceSyncTargets.enabled,
      createdAt: confluenceSyncTargets.createdAt,
      updatedAt: confluenceSyncTargets.updatedAt,
      repositoryName: repositories.name,
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
}

export async function getConfluenceSyncTargetWithRepoByConnectionId(
  orgId: string,
  connectionId: string,
): Promise<ConfluenceSyncTargetWithRepo | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({
      id: confluenceSyncTargets.id,
      orgId: confluenceSyncTargets.orgId,
      connectionId: confluenceSyncTargets.connectionId,
      repositoryId: confluenceSyncTargets.repositoryId,
      branch: confluenceSyncTargets.branch,
      enabled: confluenceSyncTargets.enabled,
      createdAt: confluenceSyncTargets.createdAt,
      updatedAt: confluenceSyncTargets.updatedAt,
      repositoryName: repositories.name,
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
}

export async function getConfluenceSyncTargetByConnectionId(
  connectionId: string,
): Promise<ConfluenceSyncTarget | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(confluenceSyncTargets)
    .where(eq(confluenceSyncTargets.connectionId, connectionId))
    .limit(1)
  return row
}

export async function upsertConfluenceSyncTargetForOrg(input: {
  orgId: string
  connectionId: string
  repositoryId: string
  branch: string
  enabled: boolean
}): Promise<ConfluenceSyncTarget> {
  const db = getSystemDb()
  return db.transaction(async (tx) => {
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
