import { ChatWorkspace } from "@/features/chat/ChatWorkspace"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/$orgSlug/chat/")({
  component: ChatIndexRoute,
})

function ChatIndexRoute() {
  const { orgSlug } = Route.useParams()
  return <ChatWorkspace orgSlug={orgSlug} />
}
