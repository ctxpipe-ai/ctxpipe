import { createFileRoute, Outlet } from "@tanstack/react-router"
import { ensureWorkspaceRouteData } from "@/features/workspaces/ensure-route-data"
import { workspaceSearch } from "@/features/workspaces/pane"
import { WorkspaceRouteError } from "@/features/workspaces/WorkspaceRouteError"

export const Route = createFileRoute("/$orgSlug/ws/$workspaceSlug")({
  validateSearch: workspaceSearch,
  loaderDeps: ({ search }) => ({ pane: search.pane }),
  loader: async ({ context, params, deps }) => {
    await ensureWorkspaceRouteData({
      queryClient: context.queryClient,
      orgSlug: params.orgSlug,
      workspaceSlug: params.workspaceSlug,
      paneParam: deps.pane,
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
