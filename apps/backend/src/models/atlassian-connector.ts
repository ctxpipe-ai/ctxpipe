import { and, desc, eq, ne, sql } from "drizzle-orm"
import { getSystemDb } from "../db/client.js"
import { accounts, members, organizations } from "../db/schema/auth.js"
import {
  CONNECTION_TYPE_FORGE,
  connections,
} from "../db/schema/connections.js"
import { confluenceSpaces } from "../db/schema/confluenceSpaces.js"
import { confluenceSyncTargets } from "../db/schema/confluenceSyncTargets.js"
import { repositories } from "../db/schema/repositories.js"
import { generateObjectId } from "../lib/id.js"
import {
  forgeConnectionToShape,
  forgeShapeToConfig,
  type ForgeInstallationShape,
} from "./connection-rows.js"

/** @deprecated Use `ForgeInstallationShape` — kept as alias for existing imports. */
export type ForgeInstallation = ForgeInstallationShape
export type ConfluenceSpaceSelection = typeof confluenceSpaces.$inferSelect

function forgeConfigCloudIdRef() {
  return sql<string>`${connections.config}->>'cloudId'`
}

function forgeConfigStatusRef() {
  return sql<string>`${connections.config}->>'status'`
}

function forgeConfigInstalledByUserIdRef() {
  return sql<string>`${connections.config}->>'installedByUserId'`
}

function forgeConfigInstallationIdRef() {
  return sql<string>`${connections.config}->>'installationId'`
}

export async function getAtlassianUserAccessToken(
  userId: string,
): Promise<string | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({ accessToken: accounts.accessToken })
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), eq(accounts.providerId, "atlassian")),
    )
    .limit(1)
  return row?.accessToken ?? undefined
}

export async function getForgeInstallationByCloudId(
  cloudId: string,
): Promise<ForgeInstallationShape | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.type, CONNECTION_TYPE_FORGE),
        eq(forgeConfigCloudIdRef(), cloudId),
      ),
    )
    .limit(1)
  return row ? forgeConnectionToShape(row) : undefined
}

/** First forge connection for org (ambiguous when multiple). */
export async function getForgeInstallationByOrgId(
  orgId: string,
): Promise<ForgeInstallationShape | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(eq(connections.orgId, orgId), eq(connections.type, CONNECTION_TYPE_FORGE)),
    )
    .orderBy(desc(connections.updatedAt))
    .limit(1)
  return row ? forgeConnectionToShape(row) : undefined
}

export async function getForgeInstallationByConnectionId(
  orgId: string,
  connectionId: string,
): Promise<ForgeInstallationShape | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.orgId, orgId),
        eq(connections.type, CONNECTION_TYPE_FORGE),
      ),
    )
    .limit(1)
  return row ? forgeConnectionToShape(row) : undefined
}

/** Explicit forge `connectionId` or latest forge row for the org. */
export async function resolveForgeInstallationForOrg(
  orgId: string,
  connectionId?: string | null,
): Promise<ForgeInstallationShape | undefined> {
  if (connectionId) {
    return getForgeInstallationByConnectionId(orgId, connectionId)
  }
  return getForgeInstallationByOrgId(orgId)
}

export async function deleteForgeConnectionById(
  orgId: string,
  connectionId: string,
): Promise<boolean> {
  const db = getSystemDb()
  const removed = await db
    .delete(connections)
    .where(
      and(
        eq(connections.orgId, orgId),
        eq(connections.id, connectionId),
        eq(connections.type, CONNECTION_TYPE_FORGE),
      ),
    )
    .returning({ id: connections.id })
  return removed.length > 0
}

/** Removes all forge connections for the org (cascades spaces and sync targets). */
export async function deleteForgeInstallationByOrgId(
  orgId: string,
): Promise<boolean> {
  const db = getSystemDb()
  const removed = await db
    .delete(connections)
    .where(
      and(eq(connections.orgId, orgId), eq(connections.type, CONNECTION_TYPE_FORGE)),
    )
    .returning({ id: connections.id })
  return removed.length > 0
}

export async function updateForgeAppSystemTokenByInstallationId(input: {
  installationId: string
  appSystemToken: string
  atlassianApiBaseUrl?: string
}): Promise<boolean> {
  const db = getSystemDb()
  const candidates = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.type, CONNECTION_TYPE_FORGE),
        eq(forgeConfigInstallationIdRef(), input.installationId),
        eq(forgeConfigStatusRef(), "installed"),
      ),
    )
    .limit(1)
  const row = candidates[0]
  if (!row) return false
  const shape = forgeConnectionToShape(row)
  const nextConfig = forgeShapeToConfig({
    ...shape,
    appSystemToken: input.appSystemToken,
    atlassianApiBaseUrl:
      input.atlassianApiBaseUrl ?? shape.atlassianApiBaseUrl,
  })
  const updated = await db
    .update(connections)
    .set({ config: nextConfig, updatedAt: new Date() })
    .where(eq(connections.id, row.id))
    .returning({ id: connections.id })
  return updated.length > 0
}

export async function getPendingForgeInstallationForUserInOtherOrg(input: {
  userId: string
  orgId: string
}): Promise<ForgeInstallationShape | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({ installation: connections })
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
        eq(connections.type, CONNECTION_TYPE_FORGE),
        eq(forgeConfigStatusRef(), "pending"),
        eq(forgeConfigInstalledByUserIdRef(), input.userId),
        ne(connections.orgId, input.orgId),
      ),
    )
    .orderBy(desc(connections.updatedAt))
    .limit(1)
  return row?.installation
    ? forgeConnectionToShape(row.installation)
    : undefined
}

export async function upsertPendingForgeInstallation(input: {
  orgId: string
  installedByUserId: string
}): Promise<ForgeInstallationShape> {
  const db = getSystemDb()
  const [existing] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.orgId, input.orgId),
        eq(connections.type, CONNECTION_TYPE_FORGE),
        eq(forgeConfigStatusRef(), "pending"),
        eq(forgeConfigInstalledByUserIdRef(), input.installedByUserId),
      ),
    )
    .orderBy(desc(connections.updatedAt))
    .limit(1)

  const pendingConfig = forgeShapeToConfig({
    cloudId: null,
    installationContext: null,
    installationId: null,
    appId: null,
    appSystemToken: null,
    atlassianApiBaseUrl: null,
    installedByUserId: input.installedByUserId,
    status: "pending",
    lastEventPayload: null,
  })

  if (existing) {
    const [row] = await db
      .update(connections)
      .set({ config: pendingConfig, updatedAt: new Date() })
      .where(eq(connections.id, existing.id))
      .returning()
    if (!row) throw new Error("Failed to upsert pending forge installation")
    return forgeConnectionToShape(row)
  }

  const id = generateObjectId("con")
  const [row] = await db
    .insert(connections)
    .values({
      id,
      orgId: input.orgId,
      type: CONNECTION_TYPE_FORGE,
      config: pendingConfig,
    })
    .returning()
  if (!row) throw new Error("Failed to upsert pending forge installation")
  return forgeConnectionToShape(row)
}

export async function getPendingForgeInstallationByInstallerAccountId(
  installerAccountId: string,
): Promise<ForgeInstallationShape | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({ installation: connections })
    .from(accounts)
    .innerJoin(
      connections,
      and(
        eq(connections.type, CONNECTION_TYPE_FORGE),
        eq(forgeConfigStatusRef(), "pending"),
        sql`${connections.config}->>'installedByUserId' = ${accounts.userId}`,
      ),
    )
    .innerJoin(
      members,
      and(
        eq(members.organizationId, connections.orgId),
        eq(members.userId, accounts.userId),
      ),
    )
    .where(
      and(
        eq(accounts.providerId, "atlassian"),
        eq(accounts.accountId, installerAccountId),
      ),
    )
    .orderBy(desc(connections.updatedAt))
    .limit(1)
  return row?.installation
    ? forgeConnectionToShape(row.installation)
    : undefined
}

export async function upsertForgeInstallationFromEvent(input: {
  orgId: string
  cloudId: string
  status: string
  installationContext?: string | null
  installationId?: string | null
  appId?: string | null
  appSystemToken?: string | null
  atlassianApiBaseUrl?: string
  installedByUserId?: string | null
  lastEventPayload?: unknown
}): Promise<ForgeInstallationShape> {
  const db = getSystemDb()
  const [existing] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.orgId, input.orgId),
        eq(connections.type, CONNECTION_TYPE_FORGE),
        eq(forgeConfigCloudIdRef(), input.cloudId),
      ),
    )
    .limit(1)

  const mergedConfig = forgeShapeToConfig({
    cloudId: input.cloudId,
    installationContext: input.installationContext ?? null,
    installationId: input.installationId ?? null,
    appId: input.appId ?? null,
    appSystemToken: input.appSystemToken ?? null,
    atlassianApiBaseUrl: input.atlassianApiBaseUrl ?? null,
    installedByUserId: input.installedByUserId ?? null,
    status: input.status,
    lastEventPayload: input.lastEventPayload ?? null,
  })

  if (existing) {
    const [row] = await db
      .update(connections)
      .set({ config: mergedConfig, updatedAt: new Date() })
      .where(eq(connections.id, existing.id))
      .returning()
    if (!row) throw new Error("Failed to upsert forge installation")
    return forgeConnectionToShape(row)
  }

  const id = generateObjectId("con")
  const [row] = await db
    .insert(connections)
    .values({
      id,
      orgId: input.orgId,
      type: CONNECTION_TYPE_FORGE,
      config: mergedConfig,
    })
    .returning()
  if (!row) throw new Error("Failed to upsert forge installation")
  return forgeConnectionToShape(row)
}

export async function getOrganizationSlugForCloudIdByUser(
  userId: string,
  cloudId: string,
): Promise<string | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({ orgSlug: organizations.slug })
    .from(connections)
    .innerJoin(
      members,
      and(
        eq(members.organizationId, connections.orgId),
        eq(members.userId, userId),
      ),
    )
    .innerJoin(organizations, eq(organizations.id, connections.orgId))
    .where(
      and(
        eq(connections.type, CONNECTION_TYPE_FORGE),
        eq(forgeConfigCloudIdRef(), cloudId),
      ),
    )
    .limit(1)
  return row?.orgSlug
}

export async function listConfluenceSpacesByForgeInstallationId(
  forgeInstallationId: string,
): Promise<ConfluenceSpaceSelection[]> {
  const db = getSystemDb()
  return db
    .select()
    .from(confluenceSpaces)
    .where(eq(confluenceSpaces.connectionId, forgeInstallationId))
}

export async function replaceConfluenceSpacesForForgeInstallation(input: {
  forgeInstallationId: string
  spaces: Array<{
    spaceKey: string
    spaceName?: string
    selectedPageIds?: string[] | null
  }>
}): Promise<ConfluenceSpaceSelection[]> {
  const db = getSystemDb()
  return db.transaction(async (tx) => {
    await tx
      .delete(confluenceSpaces)
      .where(eq(confluenceSpaces.connectionId, input.forgeInstallationId))

    if (input.spaces.length === 0) {
      return []
    }

    return tx
      .insert(confluenceSpaces)
      .values(
        input.spaces.map((space) => ({
          id: generateObjectId("csp"),
          connectionId: input.forgeInstallationId,
          spaceKey: space.spaceKey,
          spaceName: space.spaceName ?? null,
          selectedPageIds: space.selectedPageIds ?? null,
        })),
      )
      .returning()
  })
}

export async function updateConfluenceSpaceSyncState(input: {
  forgeInstallationId: string
  spaceKey: string
  lastSyncedAt: Date
  lastSyncedPageId?: string | null
}): Promise<void> {
  const db = getSystemDb()
  await db
    .update(confluenceSpaces)
    .set({
      lastSyncedAt: input.lastSyncedAt,
      lastSyncedPageId: input.lastSyncedPageId ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(confluenceSpaces.connectionId, input.forgeInstallationId),
        eq(confluenceSpaces.spaceKey, input.spaceKey),
      ),
    )
}

/** PATCH semantics: omit `spaces` or `syncTarget` to leave that part unchanged. */
export async function patchAtlassianConnectorConfig(input: {
  orgId: string
  forgeInstallationId: string
  spaces?: Array<{
    spaceKey: string
    spaceName?: string
    selectedPageIds?: string[] | null
  }>
  syncTarget?: {
    repositoryId: string
    branch: string
    enabled: boolean
  }
}): Promise<{ spaces: ConfluenceSpaceSelection[] }> {
  const db = getSystemDb()
  return db.transaction(async (tx) => {
    if (input.spaces !== undefined) {
      await tx
        .delete(confluenceSpaces)
        .where(
          eq(confluenceSpaces.connectionId, input.forgeInstallationId),
        )

      if (input.spaces.length > 0) {
        await tx.insert(confluenceSpaces).values(
          input.spaces.map((space) => ({
            id: generateObjectId("csp"),
            connectionId: input.forgeInstallationId,
            spaceKey: space.spaceKey,
            spaceName: space.spaceName ?? null,
            selectedPageIds: space.selectedPageIds ?? null,
          })),
        )
      }
    }

    if (input.syncTarget !== undefined) {
      const [repo] = await tx
        .select({ id: repositories.id })
        .from(repositories)
        .where(
          and(
            eq(repositories.id, input.syncTarget.repositoryId),
            eq(repositories.orgId, input.orgId),
          ),
        )
        .limit(1)
      if (!repo) {
        throw new Error("Repository not found for organization")
      }

      const [row] = await tx
        .insert(confluenceSyncTargets)
        .values({
          id: generateObjectId("cst"),
          orgId: input.orgId,
          connectionId: input.forgeInstallationId,
          repositoryId: input.syncTarget.repositoryId,
          branch: input.syncTarget.branch,
          enabled: input.syncTarget.enabled,
        })
        .onConflictDoUpdate({
          target: confluenceSyncTargets.connectionId,
          set: {
            repositoryId: input.syncTarget.repositoryId,
            branch: input.syncTarget.branch,
            enabled: input.syncTarget.enabled,
            updatedAt: new Date(),
          },
        })
        .returning()

      if (!row) {
        throw new Error("Failed to save Confluence sync target")
      }
    }

    const spaces = await tx
      .select()
      .from(confluenceSpaces)
      .where(
        eq(confluenceSpaces.connectionId, input.forgeInstallationId),
      )

    return { spaces }
  })
}
