import { createFileRoute } from "@tanstack/react-router"
import { workspaceSearch } from "@/features/workspaces/pane"
import { WorkspaceSurface } from "@/features/workspaces/WorkspaceSurface"

export const Route = createFileRoute("/$orgSlug/ws/$workspaceSlug")({
  validateSearch: workspaceSearch,
  component: WorkspaceComposeRoute,
})

function WorkspaceComposeRoute() {
  const { orgSlug, workspaceSlug } = Route.useParams()
  const { pane } = Route.useSearch()
  return (
    <WorkspaceSurface
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      paneParam={pane}
    />
  )
}
