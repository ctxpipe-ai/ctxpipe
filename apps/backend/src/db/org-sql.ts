import { orgIdStorage } from "../auth/withAuth.js"
import { tryGetOrgDb, withOrgDbContext } from "./client.js"

/**
 * Run SQL in a short org transaction, reusing one if already open.
 * Used by model exports after request middleware stops wrapping `next()` in BEGIN.
 */
export async function withAmbientOrgDb<T>(fn: () => Promise<T>): Promise<T> {
  if (tryGetOrgDb()) return fn()
  const orgId = orgIdStorage.getStore()?.id
  if (!orgId) {
    throw new Error(
      "Org database not initialized. Call withOrgDbContext() during startup.",
    )
  }
  return withOrgDbContext(orgId, fn)
}
