import { useQuery } from "@tanstack/react-query"
import { client } from "@/lib/api"

export type GithubConnectorBootstrap = {
  publicApiOrigin: string
  suggestedWebhookUrlTemplate: string
  githubAppConfiguredInEnv: boolean
  rowsNeedingSecrets: number
  hostedDefaultAppInstallUrl: string | null
}

export function useGithubConnectorBootstrap(orgSlug: string | null) {
  return useQuery({
    queryKey: ["github-connector-bootstrap", orgSlug],
    queryFn: async () => {
      if (!orgSlug) return null
      const res = await (
        client[":orgSlug"].api.v1.github.installation[
          "connector-bootstrap"
        ].$get as (arg: { param: { orgSlug: string } }) => Promise<Response>
      )({ param: { orgSlug } })
      if (!res.ok) throw new Error("Failed to load GitHub connector bootstrap")
      return (await res.json()) as GithubConnectorBootstrap
    },
    enabled: !!orgSlug,
  })
}
