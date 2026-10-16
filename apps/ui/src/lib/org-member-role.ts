import { useQuery } from "@tanstack/react-query"
import { authClient } from "@/lib/auth-client"

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
