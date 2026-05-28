import type { Env } from "../../config/env.js"
import {
  BillingHardBlockedError,
  getOrgEntitlement,
  isManagedBillingEnabled,
} from "../../services/payments/client.js"

export async function enforceRepositoryCreationAllowed(input: {
  env: Env
  orgId: string
  requestId: string
  currentRepoCount: number
}): Promise<void> {
  if (!isManagedBillingEnabled(input.env)) return

  const entitlement = await getOrgEntitlement({
    env: input.env,
    orgId: input.orgId,
    requestId: input.requestId,
  })
  if (!entitlement) return
  if (entitlement.enforcement.isHardBlocked) {
    throw new BillingHardBlockedError(entitlement.enforcement.blockingReason)
  }
  const repoLimit = entitlement.limits.repos
  if (repoLimit != null && input.currentRepoCount >= repoLimit) {
    throw new BillingHardBlockedError("repository_limit_reached")
  }
}
