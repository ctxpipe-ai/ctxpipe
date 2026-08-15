import {
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconMessageCirclePlus,
} from "@tabler/icons-react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { useNavigate, useRouter } from "@tanstack/react-router"
import { useState } from "react"
import { Button } from "@/components/ui/Button"
import type { ConversationListItem } from "@/features/chat/types"
import { client } from "@/lib/api"
import { isWorkspaceNavOpen, workspaceTitleAction } from "./nav"
import { fetchWorkspaces, workspaceKeys } from "./queries"
import type { Workspace } from "./types"

export function WorkspaceNavList(props: {
  orgSlug: string
  expanded: boolean
  currentWorkspaceSlug?: string
  currentConversationId?: string
}) {
  const { orgSlug, expanded, currentWorkspaceSlug, currentConversationId } =
    props
  const workspacesQuery = useQuery({
    queryKey: workspaceKeys.list(orgSlug),
    queryFn: () => fetchWorkspaces(orgSlug),
  })
  const workspaces = workspacesQuery.data?.items ?? []
  const n = workspaces.length
  const [expandedIds, setExpandedIds] = useState<string[]>([])
  const [syncedSlug, setSyncedSlug] = useState<string | undefined>(undefined)
  const currentWorkspace = workspaces.find(
    (workspace) => workspace.slug === currentWorkspaceSlug,
  )
  if (n > 1 && currentWorkspace && currentWorkspaceSlug !== syncedSlug) {
    setSyncedSlug(currentWorkspaceSlug)
    if (!expandedIds.includes(currentWorkspace.id)) {
      setExpandedIds((ids) =>
        ids.includes(currentWorkspace.id) ? ids : [...ids, currentWorkspace.id],
      )
    }
  }

  if (!expanded && workspacesQuery.isPending) {
    return (
      <li>
        <span className="sr-only">Loading Workspaces</span>
      </li>
    )
  }

  return (
    <>
      {workspaces.map((workspace) => {
        const collapsible = n > 1
        const open = isWorkspaceNavOpen({
          workspaceCount: n,
          userExpanded: expandedIds.includes(workspace.id),
        })
        return (
          <WorkspaceNavRow
            key={workspace.id}
            orgSlug={orgSlug}
            workspace={workspace}
            workspaceCount={n}
            navExpanded={expanded}
            collapsible={collapsible}
            open={open}
            current={workspace.slug === currentWorkspaceSlug}
            currentConversationId={currentConversationId}
            onToggle={() => {
              setExpandedIds((ids) =>
                ids.includes(workspace.id)
                  ? ids.filter((id) => id !== workspace.id)
                  : [...ids, workspace.id],
              )
            }}
            onExpand={() => {
              setExpandedIds((ids) =>
                ids.includes(workspace.id) ? ids : [...ids, workspace.id],
              )
            }}
          />
        )
      })}
    </>
  )
}

function WorkspaceNavRow(props: {
  orgSlug: string
  workspace: Workspace
  workspaceCount: number
  navExpanded: boolean
  collapsible: boolean
  open: boolean
  current: boolean
  currentConversationId?: string
  onToggle: () => void
  onExpand: () => void
}) {
  const navigate = useNavigate()
  const router = useRouter()
  const {
    orgSlug,
    workspace,
    workspaceCount,
    navExpanded,
    collapsible,
    open,
    current,
    currentConversationId,
    onToggle,
    onExpand,
  } = props
  const [hovered, setHovered] = useState(false)

  const compose = () => {
    void navigate({
      to: "/$orgSlug/ws/$workspaceSlug",
      params: { orgSlug, workspaceSlug: workspace.slug },
    })
  }

  const resumeMostRecent = () => {
    if (workspace.mostRecentConversationId) {
      void navigate({
        to: "/$orgSlug/ws/$workspaceSlug/$conversationId",
        params: {
          orgSlug,
          workspaceSlug: workspace.slug,
          conversationId: workspace.mostRecentConversationId,
        },
      })
      return
    }
    compose()
  }

  const onTitleClick = () => {
    const action = workspaceTitleAction({
      workspaceCount,
      isCurrent: current,
    })
    if (action === "compose") {
      compose()
      return
    }
    if (action === "toggle") {
      onToggle()
      return
    }
    resumeMostRecent()
    onExpand()
  }

  const showCaret = collapsible && hovered && navExpanded

  return (
    <li>
      <div
        className={[
          "group relative flex h-10 items-center text-sm font-medium",
          current ? "bg-zinc-900/80 text-zinc-100" : "text-zinc-300",
        ].join(" ")}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-0 text-left"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onClick={onTitleClick}
          aria-expanded={navExpanded ? open : undefined}
          aria-label={
            collapsible
              ? current
                ? `${open ? "Collapse" : "Expand"} ${workspace.displayName}`
                : `Open ${workspace.displayName}`
              : `New conversation in ${workspace.displayName}`
          }
        >
          <span className="flex h-5 w-auto shrink-0 items-center justify-center px-5 text-zinc-400 group-hover:text-zinc-200">
            {showCaret ? (
              open ? (
                <IconChevronDown className="size-4" aria-hidden />
              ) : (
                <IconChevronRight className="size-4" aria-hidden />
              )
            ) : (
              <IconFolder className="size-4" aria-hidden />
            )}
          </span>
          {navExpanded ? (
            <span className="min-w-0 flex-1 truncate pr-1">
              {workspace.displayName}
            </span>
          ) : null}
        </button>
        {navExpanded ? (
          <Button
            variant="quiet"
            size="icon-sm"
            aria-label={`New conversation in ${workspace.displayName}`}
            className="mr-2"
            onPress={compose}
          >
            <IconMessageCirclePlus className="size-4" aria-hidden />
          </Button>
        ) : null}
      </div>
      {navExpanded && open ? (
        <WorkspaceConversationList
          orgSlug={orgSlug}
          workspace={workspace}
          currentConversationId={currentConversationId}
          onSelect={(conversationId) => {
            void router.navigate({
              to: "/$orgSlug/ws/$workspaceSlug/$conversationId",
              params: {
                orgSlug,
                workspaceSlug: workspace.slug,
                conversationId,
              },
            })
          }}
        />
      ) : null}
    </li>
  )
}

function WorkspaceConversationList(props: {
  orgSlug: string
  workspace: Workspace
  currentConversationId?: string
  onSelect: (conversationId: string) => void
}) {
  const { orgSlug, workspace, currentConversationId, onSelect } = props
  const query = useInfiniteQuery({
    queryKey: ["conversations", orgSlug, workspace.id, "ui"],
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
