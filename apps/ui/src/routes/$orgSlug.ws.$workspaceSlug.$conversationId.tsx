import { createFileRoute } from "@tanstack/react-router"
import { workspaceSearch } from "@/features/workspaces/pane"
import { WorkspaceSurface } from "@/features/workspaces/WorkspaceSurface"

export const Route = createFileRoute(
  "/$orgSlug/ws/$workspaceSlug/$conversationId",
)({
  validateSearch: workspaceSearch,
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
