import { createFileRoute } from "@tanstack/react-router"
import { ensureWorkspaceRouteData } from "@/features/workspaces/ensure-route-data"
import { workspaceSearch } from "@/features/workspaces/pane"
import { WorkspaceRouteError } from "@/features/workspaces/WorkspaceRouteError"
import { WorkspaceSurface } from "@/features/workspaces/WorkspaceSurface"

export const Route = createFileRoute(
  "/$orgSlug/ws/$workspaceSlug/$conversationId",
)({
  validateSearch: workspaceSearch,
  shouldReload: ({ cause }) => cause === "enter",
  loader: async ({ context, params, location, cause }) => {
    await ensureWorkspaceRouteData({
      queryClient: context.queryClient,
      orgSlug: params.orgSlug,
      workspaceSlug: params.workspaceSlug,
      conversationId: params.conversationId,
      paneParam: workspaceSearch(location.search as Record<string, unknown>)
        .pane,
      warmLandingPane: cause === "enter" && typeof window !== "undefined",
    })
  },
  errorComponent: ({ error, reset }) => (
    <WorkspaceRouteError error={error} reset={reset} />
  ),
  component: WorkspaceConversationRoute,
})

function WorkspaceConversationRoute() {
  const { orgSlug, workspaceSlug, conversationId } = Route.useParams()
  const { pane } = Route.useSearch()
  return (
    <WorkspaceSurface
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      conversationId={conversationId}
      paneParam={pane}
    />
  )
}
