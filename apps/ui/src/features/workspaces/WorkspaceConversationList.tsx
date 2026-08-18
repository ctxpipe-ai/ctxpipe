import { useInfiniteQuery } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { Link } from "react-aria-components"
import {
  sideNavLabelClassName,
  sideNavRowClassName,
} from "@/components/SideNav/sideNavStyles"
import { SideNavTooltip } from "@/components/SideNav/SideNavTooltip"
import { Button } from "@/components/ui/Button"
import type { ConversationListItem } from "@/features/chat/types"
import { client } from "@/lib/api"
import { conversationShortLabel } from "./conversationLabel"
import { workspaceKeys } from "./queries"
import type { Workspace } from "./types"

export function WorkspaceConversationList(props: {
  orgSlug: string
  workspace: Workspace
  navExpanded: boolean
  currentConversationId?: string
}) {
  const { orgSlug, workspace, navExpanded, currentConversationId } = props
  const router = useRouter()
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

  // One layout for both states: short label sits in the icon gutter (stays put),
  // full name clips away as the rail width animates.
  return (
    <ul className="mt-0.5 mb-0.5 space-y-0.5">
      {query.isPending ? (
        <li
          className={[
            sideNavRowClassName({ active: false, interactive: false }),
            "text-muted-foreground",
          ].join(" ")}
        >
          <span className="flex size-8 shrink-0 items-center justify-center text-xs">
            …
          </span>
          <span className={sideNavLabelClassName(navExpanded)}>Loading…</span>
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
