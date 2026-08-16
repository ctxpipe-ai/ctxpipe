import { createFileRoute, Outlet } from "@tanstack/react-router"
import { workspaceSearch } from "@/features/workspaces/pane"

export const Route = createFileRoute("/$orgSlug/ws/$workspaceSlug")({
  validateSearch: workspaceSearch,
  component: WorkspaceSlugLayout,
})

function WorkspaceSlugLayout() {
  return <Outlet />
}
