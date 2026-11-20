import { queryOptions, useQuery } from "@tanstack/react-query"

import { apiFetch, readApiJson } from "./api-result"

/**
 * Better Auth `/.auth/api/config`: the social `providers`, and the GitHub
 * authorize page of the deployment. Shared query key everywhere we gate UI
 * on config load.
 */
export const authConfigQuery = queryOptions({
  queryKey: ["social-providers"],
  queryFn: async () => {
    const res = await apiFetch("/.auth/api/config")
    // TODO: the Better Auth config route is outside the Hono client, so the body is not checked.
    return (await readApiJson(res, {
      message: "Failed to load auth config",
    })) as { providers?: string[]; githubAuthorizeUrl?: string }
  },
  staleTime: Number.POSITIVE_INFINITY,
})

export function useGetAuthConfig() {
  return useQuery(authConfigQuery)
}
