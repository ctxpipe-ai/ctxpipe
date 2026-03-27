import { and, eq } from "drizzle-orm"
import { generateObjectId } from "../lib/id.js"
import { getSystemDb } from "../db/client.js"
import { accounts, members, organizations } from "../db/schema/auth.js"
import {
  atlassianInstances,
  confluenceSpacePageSelections,
  forgeInstallations,
} from "../db/schema/forgeInstallations.js"

export type AtlassianInstance = typeof atlassianInstances.$inferSelect
export type ForgeInstallation = typeof forgeInstallations.$inferSelect
export type ConfluenceSpacePageSelection =
  typeof confluenceSpacePageSelections.$inferSelect

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

export async function upsertAtlassianInstance(input: {
  orgId: string
  cloudId: string
  siteUrl: string
  siteName?: string | null
  linkedByUserId: string
}): Promise<AtlassianInstance> {
  const db = getSystemDb()
  const id = generateObjectId("atl")
  const [row] = await db
    .insert(atlassianInstances)
    .values({
      id,
      orgId: input.orgId,
      cloudId: input.cloudId,
      siteUrl: input.siteUrl,
      siteName: input.siteName ?? null,
      linkedByUserId: input.linkedByUserId,
    })
    .onConflictDoUpdate({
      target: atlassianInstances.orgId,
      set: {
        cloudId: input.cloudId,
        siteUrl: input.siteUrl,
        siteName: input.siteName ?? null,
        linkedByUserId: input.linkedByUserId,
        updatedAt: new Date(),
      },
    })
    .returning()

  if (!row) throw new Error("Failed to upsert Atlassian instance")
  return row
}

export async function getAtlassianInstanceByOrgId(
  orgId: string,
): Promise<AtlassianInstance | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(atlassianInstances)
    .where(eq(atlassianInstances.orgId, orgId))
    .limit(1)
  return row
}

export async function getAtlassianInstanceByCloudId(
  cloudId: string,
): Promise<AtlassianInstance | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(atlassianInstances)
    .where(eq(atlassianInstances.cloudId, cloudId))
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

export async function upsertForgeInstallationFromEvent(input: {
  orgId: string
  cloudId: string
  status: string
  installationContext?: string | null
  installationId?: string | null
  appId?: string | null
  appSystemToken?: string | null
  lastEventPayload?: unknown
}): Promise<ForgeInstallation> {
  const db = getSystemDb()
  const id = generateObjectId("fgi")
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
      lastEventPayload: input.lastEventPayload,
    })
    .onConflictDoUpdate({
      target: forgeInstallations.orgId,
      set: {
        cloudId: input.cloudId,
        status: input.status,
        installationContext: input.installationContext ?? null,
        installationId: input.installationId ?? null,
        appId: input.appId ?? null,
        appSystemToken: input.appSystemToken ?? null,
        lastEventPayload: input.lastEventPayload,
        updatedAt: new Date(),
      },
    })
    .returning()
  if (!row) throw new Error("Failed to upsert forge installation")
  return row
}

export async function listConfluenceSelectionsByOrgId(
  orgId: string,
): Promise<ConfluenceSpacePageSelection[]> {
  const db = getSystemDb()
  return db
    .select()
    .from(confluenceSpacePageSelections)
    .where(eq(confluenceSpacePageSelections.orgId, orgId))
}

export async function replaceConfluenceSelections(input: {
  orgId: string
  cloudId: string
  items: Array<{
    spaceId: string
    spaceKey?: string | null
    spaceName?: string | null
    pageId: string
    pageTitle?: string | null
    isSelected?: boolean
  }>
}): Promise<ConfluenceSpacePageSelection[]> {
  const db = getSystemDb()
  return db.transaction(async (tx) => {
    await tx
      .delete(confluenceSpacePageSelections)
      .where(eq(confluenceSpacePageSelections.orgId, input.orgId))

    if (input.items.length === 0) {
      return []
    }

    const rows = await tx
      .insert(confluenceSpacePageSelections)
      .values(
        input.items.map((item) => ({
          id: generateObjectId("csp"),
          orgId: input.orgId,
          cloudId: input.cloudId,
          spaceId: item.spaceId,
          spaceKey: item.spaceKey ?? null,
          spaceName: item.spaceName ?? null,
          pageId: item.pageId,
          pageTitle: item.pageTitle ?? null,
          isSelected: item.isSelected ?? true,
        })),
      )
      .returning()

    return rows
  })
}

export async function getOrganizationSlugForCloudIdByUser(
  userId: string,
  cloudId: string,
): Promise<string | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({ orgSlug: organizations.slug })
    .from(atlassianInstances)
    .innerJoin(
      members,
      and(
        eq(members.organizationId, atlassianInstances.orgId),
        eq(members.userId, userId),
      ),
    )
    .innerJoin(organizations, eq(organizations.id, atlassianInstances.orgId))
    .where(eq(atlassianInstances.cloudId, cloudId))
    .limit(1)
  return row?.orgSlug
}
