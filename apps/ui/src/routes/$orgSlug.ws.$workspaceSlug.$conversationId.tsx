import { createFileRoute } from "@tanstack/react-router"
import {
  ensureWorkspaceRouteData,
  prefetchWorkspaceRouteData,
} from "@/features/workspaces/ensure-route-data"
import { workspaceSearch } from "@/features/workspaces/pane"
import { WorkspaceRouteError } from "@/features/workspaces/WorkspaceRouteError"

export const Route = createFileRoute(
  "/$orgSlug/ws/$workspaceSlug/$conversationId",
)({
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
      conversationId: params.conversationId,
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
  component: WorkspaceConversationRoute,
})

function WorkspaceConversationRoute() {
  return null
}
