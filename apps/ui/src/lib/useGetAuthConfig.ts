import { useQuery } from "@tanstack/react-query"
import { apiFetch, readApiJson } from "./api-result"

/** Better Auth `/.auth/api/config` (e.g. social `providers`). Shared query key everywhere we gate UI on config load. */
export function useGetAuthConfig() {
  return useQuery({
    queryKey: ["social-providers"],
    queryFn: async () => {
      const res = await apiFetch("/.auth/api/config")
      return readApiJson(res, { message: "Failed to load auth config" })
    },
    staleTime: Number.POSITIVE_INFINITY,
  })
}

/** Whether GitHub sign-in is on; `undefined` while the config loads. A failed load counts as off. */
export function useGithubSignInEnabled(): boolean | undefined {
  const { data, isPending } = useGetAuthConfig()
  if (isPending) return undefined
  return (
    (data as { providers?: string[] } | undefined)?.providers ?? []
  ).includes("github")
}
