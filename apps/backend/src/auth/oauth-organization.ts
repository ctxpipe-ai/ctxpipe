import { AsyncLocalStorage } from "node:async_hooks"

export const OAUTH_ORGANIZATION_CLAIM =
  "https://ctxpipe.ai/organization_id" as const

export type OAuthOrganizationBinding = {
  requiresSelection: boolean
  referenceId: string | null
}

const oauthConsentOrganizationStorage = new AsyncLocalStorage<string | null>()

export function withOAuthConsentOrganizationId<T>(
  organizationId: string | null,
  handler: () => Promise<T>,
): Promise<T> {
  return oauthConsentOrganizationStorage.run(organizationId, handler)
}

export function getOAuthConsentOrganizationId(): string | null | undefined {
  return oauthConsentOrganizationStorage.getStore()
}

/**
 * OAuth grants are tenant-bound at consent time. Better Auth 1.6.23
 * `/oauth2/continue` with `{ postLogin: true }` only selects that branch —
 * it does not skip `shouldRedirect` unless a server-issued, session-bound
 * marker (`ba_pl`) already exists. That marker is minted only when
 * authorize redirects to consent, so `requiresSelection` must be false
 * once a valid organization can be resolved. Multi-org users override on
 * the consent page; later session org switches cannot retarget the grant.
 */
export function selectOAuthOrganizationBinding(
  membershipIds: string[],
  activeOrganizationId: string | null | undefined,
): OAuthOrganizationBinding {
  if (membershipIds.length === 1) {
    return {
      requiresSelection: false,
      referenceId: membershipIds[0] ?? null,
    }
  }

  if (activeOrganizationId && membershipIds.includes(activeOrganizationId)) {
    return {
      requiresSelection: false,
      referenceId: activeOrganizationId,
    }
  }

  return {
    requiresSelection: true,
    referenceId: null,
  }
}

export function resolveOAuthConsentReferenceId(
  membershipIds: string[],
  activeOrganizationId: string | null | undefined,
  submittedOrganizationId: string | null | undefined,
): string | null {
  if (submittedOrganizationId !== undefined) {
    return submittedOrganizationId &&
      membershipIds.includes(submittedOrganizationId)
      ? submittedOrganizationId
      : null
  }
  return selectOAuthOrganizationBinding(membershipIds, activeOrganizationId)
    .referenceId
}
