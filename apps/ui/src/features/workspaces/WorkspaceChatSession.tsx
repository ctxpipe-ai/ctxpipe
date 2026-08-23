import type { StreamChunk } from "@tanstack/ai"
import {
  fetchServerSentEvents,
  type UIMessage,
  useChat,
} from "@tanstack/ai-react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type ReactNode, useMemo, useRef, useState } from "react"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { ConversationThread } from "@/features/chat/ConversationThread"
import { workspaceChatHttpPath } from "@/features/chat/chatConnection"
import { insertConversationListItem } from "@/features/chat/insertConversationListItem"
import { MessageInputBox } from "@/features/chat/MessageInputBox"
import type {
  ChatMessage,
  ConversationDetail,
  ConversationListInfiniteData,
} from "@/features/chat/types"
import { workspaceKeys } from "./queries"
import type { Workspace } from "./types"
import { WorkspaceChatChrome } from "./WorkspaceChatChrome"

export function workspaceChatHasAssistantText(
  messages: Array<Pick<ChatMessage, "role" | "parts">>,
): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => {
        if (part.type !== "text") return false
        const text = part.content ?? part.text ?? ""
        return Boolean(text.trim())
      }),
  )
}

function renameFromChunk(chunk: StreamChunk): string | null {
  if (chunk.type !== "CUSTOM") return null
  if (!("name" in chunk) || chunk.name !== "rename-conversation") return null
  const value = "value" in chunk ? chunk.value : null
  if (
    value &&
    typeof value === "object" &&
    "name" in value &&
    typeof value.name === "string"
  ) {
    return value.name
  }
  return null
}

export function WorkspaceChatSession(props: {
  orgSlug: string
  workspace: Workspace
  conversationId: string
  composing: boolean
  title: string
  initialMessages: ConversationDetail["messages"]
  headerExtra?: ReactNode
}) {
  const {
    orgSlug,
    workspace,
    conversationId,
    composing,
    title,
    initialMessages,
  } = props
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const sendFailedRef = useRef(false)
  const committedRef = useRef(false)
  const [headerTitle, setHeaderTitle] = useState(title)
  const [seenTitle, setSeenTitle] = useState(title)
  if (title !== seenTitle) {
    setSeenTitle(title)
    setHeaderTitle(title)
  }

  const connection = useMemo(
    () =>
      fetchServerSentEvents(workspaceChatHttpPath(orgSlug, conversationId), {
        credentials: "include",
      }),
    [orgSlug, conversationId],
  )

  const applyRename = (name: string) => {
    setHeaderTitle(name)
    queryClient.setQueryData<ConversationDetail>(
      workspaceKeys.conversation(orgSlug, conversationId, workspace.id),
      (old) =>
        old ? { ...old, conversation: { ...old.conversation, name } } : old,
    )
    queryClient.setQueriesData<ConversationListInfiniteData>(
      { queryKey: workspaceKeys.conversations(orgSlug, workspace.id) },
      (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                items: page.items.map((item) =>
                  item.id === conversationId ? { ...item, name } : item,
                ),
              })),
            }
          : old,
    )
  }

  const { messages, sendMessage, status, error, isLoading, stop } = useChat({
    threadId: conversationId,
    initialMessages: initialMessages as UIMessage[],
    connection,
    forwardedProps: {
      workspaceId: workspace.id,
      source: "ui",
    },
    onError: () => {
      sendFailedRef.current = true
    },
    onChunk: (chunk) => {
      const name = renameFromChunk(chunk)
      if (name) applyRename(name)
      if (chunk.type === "RUN_FINISHED") {
        void queryClient.invalidateQueries({
          queryKey: workspaceKeys.conversations(orgSlug, workspace.id),
        })
        void queryClient.invalidateQueries({
          queryKey: workspaceKeys.list(orgSlug),
        })
      }
    },
    onFinish: () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.conversations(orgSlug, workspace.id),
      })
    },
  })

  const insertComposeRow = () => {
    queryClient.setQueriesData<ConversationListInfiniteData>(
      { queryKey: workspaceKeys.conversations(orgSlug, workspace.id) },
      (old) =>
        insertConversationListItem(old, {
          id: conversationId,
          name: headerTitle || "New conversation",
          source: "ui",
          lastMessageAt: new Date().toISOString(),
        }),
    )
  }

  const commitComposeRoute = () => {
    if (!composing || committedRef.current || sendFailedRef.current) return
    committedRef.current = true
    void navigate({
      to: "/$orgSlug/ws/$workspaceSlug/$conversationId",
      params: {
        orgSlug,
        workspaceSlug: workspace.slug,
        conversationId,
      },
      search: (prev) => prev,
    })
  }

  const handleSendMessage = async (params: { text: string }) => {
    sendFailedRef.current = false
    insertComposeRow()
    commitComposeRoute()
    try {
      await sendMessage(params.text)
    } catch {
      return
    }
  }

  return (
    <WorkspaceChatChrome
      workspace={workspace}
      title={headerTitle}
      headerExtra={props.headerExtra}
    >
      {composing && messages.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10">
          <div className="w-full max-w-2xl space-y-5">
            <div>
              <h1 className="text-lg font-medium tracking-tight">
                {workspace.displayName}
              </h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Ask about this Workspace. The first message creates the
                conversation.
              </p>
            </div>
            <MessageInputBox
              layout="empty"
              sendMessage={handleSendMessage}
              status={status}
              onStop={stop}
              isDisabled={isLoading || Boolean(workspace.readOnlyReason)}
              placeholder="Ask about this Workspace…"
            />
            {error ? (
              <InlineAlert variant="error" title="Could not send">
                {error.message || "Chat request failed."} Send again to retry.
              </InlineAlert>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <ConversationThread
            messages={messages as ChatMessage[]}
            error={error ?? null}
            status={status}
          />
          <MessageInputBox
            layout="thread"
            sendMessage={handleSendMessage}
            status={status}
            onStop={stop}
            isDisabled={isLoading || Boolean(workspace.readOnlyReason)}
          />
        </>
      )}
    </WorkspaceChatChrome>
  )
}
