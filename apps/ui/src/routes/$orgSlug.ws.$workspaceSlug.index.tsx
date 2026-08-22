import { createFileRoute } from "@tanstack/react-router"
import { workspaceSearch } from "@/features/workspaces/pane"

export const Route = createFileRoute("/$orgSlug/ws/$workspaceSlug/")({
  validateSearch: workspaceSearch,
  component: WorkspaceComposeRoute,
})

function WorkspaceComposeRoute() {
  return null
}
