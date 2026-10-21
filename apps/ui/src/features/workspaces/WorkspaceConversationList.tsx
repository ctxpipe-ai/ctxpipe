import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query"
import { useRouter, useSearch } from "@tanstack/react-router"
import { SideNavRowSkeleton } from "@/components/SideNav/SideNavRowSkeleton"
import type { SideNavLocation } from "@/components/SideNav/sideNavLocation"
import {
  sideNavLabelClassName,
  sideNavRowClassName,
} from "@/components/SideNav/sideNavStyles"
import { Button } from "@/components/ui/Button"
import { useSkeletonHold } from "@/components/ui/Skeleton"
import { client } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"
import { isLiveRun } from "./conversationStatus"
import { workspaceSearch } from "./pane"
import {
  conversationGitTreeOptions,
  workspaceConversationOptions,
  workspaceKeys,
} from "./queries"
import type { Workspace } from "./types"
import { WorkspaceConversationRow } from "./WorkspaceConversationRow"

export function WorkspaceConversationList(props: {
  orgSlug: string
  workspace: Workspace
  navExpanded: boolean
  currentConversationId?: string
  onSelectNav: (next: SideNavLocation) => void
}) {
  const {
    orgSlug,
    workspace,
    navExpanded,
    currentConversationId,
    onSelectNav,
  } = props
  const router = useRouter()
  const paneSearch = workspaceSearch(useSearch({ strict: false }))
  const queryClient = useQueryClient()
  const prefetchConversation = (conversationId: string) => {
    void queryClient.prefetchQuery(
      workspaceConversationOptions(orgSlug, conversationId, workspace.id),
    )
    void queryClient.prefetchQuery(
      conversationGitTreeOptions(orgSlug, conversationId),
    )
  }
  const query = useInfiniteQuery({
    queryKey: workspaceKeys.conversations(orgSlug, workspace.id),
    queryFn: async ({ pageParam }) => {
      const res = await client[":orgSlug"].api.v1.conversations.$get({
        param: { orgSlug },
        query: {
          workspaceId: workspace.id,
          first: 5,
          ...(pageParam != null &&
            pageParam !== "" && { after: pageParam as string }),
        },
      })
      return readApiJson(res, { message: "Failed to fetch conversations" })
    },
    getNextPageParam: (lastPage) =>
      lastPage.pageInfo.hasNextPage && lastPage.pageInfo.endCursor
        ? lastPage.pageInfo.endCursor
        : undefined,
    initialPageParam: undefined as string | undefined,
    // Refresh the status dots while a chat works, and stop when none does.
    refetchInterval: (current) =>
      current.state.data?.pages.some((page) =>
        page.items.some((item) => isLiveRun(item.lastTurn)),
      )
        ? 3000
        : false,
  })

  const loading = useSkeletonHold(query.isPending)
  const items = query.data?.pages.flatMap((page) => page.items) ?? []

  // One layout for both states: short label sits in the icon gutter (stays put),
  // full name clips away when the rail collapses.
  return (
    <ul className="mt-0.5 mb-0.5 space-y-0.5" aria-busy={loading || undefined}>
      {loading ? (
        <>
          <li className="sr-only">Loading conversations</li>
          {[0, 1, 2].map((row) => (
            <li key={row}>
              <SideNavRowSkeleton navExpanded={navExpanded} />
            </li>
          ))}
        </>
      ) : items.length === 0 ? (
        <li
          className={[
            sideNavRowClassName({ active: false, interactive: false }),
            "text-muted-foreground",
          ].join(" ")}
        >
          <span className="size-8 shrink-0" />
          <span className={sideNavLabelClassName(navExpanded)}>
            No conversations
          </span>
        </li>
      ) : (
        items.map((item) => (
          <WorkspaceConversationRow
            key={item.id}
            orgSlug={orgSlug}
            workspace={workspace}
            item={item}
            active={currentConversationId === item.id}
            navExpanded={navExpanded}
            href={
              router.buildLocation({
                to: "/$orgSlug/ws/$workspaceSlug/$conversationId",
                params: {
                  orgSlug,
                  workspaceSlug: workspace.slug,
                  conversationId: item.id,
                },
                search: paneSearch,
              }).href
            }
            paneSearch={paneSearch}
            prefetchConversation={prefetchConversation}
            onSelectNav={onSelectNav}
          />
        ))
      )}
      {query.hasNextPage ? (
        <li className="mx-1.5 pl-8">
          <Button
            variant="quiet"
            onPress={() => {
              void query.fetchNextPage()
            }}
            className={[
              "h-8 cursor-pointer px-0 text-sm",
              navExpanded ? "opacity-100" : "pointer-events-none opacity-0",
            ].join(" ")}
          >
            Load more
          </Button>
        </li>
      ) : null}
    </ul>
  )
}
