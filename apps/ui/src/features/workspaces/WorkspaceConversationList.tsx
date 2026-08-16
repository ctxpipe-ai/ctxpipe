import { useInfiniteQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/Button"
import type { ConversationListItem } from "@/features/chat/types"
import { client } from "@/lib/api"
import { workspaceKeys } from "./queries"
import type { Workspace } from "./types"

export function WorkspaceConversationList(props: {
  orgSlug: string
  workspace: Workspace
  currentConversationId?: string
  onSelect: (conversationId: string) => void
}) {
  const { orgSlug, workspace, currentConversationId, onSelect } = props
  const query = useInfiniteQuery({
    queryKey: workspaceKeys.conversations(orgSlug, workspace.id),
    queryFn: async ({ pageParam }) => {
      const res = await client[":orgSlug"].api.v1.conversations.$get({
        param: { orgSlug },
        query: {
          source: "ui",
          workspaceId: workspace.id,
          first: 5,
          ...(pageParam != null &&
            pageParam !== "" && { after: pageParam as string }),
        },
      })
      if (!res.ok) throw new Error("Failed to fetch conversations")
      return res.json() as Promise<{
        items: ConversationListItem[]
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
      }>
    },
    getNextPageParam: (lastPage) =>
      lastPage.pageInfo.hasNextPage && lastPage.pageInfo.endCursor
        ? lastPage.pageInfo.endCursor
        : undefined,
    initialPageParam: undefined as string | undefined,
  })

  const items = query.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <ul className="mb-1 pl-8 pr-5">
      {query.isPending ? (
        <li className="py-1 text-xs text-muted-foreground">Loading…</li>
      ) : items.length === 0 ? (
        <li className="py-1 text-xs text-muted-foreground">No conversations</li>
      ) : (
        items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onSelect(item.id)}
              className={[
                "w-full truncate rounded-lg py-1 text-left text-xs",
                currentConversationId === item.id
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {item.name}
            </button>
          </li>
        ))
      )}
      {query.hasNextPage ? (
        <li>
          <Button
            variant="quiet"
            onPress={() => {
              void query.fetchNextPage()
            }}
            className="h-7 px-0 text-xs"
          >
            Load more
          </Button>
        </li>
      ) : null}
    </ul>
  )
}
