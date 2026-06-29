import type { QueryClient } from "@tanstack/react-query"

export const organizationListQueryKey = ["organizations"] as const

export async function invalidateOrganizationList(
  queryClient: QueryClient,
): Promise<void> {
  await queryClient.invalidateQueries({
    queryKey: organizationListQueryKey,
    refetchType: "active",
  })
}
