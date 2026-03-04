import { Card, CardContent } from "@/components/ui/Card"
import { Button } from "@/components/ui/Button"
import { GridList, GridListItem } from "@/components/ui/GridList"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/Menu"
import { Modal } from "@/components/ui/Modal"
import { AlertDialog } from "@/components/ui/AlertDialog"
import { RenameConversationModal } from "./components/RenameConversationModal"
import {
  IconDotsVertical,
  IconFilter,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react"
import { client } from "@/lib/api"
import { Link, useRouter } from "@tanstack/react-router"
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
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
    <Card className="h-full min-h-0 border-zinc-800 bg-zinc-950/70">
      <CardContent className="flex h-full min-h-0 flex-col px-0">
        <div className="flex items-center justify-between border-b border-zinc-800 text-zinc-400 py-1 pl-4 pr-3 h-10">
          <Link
            to="/$orgSlug/chat"
            params={{ orgSlug }}
            className="inline-flex items-center gap-1.5 font-mono tracking-widest text-xs  transition-[color,filter] hover:text-teal-500 hover:[filter:drop-shadow(0_0_8px_var(--color-teal-500))] [&_svg]:size-3.5"
          >
            <IconPlus aria-hidden />
            NEW
          </Link>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="quiet" aria-label="Filter by source" />}
            >
              <IconFilter className="size-4 stroke-[1.5px]" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
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
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <GridList
            key={currentConversationId}
            aria-label="Conversations"
            items={conversationsQuery.data?.pages.flatMap((p) => p.items) ?? []}
            layout="stack"
            selectionBehavior="replace"
            selectedKeys={currentConversationId ? [currentConversationId] : []}
            className="min-h-0 w-full flex-1 overflow-y-auto border-0 bg-transparent p-0"
            renderEmptyState={() => (
              <span className="px-5 py-4 text-sm text-zinc-500">
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
                  "group flex flex-col w-full pl-5 pr-3 py-3 text-left transition-colors",
                  currentConversationId === conversation.id
                    ? "bg-zinc-800"
                    : "hover:bg-zinc-900/70",
                ].join(" ")}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-col flex-1 min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-100">
                      {conversation.name}
                    </p>
                    <p className="mt-1 text-xs text-zinc-400">
                      {conversation.lastMessageAt
                        ? new Date(conversation.lastMessageAt).toLocaleString()
                        : "No messages yet"}
                    </p>
                  </div>
                  <div className="shrink-0 opacity-40 transition-opacity group-hover:opacity-100">
                    <MenuTrigger placement="bottom end">
                      <Button
                        variant="quiet"
                        aria-label="More options"
                        className="text-zinc-400"
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
          {conversationsQuery.data?.pages.at(-1)?.pageInfo.hasNextPage && (
            <Button
              className="w-full border-r-0 border-b-0 border-l-0 border-t border-zinc-800 py-3 text-sm text-zinc-400 bg-zinc-950 hover:bg-zinc-900/70 hover:text-zinc-200 rounded-none"
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
      </CardContent>
    </Card>
  )
}
