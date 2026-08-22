import type { QueryClient } from "@tanstack/react-query"
import { githubInstallationOptions } from "@/features/connectors/queries/github-connector"
import { orgConnectionsOptions } from "@/features/connectors/queries/org-connections"
import { repositoriesListOptions } from "@/features/repositories"

export function prefetchOrgHome(queryClient: QueryClient, orgSlug: string) {
  void queryClient.prefetchQuery(githubInstallationOptions(orgSlug))
  void queryClient.prefetchQuery(repositoriesListOptions(orgSlug))
}

export function prefetchOrgConnectors(
  queryClient: QueryClient,
  orgSlug: string,
) {
  void queryClient.prefetchQuery(orgConnectionsOptions(orgSlug))
}
