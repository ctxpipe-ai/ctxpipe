import { type QueryClient, queryOptions } from "@tanstack/react-query"

import { ApiError } from "./api-result"
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
    // A server-render retry would wait a second SSR timeout, and the backend
    // UI proxy would answer 504 first. Fail fast to the route error screen;
    // its Try again runs the gate again. The browser keeps the client default
    // (an explicit `retry: undefined` would replace it).
    ...(import.meta.env.SSR ? { retry: false } : {}),
    queryFn: async (): Promise<OrgGate> => {
      const session = await fetchSsrSession().catch((error: unknown) => {
        // In a server render, a rate-limited session check comes from a
        // scanner burst with a fake or expired cookie. Send it to sign-in:
        // the error screen would answer 500 and log an error for each path.
        if (
          import.meta.env.SSR &&
          error instanceof ApiError &&
          error.status === 429
        )
          return null
        throw error
      })
      // With no session, the loader sends the request to sign-in, so the
      // gate does not ask for the organization list.
      if (!session) return { session, organizations: [], orgAccessDenied: true }
      const organizations = await fetchSsrOrganizations()
      return {
        session,
        organizations,
        orgAccessDenied: !organizations.some((org) => org.slug === orgSlug),
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
