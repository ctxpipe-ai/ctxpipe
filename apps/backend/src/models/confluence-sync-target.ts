import { and, eq } from "drizzle-orm"
import { getSystemDb } from "../db/client.js"
import { confluenceSyncTargets } from "../db/schema/confluenceSyncTargets.js"
import { forgeInstallations } from "../db/schema/forgeInstallations.js"
import { generateObjectId } from "../lib/id.js"

export type ConfluenceSyncTarget = typeof confluenceSyncTargets.$inferSelect

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

export async function getConfluenceSyncTargetByForgeInstallationId(
  forgeInstallationId: string,
): Promise<ConfluenceSyncTarget | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(confluenceSyncTargets)
    .where(eq(confluenceSyncTargets.forgeInstallationId, forgeInstallationId))
    .limit(1)
  return row
}

export async function upsertConfluenceSyncTargetForOrg(input: {
  orgId: string
  forgeInstallationId: string
  repositoryName: string
  branch: string
  enabled: boolean
}): Promise<ConfluenceSyncTarget> {
  const db = getSystemDb()
  return db.transaction(async (tx) => {
    const [forgeInstallation] = await tx
      .select({
        id: forgeInstallations.id,
      })
      .from(forgeInstallations)
      .where(
        and(
          eq(forgeInstallations.id, input.forgeInstallationId),
          eq(forgeInstallations.orgId, input.orgId),
        ),
      )
      .limit(1)

    if (!forgeInstallation) {
      throw new Error("Forge installation does not belong to organization")
    }

    const [row] = await tx
      .insert(confluenceSyncTargets)
      .values({
        id: generateObjectId("cst"),
        orgId: input.orgId,
        forgeInstallationId: input.forgeInstallationId,
        repositoryName: input.repositoryName,
        branch: input.branch,
        enabled: input.enabled,
      })
      .onConflictDoUpdate({
        target: confluenceSyncTargets.orgId,
        set: {
          forgeInstallationId: input.forgeInstallationId,
          repositoryName: input.repositoryName,
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
