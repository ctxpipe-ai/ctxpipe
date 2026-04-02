import { useChat } from "@ai-sdk/react"
import { IconChevronRight, IconMessageCircle } from "@tabler/icons-react"
import {
  type InfiniteData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Link, Navigate, useRouter } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { ShimmerPlaceholder } from "@/components/ui/ShimmerPlaceholder"
import { client } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import { createObjectId } from "@/lib/id"
import { ConversationList } from "./ConversationList"
import { ConversationThread } from "./ConversationThread"
import { createTransport } from "./chatTransport"
import { ChatWorkspaceSkeleton } from "./components/ChatWorkspaceSkeleton"
import { ConversationThreadSkeleton } from "./components/ConversationThreadSkeleton"
import { MessageInputBox } from "./MessageInputBox"
import type {
  ConversationDetail,
  ConversationListItem,
  PageInfo,
} from "./types"

export function ChatWorkspace(props: {
  orgSlug: string
  conversationId?: string
}) {
  const { data: session, isPending: sessionPending } = useSession()
  const queryClient = useQueryClient()
  const router = useRouter()
  const { orgSlug, conversationId: conversationIdFromParams } = props

  const [conversationId] = useState(
    () => conversationIdFromParams ?? createObjectId("conv"),
  )

  const detailQuery = useQuery({
    queryKey: ["conversation", orgSlug, conversationIdFromParams],
    enabled: Boolean(conversationIdFromParams),
    queryFn: async () => {
      if (!conversationIdFromParams) {
        throw new Error("Missing conversation id")
      }
      const res = await client[":orgSlug"].api.v1.conversations[
        ":conversationId"
      ].$get({
        param: { orgSlug, conversationId: conversationIdFromParams },
      })
      if (res.status === 404) return null
      if (!res.ok) throw new Error("Failed to load conversation")
      return (await res.json()) as ConversationDetail
    },
  })

  const transport = useMemo(
    () => createTransport({ orgSlug, conversationId }),
    [orgSlug, conversationId],
  )

  const initialMessages =
    conversationIdFromParams && detailQuery.data
      ? detailQuery.data.messages
      : []

  const { messages, sendMessage, status, error, setMessages, stop } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
    onData: ({ type, data }) => {
      if (
        type === "data-rename-conversation" &&
        data &&
        typeof data === "object" &&
        "name" in data &&
        typeof (data as { name: unknown }).name === "string"
      ) {
        const name = (data as { name: string }).name
        queryClient.setQueryData<ConversationDetail>(
          ["conversation", orgSlug, conversationId],
          (old) =>
            old ? { ...old, conversation: { ...old.conversation, name } } : old,
        )
        queryClient.setQueriesData<{
          pages: { items: { id: string; name: string }[] }[]
        }>({ queryKey: ["conversations", orgSlug], exact: false }, (old) =>
          old && "pages" in old
            ? {
                ...old,
                pages: old.pages.map((page) => ({
                  ...page,
                  items: page.items.map((c) =>
                    c.id === conversationId ? { ...c, name } : c,
                  ),
                })),
              }
            : old,
        )
      }
    },
  })

  useEffect(() => {
    if (conversationIdFromParams && initialMessages.length > 0) {
      setMessages(initialMessages)
    }
  }, [conversationIdFromParams, initialMessages, setMessages])

  const isOnIndexRoute = conversationIdFromParams === undefined

  const handleSendMessage = async (params: { text: string }) => {
    if (isOnIndexRoute) {
      const optimisticItem: ConversationListItem = {
        id: conversationId,
        name: "New Chat",
        source: "ui",
        lastMessageAt: new Date().toISOString(),
      }
      const emptyPageInfo: PageInfo = {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      }
      queryClient.setQueryData<
        InfiniteData<{ items: ConversationListItem[]; pageInfo: PageInfo }>
      >(["conversations", orgSlug, "ui"], (old) => {
        if (!old) {
          return {
            pages: [{ items: [optimisticItem], pageInfo: emptyPageInfo }],
            pageParams: [undefined],
          }
        }
        return {
          ...old,
          pages: old.pages.map((page, i) =>
            i === 0
              ? { ...page, items: [optimisticItem, ...page.items] }
              : page,
          ),
        }
      })
    }
    await sendMessage(params)
    void queryClient.invalidateQueries({ queryKey: ["conversations", orgSlug] })
    if (isOnIndexRoute) {
      void router.navigate({
        to: "/$orgSlug/chat/$conversationId",
        params: { orgSlug, conversationId },
      })
    }
  }

  if (sessionPending) return <ChatWorkspaceSkeleton orgSlug={orgSlug} />
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  return (
    <main className="flex h-screen max-h-screen min-h-0 w-full flex-1 flex-col text-foreground sm:pl-3 md:flex-row">
      <div className="flex max-h-[38vh] shrink-0 flex-col border-b border-white/[0.04] md:max-h-none md:h-full md:w-64 md:border-b-0 md:border-r">
        <ConversationList
          orgSlug={orgSlug}
          currentConversationId={conversationIdFromParams}
        />
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.04] px-6 py-4">
          <Link
            to="/$orgSlug/chat"
            params={{ orgSlug }}
            className="text-sm text-muted-foreground no-underline hover:text-foreground"
          >
            chat
          </Link>
          {!isOnIndexRoute ? (
            <>
              <IconChevronRight
                aria-hidden
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50"
              />
              {detailQuery.isLoading ? (
                <ShimmerPlaceholder className="inline-block h-4 w-40 max-w-[min(100%,16rem)]" />
              ) : (
                <span className="truncate text-sm text-foreground">
                  {detailQuery.data?.conversation.name ?? "Unknown"}
                </span>
              )}
            </>
          ) : null}
        </div>

        {isOnIndexRoute && messages.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-8">
            <div className="w-full max-w-2xl space-y-8">
              <div className="text-center">
                <div className="ctx-node mx-auto mb-6 flex h-14 w-14 items-center justify-center">
                  <IconMessageCircle
                    aria-hidden
                    className="h-6 w-6 text-muted-foreground"
                  />
                </div>
                <h2 className="text-xl font-medium tracking-tight text-foreground">
                  Start a new chat
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Query your knowledge graph. Your first message creates a new
                  conversation.
                </p>
              </div>
              <MessageInputBox
                layout="empty"
                sendMessage={handleSendMessage}
                status={status}
                onStop={stop}
                isDisabled={status === "submitted" || status === "streaming"}
              />
            </div>
          </div>
        ) : (
          <>
            {conversationIdFromParams &&
            detailQuery.isLoading &&
            messages.length === 0 ? (
              <ConversationThreadSkeleton />
            ) : (
              <ConversationThread
                messages={messages}
                error={error ?? null}
                status={status}
              />
            )}
            <MessageInputBox
              layout="thread"
              sendMessage={handleSendMessage}
              status={status}
              onStop={stop}
              isDisabled={status === "submitted" || status === "streaming"}
            />
          </>
        )}
      </div>
    </main>
  )
}
