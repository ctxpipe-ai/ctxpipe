import { useQuery } from "@tanstack/react-query"
import {
  fetchGithubConnectorBootstrap,
  githubConnectorKeys,
} from "@/features/connectors/queries/github-connector"

export type { GithubConnectorBootstrap } from "@/features/connectors/queries/github-connector"

export { fetchGithubConnectorBootstrap } from "@/features/connectors/queries/github-connector"

export function useGithubConnectorBootstrap(orgSlug: string | null) {
  return useQuery({
    queryKey: githubConnectorKeys.bootstrap(orgSlug ?? ""),
    queryFn: async () => {
      if (!orgSlug) return null
      return fetchGithubConnectorBootstrap(orgSlug)
    },
    enabled: !!orgSlug,
  })
}
