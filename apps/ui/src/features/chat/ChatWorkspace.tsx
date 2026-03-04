import { Card, CardContent } from "@/components/ui/Card"
import { useSession } from "@/lib/auth-client"
import { client } from "@/lib/api"
import { createObjectId } from "@/lib/id"
import {
  type InfiniteData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useChat } from "@ai-sdk/react"
import { Link, Navigate, useRouter } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import type {
  ConversationDetail,
  ConversationListItem,
  PageInfo,
} from "./types"
import { createTransport } from "./chatTransport"
import { ConversationList } from "./ConversationList"
import { ConversationThread } from "./ConversationThread"
import { MessageInputBox } from "./MessageInputBox"
import { IconMessageCircle } from "@tabler/icons-react"
import { ShimmerPlaceholder } from "@/components/ui/ShimmerPlaceholder"

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

  const { messages, sendMessage, status, error, setMessages } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
    onData: ({ type, data }) => {
      if (type === "data-rename-conversation" && data && typeof data === "object" && "name" in data && typeof (data as { name: unknown }).name === "string") {
        const name = (data as { name: string }).name
        queryClient.setQueryData<ConversationDetail>(
          ["conversation", orgSlug, conversationId],
          (old) =>
            old
              ? { ...old, conversation: { ...old.conversation, name } }
              : old,
        )
        queryClient.setQueriesData<{
          pages: { items: { id: string; name: string }[] }[]
        }>(
          { queryKey: ["conversations", orgSlug], exact: false },
          (old) =>
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

  if (sessionPending) return null
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  return (
    <main className="flex h-screen max-h-screen flex-col">
      <div className="w-full flex">
        <div className="flex items-center gap-1 p-5 font-mono text-xs uppercase tracking-widest text-zinc-500">
          <Link
            to="/$orgSlug/chat"
            params={{ orgSlug }}
            className="no-underline hover:underline text-zinc-500 hover:text-zinc-500"
          >
            Chat
          </Link>
          <span aria-hidden>/</span>
          {isOnIndexRoute ? (
            <span>new</span>
          ) : detailQuery.isLoading ? (
            <ShimmerPlaceholder className="inline-block w-24 h-3" />
          ) : (
            <span>{detailQuery.data?.conversation.name ?? "Unknown"}</span>
          )}
        </div>
      </div>
      <section className="grid min-h-0 flex-1 grid-cols-[280px_1fr] gap-px mr-5 mb-5 ring-1 ring-zinc-800">
        <ConversationList
          orgSlug={orgSlug}
          currentConversationId={conversationIdFromParams}
        />

        {isOnIndexRoute && messages.length === 0 ? (
          <Card className="h-full min-h-0 border-zinc-800 bg-zinc-950/70 py-0 ring-0">
            <CardContent className="flex h-full min-h-0 flex-col justify-center gap-6">
              <div className="mx-auto flex max-w-xl flex-col items-center text-center">
                <IconMessageCircle className="h-10 w-10 text-zinc-500" />
                <h1 className="mt-3 text-2xl font-semibold text-zinc-100">
                  Start a new chat
                </h1>
                <p className="mt-2 text-sm text-zinc-400">
                  Your first message creates a new conversation.
                </p>
              </div>
              <div className="mx-auto w-full max-w-2xl">
                <MessageInputBox
                  sendMessage={handleSendMessage}
                  isDisabled={status === "submitted" || status === "streaming"}
                />
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="flex min-h-0 flex-1 flex-col gap-0">
            <ConversationThread messages={messages} error={error ?? null} />
            <MessageInputBox
              sendMessage={handleSendMessage}
              isDisabled={status === "submitted" || status === "streaming"}
            />
          </Card>
        )}
      </section>
    </main>
  )
}
