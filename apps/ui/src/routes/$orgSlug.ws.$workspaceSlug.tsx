import { createFileRoute, useMatch } from "@tanstack/react-router"
import {
  ensureWorkspaceRouteData,
  prefetchWorkspaceRouteData,
} from "@/features/workspaces/ensure-route-data"
import { workspaceSearch } from "@/features/workspaces/pane"
import { WorkspaceRouteError } from "@/features/workspaces/WorkspaceRouteError"
import { WorkspaceSurface } from "@/features/workspaces/WorkspaceSurface"

export const Route = createFileRoute("/$orgSlug/ws/$workspaceSlug")({
  validateSearch: workspaceSearch,
  shouldReload: ({ cause }) => cause === "enter",
  loader: async ({ context, params, location, cause }) => {
    const paneParam = workspaceSearch(
      location.search as Record<string, unknown>,
    ).pane
    const input = {
      queryClient: context.queryClient,
      orgSlug: params.orgSlug,
      workspaceSlug: params.workspaceSlug,
      paneParam,
      warmLandingPane: cause === "enter" && typeof window !== "undefined",
    }
    if (typeof document === "undefined") {
      await ensureWorkspaceRouteData(input)
      return
    }
    prefetchWorkspaceRouteData(input)
  },
  errorComponent: ({ error, reset }) => (
    <WorkspaceRouteError error={error} reset={reset} />
  ),
  component: WorkspaceSlugLayout,
})

function WorkspaceSlugLayout() {
  const { orgSlug, workspaceSlug } = Route.useParams()
  const { pane } = Route.useSearch()
  const conversationMatch = useMatch({
    from: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    shouldThrow: false,
  })
  return (
    <WorkspaceSurface
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      conversationId={conversationMatch?.params.conversationId}
      paneParam={pane}
    />
  )
}
