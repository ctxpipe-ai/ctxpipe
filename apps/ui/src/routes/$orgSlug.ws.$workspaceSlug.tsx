import { createFileRoute, Outlet } from "@tanstack/react-router"
import { ensureWorkspaceRouteData } from "@/features/workspaces/ensure-route-data"
import { workspaceSearch } from "@/features/workspaces/pane"
import { WorkspaceRouteError } from "@/features/workspaces/WorkspaceRouteError"

export const Route = createFileRoute("/$orgSlug/ws/$workspaceSlug")({
  validateSearch: workspaceSearch,
  shouldReload: ({ cause }) => cause === "enter",
  loader: async ({ context, params, location, cause }) => {
    await ensureWorkspaceRouteData({
      queryClient: context.queryClient,
      orgSlug: params.orgSlug,
      workspaceSlug: params.workspaceSlug,
      paneParam:
        cause === "enter"
          ? workspaceSearch(location.search as Record<string, unknown>).pane
          : undefined,
    })
  },
  errorComponent: ({ error, reset }) => (
    <WorkspaceRouteError error={error} reset={reset} />
  ),
  component: WorkspaceSlugLayout,
})

function WorkspaceSlugLayout() {
  return <Outlet />
}
