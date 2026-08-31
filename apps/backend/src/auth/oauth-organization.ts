export const OAUTH_ORGANIZATION_CLAIM =
  "https://ctxpipe.ai/organization_id" as const

export type OAuthOrganizationBinding = {
  requiresSelection: boolean
  referenceId: string | null
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
