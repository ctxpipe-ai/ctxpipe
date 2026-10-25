import { useQuery } from "@tanstack/react-query"

import { authClient } from "@/lib/auth-client"
import { isAdminRole } from "@/lib/session-user"

/** The role of the signed-in user in the org. One query key for every reader. */
export function useOrgMemberRole(
  orgSlug: string,
  options: { enabled?: boolean; refetchOnMount?: "always" } = {},
) {
  return useQuery({
    queryKey: ["organization-member-role", orgSlug],
    queryFn: () =>
      authClient.organization.getActiveMemberRole({
        query: { organizationSlug: orgSlug },
        fetchOptions: { throw: true },
      }),
    ...options,
  })
}

/**
 * Whether the user is an owner or admin of the org. `null` while the role
 * loads or when it fails: a caller then shows neither the admin control nor
 * the member note, so a member never sees an admin control for a moment.
 */
export function useIsOrgAdmin(orgSlug: string): boolean | null {
  const roleQuery = useOrgMemberRole(orgSlug)
  return roleQuery.isSuccess ? isAdminRole(roleQuery.data?.role) : null
}
