import { ChatWorkspace } from "@/features/chat/ChatWorkspace"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/$orgSlug/chat/$conversationId")({
  component: ConversationRoute,
})

function ConversationRoute() {
  const { orgSlug, conversationId } = Route.useParams()
  return <ChatWorkspace orgSlug={orgSlug} conversationId={conversationId} />
}
