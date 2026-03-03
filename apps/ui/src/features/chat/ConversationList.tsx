import { Card, CardContent } from "@/components/ui/Card"
import { Button } from "@/components/ui/Button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { IconFilter } from "@tabler/icons-react"
import { client } from "@/lib/api"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import type { ConversationListItem } from "./types"

export function ConversationList(props: {
  orgSlug: string
  currentConversationId: string | undefined
  onSelectConversation: (id: string) => void
}) {
  const { orgSlug, currentConversationId, onSelectConversation } = props
  const [sourceFilter, setSourceFilter] = useState<"ui" | "mcp">("ui")

  const conversationsQuery = useQuery({
    queryKey: ["conversations", orgSlug, sourceFilter],
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.conversations.$get({
        param: { orgSlug },
        query: { source: sourceFilter },
      })
      if (!res.ok) throw new Error("Failed to fetch conversations")
      const json = (await res.json()) as { items: ConversationListItem[] }
      return json.items
    },
  })

  return (
    <Card className="h-full min-h-0 border-zinc-800 bg-zinc-950/70 py-0">
      <CardContent className="flex h-full min-h-0 flex-col px-0">
        <div className="flex items-center justify-between border-b border-zinc-800 p-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            Conversations
          </p>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="quiet" aria-label="Filter by source" />}
            >
              <IconFilter className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={sourceFilter}
                onValueChange={(value) => setSourceFilter(value as "ui" | "mcp")}
              >
                <DropdownMenuRadioItem value="ui">UI</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="mcp">MCP</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <ol className="flex-1 overflow-y-auto">
          {conversationsQuery.data?.map((conversation) => (
            <li key={conversation.id}>
              <button
                type="button"
                className={[
                  "w-full border-b border-zinc-900 px-3 py-3 text-left transition-colors hover:bg-zinc-900/70",
                  conversation.id === currentConversationId ? "bg-zinc-900/80" : "",
                ].join(" ")}
                onClick={() => onSelectConversation(conversation.id)}
              >
                <p className="truncate text-sm font-medium text-zinc-100">
                  {conversation.name}
                </p>
                <p className="mt-1 text-xs text-zinc-400">
                  {conversation.lastMessageAt
                    ? new Date(conversation.lastMessageAt).toLocaleString()
                    : "No messages yet"}
                </p>
              </button>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}
