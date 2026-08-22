import { type QueryClient, queryOptions } from "@tanstack/react-query"
import {
  fetchSsrOrganizations,
  fetchSsrSession,
  type SsrOrganization,
  type SsrSession,
} from "./auth-ssr"

export type OrgGate = {
  session: SsrSession
  organizations: SsrOrganization[]
  orgAccessDenied: boolean
}

export const orgGateKeys = {
  all: ["org-gate"] as const,
  org: (orgSlug: string) => ["org-gate", orgSlug] as const,
}

export function orgGateOptions(orgSlug: string) {
  return queryOptions({
    queryKey: orgGateKeys.org(orgSlug),
    queryFn: async (): Promise<OrgGate> => {
      const [session, organizations] = await Promise.all([
        fetchSsrSession(),
        fetchSsrOrganizations(),
      ])
      return {
        session,
        organizations,
        orgAccessDenied:
          !session || !organizations.some((org) => org.slug === orgSlug),
      }
    },
  })
}

/** Fresh cached gate for this org. Invalidated entries are treated as a miss. */
export function peekOrgGate(
  queryClient: QueryClient,
  orgSlug: string,
): OrgGate | undefined {
  const state = queryClient.getQueryState(orgGateOptions(orgSlug).queryKey)
  if (!state?.data || state.isInvalidated) return undefined
  return state.data
}
