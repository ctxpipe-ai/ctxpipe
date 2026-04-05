import { and, desc, eq, ne } from "drizzle-orm"
import { getSystemDb } from "../db/client.js"
import { accounts, members, organizations } from "../db/schema/auth.js"
import { confluenceSpaces } from "../db/schema/confluenceSpaces.js"
import { confluenceSyncTargets } from "../db/schema/confluenceSyncTargets.js"
import { forgeInstallations } from "../db/schema/forgeInstallations.js"
import { generateObjectId } from "../lib/id.js"

export type ForgeInstallation = typeof forgeInstallations.$inferSelect
export type ConfluenceSpaceSelection = typeof confluenceSpaces.$inferSelect

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
): Promise<ForgeInstallation | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(forgeInstallations)
    .where(eq(forgeInstallations.cloudId, cloudId))
    .limit(1)
  return row
}

export async function getForgeInstallationByOrgId(
  orgId: string,
): Promise<ForgeInstallation | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(forgeInstallations)
    .where(eq(forgeInstallations.orgId, orgId))
    .limit(1)
  return row
}

export async function updateForgeAppSystemTokenByInstallationId(input: {
  installationId: string
  appSystemToken: string
  atlassianApiBaseUrl?: string
}): Promise<boolean> {
  const db = getSystemDb()
  const set: Record<string, unknown> = {
    appSystemToken: input.appSystemToken,
    updatedAt: new Date(),
  }
  if (input.atlassianApiBaseUrl !== undefined) {
    set.atlassianApiBaseUrl = input.atlassianApiBaseUrl
  }
  const updated = await db
    .update(forgeInstallations)
    .set(set)
    .where(
      and(
        eq(forgeInstallations.installationId, input.installationId),
        eq(forgeInstallations.status, "installed"),
      ),
    )
    .returning({ id: forgeInstallations.id })
  return updated.length > 0
}

export async function getPendingForgeInstallationForUserInOtherOrg(input: {
  userId: string
  orgId: string
}): Promise<ForgeInstallation | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({ installation: forgeInstallations })
    .from(forgeInstallations)
    .innerJoin(
      members,
      and(
        eq(members.organizationId, forgeInstallations.orgId),
        eq(members.userId, input.userId),
      ),
    )
    .where(
      and(
        eq(forgeInstallations.status, "pending"),
        eq(forgeInstallations.installedByUserId, input.userId),
        ne(forgeInstallations.orgId, input.orgId),
      ),
    )
    .orderBy(desc(forgeInstallations.updatedAt))
    .limit(1)
  return row?.installation
}

export async function upsertPendingForgeInstallation(input: {
  orgId: string
  installedByUserId: string
}): Promise<ForgeInstallation> {
  const db = getSystemDb()
  const id = generateObjectId("fgi")
  const [row] = await db
    .insert(forgeInstallations)
    .values({
      id,
      orgId: input.orgId,
      cloudId: null,
      status: "pending",
      installationContext: null,
      installationId: null,
      appId: null,
      appSystemToken: null,
      atlassianApiBaseUrl: null,
      installedByUserId: input.installedByUserId,
      lastEventPayload: null,
    })
    .onConflictDoUpdate({
      target: forgeInstallations.orgId,
      set: {
        status: "pending",
        cloudId: null,
        installationContext: null,
        installationId: null,
        appId: null,
        appSystemToken: null,
        atlassianApiBaseUrl: null,
        installedByUserId: input.installedByUserId,
        lastEventPayload: null,
        updatedAt: new Date(),
      },
    })
    .returning()
  if (!row) throw new Error("Failed to upsert pending forge installation")
  return row
}

export async function getPendingForgeInstallationByInstallerAccountId(
  installerAccountId: string,
): Promise<ForgeInstallation | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({ installation: forgeInstallations })
    .from(accounts)
    .innerJoin(
      forgeInstallations,
      and(
        eq(forgeInstallations.installedByUserId, accounts.userId),
        eq(forgeInstallations.status, "pending"),
      ),
    )
    .innerJoin(
      members,
      and(
        eq(members.organizationId, forgeInstallations.orgId),
        eq(members.userId, accounts.userId),
      ),
    )
    .where(
      and(
        eq(accounts.providerId, "atlassian"),
        eq(accounts.accountId, installerAccountId),
      ),
    )
    .orderBy(desc(forgeInstallations.updatedAt))
    .limit(1)
  return row?.installation
}

export async function upsertForgeInstallationFromEvent(input: {
  orgId: string
  cloudId: string
  status: string
  installationContext?: string | null
  installationId?: string | null
  appId?: string | null
  appSystemToken?: string | null
  /** From FIT `app.apiBaseUrl` when valid; omit to leave existing DB value unchanged. */
  atlassianApiBaseUrl?: string
  installedByUserId?: string | null
  lastEventPayload?: unknown
}): Promise<ForgeInstallation> {
  const db = getSystemDb()
  const id = generateObjectId("fgi")
  const updateSet: Record<string, unknown> = {
    cloudId: input.cloudId,
    status: input.status,
    installationContext: input.installationContext ?? null,
    installationId: input.installationId ?? null,
    appId: input.appId ?? null,
    appSystemToken: input.appSystemToken ?? null,
    lastEventPayload: input.lastEventPayload,
    updatedAt: new Date(),
  }
  if (input.installedByUserId !== undefined) {
    updateSet.installedByUserId = input.installedByUserId
  }
  if (input.atlassianApiBaseUrl !== undefined) {
    updateSet.atlassianApiBaseUrl = input.atlassianApiBaseUrl
  }

  const [row] = await db
    .insert(forgeInstallations)
    .values({
      id,
      orgId: input.orgId,
      cloudId: input.cloudId,
      status: input.status,
      installationContext: input.installationContext ?? null,
      installationId: input.installationId ?? null,
      appId: input.appId ?? null,
      appSystemToken: input.appSystemToken ?? null,
      atlassianApiBaseUrl: input.atlassianApiBaseUrl ?? null,
      installedByUserId: input.installedByUserId ?? null,
      lastEventPayload: input.lastEventPayload,
    })
    .onConflictDoUpdate({
      target: forgeInstallations.orgId,
      set: updateSet,
    })
    .returning()
  if (!row) throw new Error("Failed to upsert forge installation")
  return row
}

export async function getOrganizationSlugForCloudIdByUser(
  userId: string,
  cloudId: string,
): Promise<string | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({ orgSlug: organizations.slug })
    .from(forgeInstallations)
    .innerJoin(
      members,
      and(
        eq(members.organizationId, forgeInstallations.orgId),
        eq(members.userId, userId),
      ),
    )
    .innerJoin(organizations, eq(organizations.id, forgeInstallations.orgId))
    .where(eq(forgeInstallations.cloudId, cloudId))
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
    .where(eq(confluenceSpaces.forgeInstallationId, forgeInstallationId))
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
      .where(eq(confluenceSpaces.forgeInstallationId, input.forgeInstallationId))

    if (input.spaces.length === 0) {
      return []
    }

    return tx
      .insert(confluenceSpaces)
      .values(
        input.spaces.map((space) => ({
          id: generateObjectId("csp"),
          forgeInstallationId: input.forgeInstallationId,
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
        eq(confluenceSpaces.forgeInstallationId, input.forgeInstallationId),
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
    repositoryName: string
    branch: string
    enabled: boolean
  }
}): Promise<{ spaces: ConfluenceSpaceSelection[] }> {
  const db = getSystemDb()
  return db.transaction(async (tx) => {
    if (input.spaces !== undefined) {
      await tx
        .delete(confluenceSpaces)
        .where(eq(confluenceSpaces.forgeInstallationId, input.forgeInstallationId))

      if (input.spaces.length > 0) {
        await tx.insert(confluenceSpaces).values(
          input.spaces.map((space) => ({
            id: generateObjectId("csp"),
            forgeInstallationId: input.forgeInstallationId,
            spaceKey: space.spaceKey,
            spaceName: space.spaceName ?? null,
            selectedPageIds: space.selectedPageIds ?? null,
          })),
        )
      }
    }

    if (input.syncTarget !== undefined) {
      const [row] = await tx
        .insert(confluenceSyncTargets)
        .values({
          id: generateObjectId("cst"),
          orgId: input.orgId,
          forgeInstallationId: input.forgeInstallationId,
          repositoryName: input.syncTarget.repositoryName,
          branch: input.syncTarget.branch,
          enabled: input.syncTarget.enabled,
        })
        .onConflictDoUpdate({
          target: confluenceSyncTargets.orgId,
          set: {
            forgeInstallationId: input.forgeInstallationId,
            repositoryName: input.syncTarget.repositoryName,
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
      .where(eq(confluenceSpaces.forgeInstallationId, input.forgeInstallationId))

    return { spaces }
  })
}
