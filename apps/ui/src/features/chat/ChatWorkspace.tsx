import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import { Card, CardContent } from "@/components/ui/Card"
import { useSession } from "@/lib/auth-client"
import { client } from "@/lib/api"
import { createObjectId } from "@/lib/id"
import { useChat } from "@ai-sdk/react"
import type { UIMessage } from "ai"
import { DefaultChatTransport, TextStreamChatTransport } from "ai"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Navigate, useRouter } from "@tanstack/react-router"
import { IconMessageCircle } from "@tabler/icons-react"
import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/Button"

type ConversationListItem = {
  id: string
  name: string
  source: string
  lastMessageAt: string | null
}

type ConversationDetail = {
  conversation: ConversationListItem & {
    orgId: string
    createdAt: string
    updatedAt: string
  }
  messages: UIMessage[]
}

const PENDING_MESSAGE_PREFIX = "chat-pending:"

export function ChatWorkspace(props: {
  orgSlug: string
  conversationId?: string
}) {
  const { data: session, isPending: sessionPending } = useSession()
  const [sourceFilter, setSourceFilter] = useState("ui")
  const queryClient = useQueryClient()
  const router = useRouter()
  const { orgSlug, conversationId } = props

  const conversationsQuery = useQuery({
    queryKey: ["conversations", orgSlug, sourceFilter],
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.conversations.$get({
        param: { orgSlug },
        query: { source: sourceFilter },
      })
      if (!res.ok) throw new Error("Failed to fetch conversations")
      const json = (await res.json()) as { items: ConversationListItem[] }
      return json.items
    },
  })

  const detailQuery = useQuery({
    queryKey: ["conversation", orgSlug, conversationId],
    enabled: Boolean(conversationId),
    queryFn: async () => {
      if (!conversationId) {
        throw new Error("Missing conversation id")
      }
      const res = await client[":orgSlug"].api.v1.conversations[
        ":conversationId"
      ].$get({
        param: { orgSlug, conversationId },
      })
      if (!res.ok) throw new Error("Failed to load conversation")
      return (await res.json()) as ConversationDetail
    },
  })

  if (sessionPending) return null
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  return (
    <main className="h-full min-h-0 p-2 sm:p-4">
      <section className="grid h-full min-h-0 grid-cols-[280px_1fr] gap-3">
        <Card className="h-full min-h-0 border-zinc-800 bg-zinc-950/70 py-0">
          <CardContent className="flex h-full min-h-0 flex-col px-0">
            <div className="border-b border-zinc-800 p-3">
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                Conversations
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  variant={sourceFilter === "ui" ? "secondary" : "quiet"}
                  onPress={() => setSourceFilter("ui")}
                >
                  UI
                </Button>
                <Button
                  variant={sourceFilter === "all" ? "secondary" : "quiet"}
                  onPress={() => setSourceFilter("all")}
                >
                  All
                </Button>
              </div>
            </div>
            <ol className="flex-1 overflow-y-auto">
              {conversationsQuery.data?.map((conversation) => (
                <li key={conversation.id}>
                  <button
                    type="button"
                    className={[
                      "w-full border-b border-zinc-900 px-3 py-3 text-left transition-colors hover:bg-zinc-900/70",
                      conversation.id === conversationId ? "bg-zinc-900/80" : "",
                    ].join(" ")}
                    onClick={() => {
                      void queryClient.invalidateQueries({
                        queryKey: ["conversation", orgSlug, conversation.id],
                      })
                      void router.navigate({
                        to: "/$orgSlug/chat/$conversationId",
                        params: { orgSlug, conversationId: conversation.id },
                      })
                    }}
                  >
                    <p className="truncate text-sm font-medium text-zinc-100">
                      {conversation.name}
                    </p>
                    <p className="mt-1 text-xs text-zinc-400">
                      {conversation.lastMessageAt
                        ? new Date(conversation.lastMessageAt).toLocaleString()
                        : "No messages yet"}
                    </p>
                  </button>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        {conversationId ? (
          detailQuery.data ? (
            <ConversationThread
              key={conversationId}
              conversationId={conversationId}
              orgSlug={orgSlug}
              initialMessages={detailQuery.data.messages}
              onConversationUpdated={() => {
                void queryClient.invalidateQueries({
                  queryKey: ["conversations", orgSlug],
                })
              }}
            />
          ) : (
            <Card className="h-full min-h-0 border-zinc-800 bg-zinc-950/70 py-0">
              <CardContent className="flex h-full min-h-0 flex-col items-center justify-center">
                <p className="text-sm text-zinc-500">
                  {detailQuery.isPending ? "Loading conversation…" : "Failed to load conversation"}
                </p>
              </CardContent>
            </Card>
          )
        ) : (
          <NewConversationComposer orgSlug={orgSlug} />
        )}
      </section>
    </main>
  )
}

function NewConversationComposer(props: { orgSlug: string }) {
  const [input, setInput] = useState("")
  const router = useRouter()
  return (
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
        <form
          className="mx-auto w-full max-w-2xl rounded-xl border border-zinc-800 bg-zinc-900/70 p-3"
          onSubmit={(event) => {
            event.preventDefault()
            const text = input.trim()
            if (!text) return

            const conversationId = createObjectId("conv")
            sessionStorage.setItem(
              `${PENDING_MESSAGE_PREFIX}${conversationId}`,
              text,
            )
            setInput("")
            void router.navigate({
              to: "/$orgSlug/chat/$conversationId",
              params: { orgSlug: props.orgSlug, conversationId },
            })
          }}
        >
          <textarea
            value={input}
            onChange={(event) => setInput(event.currentTarget.value)}
            placeholder="Ask anything..."
            className="h-20 w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
          />
          <div className="mt-2 flex justify-end">
            <Button
              variant="secondary"
              type="submit"
              isDisabled={input.trim().length === 0}
            >
              Start chat
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function ConversationThread(props: {
  orgSlug: string
  conversationId: string
  initialMessages: UIMessage[]
  onConversationUpdated: () => void
}) {
  const [streamProtocol, setStreamProtocol] = useState<"data" | "text">("data")
  const [input, setInput] = useState("")
  const [optimisticMessages, setOptimisticMessages] = useState<UIMessage[]>([])

  const transport = useMemo(
    () =>
      createTransport({
        streamProtocol,
        orgSlug: props.orgSlug,
        conversationId: props.conversationId,
      }),
    [props.conversationId, props.orgSlug, streamProtocol],
  )

  const { messages, sendMessage, status, error } = useChatWithInitialMessages({
    conversationId: props.conversationId,
    initialMessages: props.initialMessages,
    transport,
    onFinish: props.onConversationUpdated,
  })

  useEffect(() => {
    const pendingKey = `${PENDING_MESSAGE_PREFIX}${props.conversationId}`
    const pendingMessage = sessionStorage.getItem(pendingKey)
    if (!pendingMessage) return

    sessionStorage.removeItem(pendingKey)
    setOptimisticMessages((prev) => [...prev, createOptimisticUserMessage(pendingMessage)])
    sendMessage({ text: pendingMessage })
  }, [props.conversationId, sendMessage])

  useEffect(() => {
    if (messages.length > 0) {
      setOptimisticMessages([])
    }
  }, [messages])

  const displayedMessages = messages.length > 0 ? messages : optimisticMessages

  return (
    <Card className="h-full min-h-0 border-zinc-800 bg-zinc-950/70 py-0">
      <CardContent className="flex h-full min-h-0 flex-col px-0">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            Conversation
          </p>
          <div className="flex gap-2">
            <Button
              variant={streamProtocol === "data" ? "secondary" : "quiet"}
              onPress={() => setStreamProtocol("data")}
            >
              Data stream
            </Button>
            <Button
              variant={streamProtocol === "text" ? "secondary" : "quiet"}
              onPress={() => setStreamProtocol("text")}
            >
              Text stream
            </Button>
          </div>
        </div>
        <Conversation className="min-h-0">
          <ConversationContent className="px-4 py-6">
            {displayedMessages.length === 0 ? (
              <ConversationEmptyState
                icon={<IconMessageCircle className="h-10 w-10" />}
                title="No messages yet"
                description="Send the first message to begin."
              />
            ) : (
              displayedMessages.map((message) => (
                <Message key={message.id} from={message.role}>
                  <MessageContent>
                    {message.parts.map((part, index) =>
                      renderMessagePart(part, `${message.id}-${index}`),
                    )}
                  </MessageContent>
                </Message>
              ))
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
        {error ? (
          <p className="px-4 pb-2 text-sm text-red-400">
            {error.message || "Chat request failed."}
          </p>
        ) : null}
        <form
          className="border-t border-zinc-800 px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            const text = input.trim()
            if (!text) return
            setOptimisticMessages((prev) => [...prev, createOptimisticUserMessage(text)])
            sendMessage({ text })
            setInput("")
          }}
        >
          <textarea
            value={input}
            onChange={(event) => setInput(event.currentTarget.value)}
            placeholder="Ask anything..."
            disabled={status === "submitted" || status === "streaming"}
            className="h-20 w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 disabled:opacity-50"
          />
          <div className="mt-2 flex justify-end">
            <Button
              variant="secondary"
              type="submit"
              isDisabled={
                input.trim().length === 0 ||
                status === "submitted" ||
                status === "streaming"
              }
            >
              Send
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function useChatWithInitialMessages(input: {
  conversationId: string
  initialMessages: UIMessage[]
  transport: ReturnType<typeof createTransport>
  onFinish: () => void
}) {
  return useChat({
    id: input.conversationId,
    messages: input.initialMessages,
    transport: input.transport,
    onFinish: input.onFinish,
  })
}

function createTransport(input: {
  streamProtocol: "data" | "text"
  orgSlug: string
  conversationId: string
}) {
  const apiBase = `/${input.orgSlug}/api/v1/conversations/${input.conversationId}`
  if (input.streamProtocol === "text") {
    return new TextStreamChatTransport({
      api: `${apiBase}?protocol=text`,
      credentials: "include",
      prepareSendMessagesRequest: ({ messages }) => ({
        body: {
          message: messages[messages.length - 1],
          source: "ui",
        },
      }),
    })
  }
  return new DefaultChatTransport({
    api: apiBase,
    credentials: "include",
    prepareSendMessagesRequest: ({ messages }) => ({
      body: {
        message: messages[messages.length - 1],
        source: "ui",
      },
    }),
  })
}

function renderMessagePart(part: UIMessage["parts"][number], key: string) {
  if (part.type === "text") {
    return <MessageResponse key={key}>{part.text}</MessageResponse>
  }
  if (part.type === "reasoning") {
    return (
      <details
        key={key}
        className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3 text-sm text-zinc-300"
      >
        <summary className="cursor-pointer text-zinc-200">Reasoning</summary>
        <MessageResponse>{part.text}</MessageResponse>
      </details>
    )
  }
  if (part.type === "source-url") {
    return (
      <p key={key} className="text-xs text-zinc-400">
        Source:{" "}
        <a className="text-teal-300 underline" href={part.url} target="_blank">
          {part.title ?? part.url}
        </a>
      </p>
    )
  }
  if (part.type === "source") {
    return (
      <p key={key} className="text-xs text-zinc-400">
        Source:{" "}
        <a className="text-teal-300 underline" href={part.url} target="_blank">
          {part.title ?? part.url}
        </a>
      </p>
    )
  }
  if (part.type.startsWith("data-")) {
    return (
      <pre key={key} className="text-xs text-zinc-400">
        {JSON.stringify(part.data)}
      </pre>
    )
  }
  return null
}

function createOptimisticUserMessage(text: string): UIMessage {
  return {
    id: `optimistic-${crypto.randomUUID()}`,
    role: "user",
    parts: [{ type: "text", text }],
  }
}
