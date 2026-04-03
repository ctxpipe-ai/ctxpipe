import { useQuery } from "@tanstack/react-query"

/** Better Auth `/.auth/api/config` (e.g. social `providers`). Shared query key everywhere we gate UI on config load. */
export function useGetAuthConfig() {
  return useQuery({
    queryKey: ["social-providers"],
    queryFn: () => fetch("/.auth/api/config").then((r) => r.json()),
    staleTime: Number.POSITIVE_INFINITY,
  })
}
