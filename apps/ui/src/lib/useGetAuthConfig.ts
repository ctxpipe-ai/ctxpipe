import { useQuery } from "@tanstack/react-query"
import { apiFetch, readApiJson } from "./api-result"

/** Better Auth `/.auth/api/config` (e.g. social `providers`). Shared query key everywhere we gate UI on config load. */
export function useGetAuthConfig() {
  return useQuery({
    queryKey: ["social-providers"],
    queryFn: async () => {
      const res = await apiFetch("/.auth/api/config")
      // TODO: the Better Auth config route is outside the Hono client, so the body is unknown.
      return (await readApiJson(res, {
        message: "Failed to load auth config",
        // biome-ignore lint/complexity/noBannedTypes: the body shape is not known here
      })) as {}
    },
    staleTime: Number.POSITIVE_INFINITY,
  })
}
