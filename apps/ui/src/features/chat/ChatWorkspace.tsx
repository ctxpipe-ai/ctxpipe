import { Card, CardContent } from "@/components/ui/Card"
import { useSession } from "@/lib/auth-client"
import { client } from "@/lib/api"
import { createObjectId } from "@/lib/id"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useChat } from "@ai-sdk/react"
import { Navigate, useRouter } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import type { ConversationDetail } from "./types"
import { createTransport } from "./chatTransport"
import { ConversationList } from "./ConversationList"
import { ConversationThread } from "./ConversationThread"
import { MessageInputBox } from "./MessageInputBox"
import { IconMessageCircle } from "@tabler/icons-react"

export function ChatWorkspace(props: {
  orgSlug: string
  conversationId?: string
}) {
  const { data: session, isPending: sessionPending } = useSession()
  const queryClient = useQueryClient()
  const router = useRouter()
  const { orgSlug, conversationId: conversationIdFromParams } = props

  const [initialConversationId] = useState(() => createObjectId("conv"))
  const conversationId = conversationIdFromParams ?? initialConversationId

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

  const { messages, sendMessage, status, error } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
    onFinish: () => {
      void queryClient.invalidateQueries({
        queryKey: ["conversations", orgSlug],
      })
    },
  })

  const isOnIndexRoute = conversationIdFromParams === undefined

  const handleSendMessage = (params: { text: string }) => {
    sendMessage(params)
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
    <main className="h-full min-h-0 p-2 sm:p-4">
      <section className="grid h-full min-h-0 grid-cols-[280px_1fr] gap-3">
        <ConversationList
          orgSlug={orgSlug}
          currentConversationId={conversationIdFromParams}
          onSelectConversation={(id) => {
            void queryClient.invalidateQueries({
              queryKey: ["conversation", orgSlug, id],
            })
            void router.navigate({
              to: "/$orgSlug/chat/$conversationId",
              params: { orgSlug, conversationId: id },
            })
          }}
        />

        {isOnIndexRoute && messages.length === 0 ? (
          <Card className="h-full min-h-0 border-zinc-800 bg-zinc-950/70 py-0">
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
          <div className="flex h-full min-h-0 flex-col">
            <ConversationThread messages={messages} error={error ?? null} />
            <MessageInputBox
              sendMessage={handleSendMessage}
              isDisabled={status === "submitted" || status === "streaming"}
            />
          </div>
        )}
      </section>
    </main>
  )
}
