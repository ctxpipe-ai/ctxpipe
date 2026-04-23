import { createFileRoute } from "@tanstack/react-router"
import { ChatWorkspace } from "@/features/chat/ChatWorkspace"

export const Route = createFileRoute("/$orgSlug/chat/")({
  validateSearch: (search: Record<string, unknown>) => ({
    seed: typeof search.seed === "string" ? search.seed : undefined,
  }),
  component: ChatIndexRoute,
})

function ChatIndexRoute() {
  const { orgSlug } = Route.useParams()
  const { seed } = Route.useSearch()
  return <ChatWorkspace orgSlug={orgSlug} seed={seed} />
}
