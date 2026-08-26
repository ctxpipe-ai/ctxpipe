import type { QueryClient } from "@tanstack/react-query"
import { orgConnectionsOptions } from "@/features/connectors/queries/org-connections"
import {
  landingWorkspace,
  workspaceActivityOptions,
  workspaceListOptions,
} from "@/features/workspaces/queries"

export function prefetchOrgHome(queryClient: QueryClient, orgSlug: string) {
  void queryClient.prefetchQuery(workspaceListOptions(orgSlug)).then((list) => {
    const workspace = list ? landingWorkspace(list) : null
    if (!workspace) return
    void queryClient.prefetchQuery(
      workspaceActivityOptions(orgSlug, workspace.slug),
    )
  })
}

export function prefetchOrgConnectors(
  queryClient: QueryClient,
  orgSlug: string,
) {
  void queryClient.prefetchQuery(orgConnectionsOptions(orgSlug))
}
