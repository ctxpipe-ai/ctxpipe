import { eq } from "drizzle-orm"
import { getOrgDb } from "../../db/client.js"
import { confluenceSpaces } from "../../db/schema/confluenceSpaces.js"
import { confluenceSyncTargets } from "../../db/schema/confluenceSyncTargets.js"

/**
 * Repo lost valid config — reset wizard to before scope selection while keeping repo selection when possible.
 */
export async function resetConfluenceConnectorAfterMissingConfig(input: {
  connectionId: string
  orgId: string
}): Promise<void> {
  const db = getOrgDb()
  await db.transaction(async (tx) => {
    await tx
      .delete(confluenceSpaces)
      .where(eq(confluenceSpaces.connectionId, input.connectionId))

    await tx
      .update(confluenceSyncTargets)
      .set({
        enabled: false,
        setupPhase: "draft",
        pendingConfigPullUrl: null,
        pendingConfigPrCreating: false,
        updatedAt: new Date(),
      })
      .where(eq(confluenceSyncTargets.connectionId, input.connectionId))
  })
}
