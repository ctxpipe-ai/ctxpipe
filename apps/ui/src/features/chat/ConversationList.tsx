import {
  IconAdjustmentsHorizontal,
  IconDotsVertical,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react"
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { Link, useRouter } from "@tanstack/react-router"
import { useState } from "react"
import { toast } from "sonner"
import { AlertDialog } from "@/components/ui/AlertDialog"
import { Button } from "@/components/ui/Button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { GridList, GridListItem } from "@/components/ui/GridList"
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/Menu"
import { Modal } from "@/components/ui/Modal"
import { client } from "@/lib/api"
import { ConversationListSkeleton } from "./components/ConversationListSkeleton"
import { RenameConversationModal } from "./components/RenameConversationModal"
import type { ConversationListItem } from "./types"

export function ConversationList(props: {
  orgSlug: string
  currentConversationId: string | undefined
}) {
  const { orgSlug, currentConversationId } = props
  const router = useRouter()
  const queryClient = useQueryClient()
  const [sourceFilter, setSourceFilter] = useState<"ui" | "mcp">("ui")
  const [conversationToRename, setConversationToRename] =
    useState<ConversationListItem | null>(null)
  const [conversationToDelete, setConversationToDelete] =
    useState<ConversationListItem | null>(null)

  const conversationsQuery = useInfiniteQuery({
    queryKey: ["conversations", orgSlug, sourceFilter],
    queryFn: async ({ pageParam }) => {
      const res = await client[":orgSlug"].api.v1.conversations.$get({
        param: { orgSlug },
        query: {
          source: sourceFilter,
          first: 10,
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
    refetchOnMount: false,
  })

  const renameMutation = useMutation({
    mutationFn: async ({
      conversationId,
      name,
    }: {
      conversationId: string
      name: string
    }) => {
      const res = await client[":orgSlug"].api.v1.conversations[
        ":conversationId"
      ].$patch({
        param: { orgSlug, conversationId },
        json: { name },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(
          (err as { error?: string }).error ?? "Failed to rename conversation",
        )
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations", orgSlug] })
      setConversationToRename(null)
      toast.success("Conversation renamed")
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (conversationId: string) => {
      const res = await client[":orgSlug"].api.v1.conversations[
        ":conversationId"
      ].$delete({
        param: { orgSlug, conversationId },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(
          (err as { error?: string }).error ?? "Failed to delete conversation",
        )
      }
    },
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ["conversations", orgSlug] })
      setConversationToDelete(null)
      if (deletedId === currentConversationId) {
        router.navigate({ to: "/$orgSlug/chat", params: { orgSlug } })
      }
      toast.success("Conversation deleted")
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between gap-3 p-4">
          <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
            conversations
          </span>
          <div className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="Filter by source"
                    className="inline-flex h-7 w-7 min-h-7 min-w-7 shrink-0 items-center justify-center text-zinc-300 transition-colors hover:bg-white/[0.05] hover:text-zinc-100"
                  >
                    <IconAdjustmentsHorizontal
                      className="size-[18px] stroke-[1.9px]"
                      aria-hidden
                    />
                  </button>
                }
              />
              <DropdownMenuContent align="end" className="rounded-none">
                <DropdownMenuRadioGroup
                  value={sourceFilter}
                  onValueChange={(value) =>
                    setSourceFilter(value as "ui" | "mcp")
                  }
                >
                  <DropdownMenuRadioItem value="ui">UI</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="mcp">MCP</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Link
              to="/$orgSlug/chat"
              params={{ orgSlug }}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground [&_svg]:size-4"
              aria-label="New conversation"
            >
              <IconPlus aria-hidden />
            </Link>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {conversationsQuery.isLoading && !conversationsQuery.data ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              <ConversationListSkeleton />
            </div>
          ) : (
            <GridList
              key={currentConversationId}
              aria-label="Conversations"
              items={
                conversationsQuery.data?.pages.flatMap((p) => p.items) ?? []
              }
              layout="stack"
              selectionBehavior="replace"
              selectedKeys={
                currentConversationId ? [currentConversationId] : []
              }
              className="flex min-h-0 w-full flex-1 flex-col gap-0.5 overflow-y-auto border-0 bg-transparent p-0 shadow-none ring-0 dark:bg-transparent px-2 pb-2"
              renderEmptyState={() => (
                <span className="px-2 py-4 text-sm text-muted-foreground">
                  No conversations
                </span>
              )}
            >
              {(conversation) => (
                <GridListItem
                  id={conversation.id}
                  textValue={conversation.name}
                  href={`/${orgSlug}/chat/${conversation.id}`}
                  className={[
                    "group flex w-full flex-col rounded-none border-0 p-2.5 pr-1 text-left transition-colors first:border-t-0",
                    currentConversationId === conversation.id
                      ? "bg-white/[0.05]"
                      : "hover:bg-white/[0.03]",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <p className="truncate text-sm text-foreground">
                        {conversation.name}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {conversation.lastMessageAt
                          ? new Date(
                              conversation.lastMessageAt,
                            ).toLocaleString()
                          : "No messages yet"}
                      </p>
                    </div>
                    <div className="shrink-0 opacity-40 transition-opacity group-hover:opacity-100">
                      <MenuTrigger placement="bottom end">
                        <Button
                          variant="quiet"
                          size="icon-sm"
                          aria-label="More options"
                          className="text-muted-foreground"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                          }}
                        >
                          <IconDotsVertical className="size-4" />
                        </Button>
                        <Menu
                          onAction={(key) => {
                            if (key === "rename")
                              setConversationToRename(conversation)
                            if (key === "delete")
                              setConversationToDelete(conversation)
                          }}
                        >
                          <MenuItem id="rename" textValue="Rename">
                            <IconPencil className="size-4" />
                            Rename
                          </MenuItem>
                          <MenuItem
                            id="delete"
                            textValue="Delete"
                            className="text-red-400"
                          >
                            <IconTrash className="size-4" />
                            Delete
                          </MenuItem>
                        </Menu>
                      </MenuTrigger>
                    </div>
                  </div>
                </GridListItem>
              )}
            </GridList>
          )}
          {conversationsQuery.data?.pages.at(-1)?.pageInfo.hasNextPage && (
            <Button
              variant="quiet"
              className="mt-1 w-full rounded-none px-2 py-3 text-sm text-muted-foreground hover:bg-white/[0.03] hover:text-foreground"
              onPress={() => conversationsQuery.fetchNextPage()}
              isDisabled={conversationsQuery.isFetchingNextPage}
            >
              {conversationsQuery.isFetchingNextPage ? "Loading…" : "Show more"}
            </Button>
          )}
        </div>

        {conversationToRename && (
          <Modal
            isOpen={!!conversationToRename}
            onOpenChange={(open) => !open && setConversationToRename(null)}
            isDismissable
          >
            <RenameConversationModal
              conversationName={conversationToRename.name}
              onClose={() => setConversationToRename(null)}
              onSubmit={(name) =>
                renameMutation.mutate({
                  conversationId: conversationToRename.id,
                  name,
                })
              }
              isPending={renameMutation.isPending}
              error={renameMutation.error?.message}
            />
          </Modal>
        )}

        {conversationToDelete && (
          <Modal
            isOpen={!!conversationToDelete}
            onOpenChange={(open) => !open && setConversationToDelete(null)}
            isDismissable
          >
            <AlertDialog
              title="Delete conversation"
              variant="destructive"
              actionLabel="Delete"
              cancelLabel="Cancel"
              onAction={() => deleteMutation.mutate(conversationToDelete.id)}
            >
              Are you sure you want to delete "{conversationToDelete.name}"?
              This action cannot be undone.
            </AlertDialog>
          </Modal>
        )}
      </div>
    </aside>
  )
}
