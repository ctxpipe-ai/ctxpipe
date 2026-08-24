import { eq } from "drizzle-orm"
import { getOrgDb } from "../../db/client.js"
import { confluenceSpaces } from "../../db/schema/confluenceSpaces.js"
import { confluenceSyncTargets } from "../../db/schema/confluenceSyncTargets.js"
import { withAmbientOrgDb } from "../../db/org-sql.js"

/**
 * Repo lost valid config — reset wizard to before scope selection while keeping repo selection when possible.
 * Clears draft `confluence_spaces` rows and sets `enabled: false` on the sync target (does not delete the target row).
 */

function orgSql<T>(fn: () => Promise<T>): Promise<T> {
  return withAmbientOrgDb(fn)
}

export async function resetConfluenceConnectorAfterMissingConfig(input: {
  connectionId: string
  orgId: string
}): Promise<void> {
  return orgSql(async () => {
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
  })
}
