export const OAUTH_ORGANIZATION_CLAIM =
  "https://ctxpipe.ai/organization_id" as const

export type OAuthOrganizationBinding = {
  requiresSelection: boolean
  referenceId: string | null
}

/**
 * OAuth grants are tenant-bound at consent time. A sole membership is
 * unambiguous; users with multiple memberships must explicitly confirm one on
 * every new authorization, even when their browser session has an active org.
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

  return {
    requiresSelection: true,
    referenceId:
      activeOrganizationId && membershipIds.includes(activeOrganizationId)
        ? activeOrganizationId
        : null,
  }
}
