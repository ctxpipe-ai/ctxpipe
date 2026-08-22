import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { Link } from "react-aria-components"
import { SideNavTooltip } from "@/components/SideNav/SideNavTooltip"
import type { SideNavLocation } from "@/components/SideNav/sideNavLocation"
import {
  sideNavLabelClassName,
  sideNavRowClassName,
} from "@/components/SideNav/sideNavStyles"
import { Button } from "@/components/ui/Button"
import { SkeletonRow } from "@/components/ui/Skeleton"
import type { ConversationListItem } from "@/features/chat/types"
import { client } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"
import { conversationShortLabel } from "./conversationLabel"
import { workspaceConversationOptions, workspaceKeys } from "./queries"
import type { Workspace } from "./types"

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
  const queryClient = useQueryClient()
  const prefetchConversation = (conversationId: string) => {
    void queryClient.prefetchQuery(
      workspaceConversationOptions(orgSlug, conversationId, workspace.id),
    )
  }
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
      return readApiJson<{
        items: ConversationListItem[]
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
      }>(res, { message: "Failed to fetch conversations" })
    },
    getNextPageParam: (lastPage) =>
      lastPage.pageInfo.hasNextPage && lastPage.pageInfo.endCursor
        ? lastPage.pageInfo.endCursor
        : undefined,
    initialPageParam: undefined as string | undefined,
  })

  const items = query.data?.pages.flatMap((page) => page.items) ?? []

  // One layout for both states: short label sits in the icon gutter (stays put),
  // full name clips away as the rail width animates.
  return (
    <ul className="mt-0.5 mb-0.5 space-y-0.5">
      {query.isPending ? (
        <li className="space-y-0.5">
          <div aria-busy>
            <span className="sr-only">Loading conversations</span>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </div>
        </li>
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
        items.map((item) => {
          const active = currentConversationId === item.id
          const short = conversationShortLabel(item.name)
          const href = router.buildLocation({
            to: "/$orgSlug/ws/$workspaceSlug/$conversationId",
            params: {
              orgSlug,
              workspaceSlug: workspace.slug,
              conversationId: item.id,
            },
          }).href
          return (
            <li key={item.id}>
              <SideNavTooltip label={item.name} enabled={!navExpanded}>
                <Link
                  href={href}
                  onHoverStart={() => prefetchConversation(item.id)}
                  onPress={() => {
                    prefetchConversation(item.id)
                    onSelectNav({
                      orgSlug,
                      primary: "workspace",
                      workspaceSlug: workspace.slug,
                      conversationId: item.id,
                    })
                  }}
                  aria-current={active ? "page" : undefined}
                  aria-label={item.name}
                  className={sideNavRowClassName({ active })}
                >
                  <span className="relative flex size-8 shrink-0 items-center justify-center">
                    <span
                      className={[
                        "text-xs font-normal tracking-tight transition-opacity duration-200 ease-out motion-reduce:transition-none",
                        active ? "text-zinc-100" : "text-zinc-300",
                        // Overlay drawer (`max-md`) always shows names, never initials.
                        navExpanded
                          ? "opacity-0"
                          : "opacity-100 max-md:opacity-0",
                      ].join(" ")}
                      aria-hidden
                    >
                      {short}
                    </span>
                  </span>
                  <span
                    className={[
                      sideNavLabelClassName(navExpanded),
                      "truncate pr-3 text-left",
                      active ? "text-zinc-100" : "",
                    ].join(" ")}
                    aria-hidden={!navExpanded}
                  >
                    {item.name}
                  </span>
                </Link>
              </SideNavTooltip>
            </li>
          )
        })
      )}
      {query.hasNextPage ? (
        <li className="mx-1.5 pl-8">
          <Button
            variant="quiet"
            onPress={() => {
              void query.fetchNextPage()
            }}
            className={[
              "h-8 cursor-pointer px-0 text-sm transition-opacity duration-200",
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
