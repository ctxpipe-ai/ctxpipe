import { useChat } from "@ai-sdk/react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { ConversationThread } from "@/features/chat/ConversationThread"
import { createTransport } from "@/features/chat/chatTransport"
import { MessageInputBox } from "@/features/chat/MessageInputBox"
import type { ConversationDetail } from "@/features/chat/types"
import { workspaceKeys } from "./queries"
import type { Workspace } from "./types"
import { WorkspaceChatChrome } from "./WorkspaceChatChrome"

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
  useEffect(() => {
    setHeaderTitle(title)
  }, [title])

  const transport = useMemo(
    () =>
      createTransport({
        orgSlug,
        conversationId,
        workspaceId: workspace.id,
      }),
    [orgSlug, conversationId, workspace.id],
  )

  const { messages, sendMessage, status, error, stop } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
    onError: () => {
      sendFailedRef.current = true
    },
    onData: ({ type, data }) => {
      if (
        type === "data-rename-conversation" &&
        data &&
        typeof data === "object" &&
        "name" in data &&
        typeof (data as { name: string }).name === "string"
      ) {
        const name = (data as { name: string }).name
        setHeaderTitle(name)
        queryClient.setQueryData<ConversationDetail>(
          workspaceKeys.conversation(orgSlug, conversationId, workspace.id),
          (old) =>
            old ? { ...old, conversation: { ...old.conversation, name } } : old,
        )
        queryClient.setQueriesData<{
          pages: { items: { id: string; name: string }[] }[]
        }>(
          { queryKey: workspaceKeys.conversations(orgSlug, workspace.id) },
          (old) =>
            old && "pages" in old
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
    },
  })

  useEffect(() => {
    if (!composing || committedRef.current) return
    if (status !== "streaming") return
    if (sendFailedRef.current) return
    committedRef.current = true
    void queryClient.invalidateQueries({
      queryKey: workspaceKeys.conversations(orgSlug, workspace.id),
    })
    void queryClient.invalidateQueries({
      queryKey: workspaceKeys.list(orgSlug),
    })
    void navigate({
      to: "/$orgSlug/ws/$workspaceSlug/$conversationId",
      params: {
        orgSlug,
        workspaceSlug: workspace.slug,
        conversationId,
      },
    })
  }, [
    composing,
    conversationId,
    navigate,
    orgSlug,
    queryClient,
    status,
    workspace.id,
    workspace.slug,
  ])

  const handleSendMessage = async (params: { text: string }) => {
    sendFailedRef.current = false
    try {
      await sendMessage(params)
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
              isDisabled={status === "submitted" || status === "streaming"}
              placeholder="Ask about this Workspace…"
            />
            {error ? (
              <p className="text-sm text-destructive">
                {error.message || "Chat request failed."}
              </p>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <ConversationThread
            messages={messages}
            error={error ?? null}
            status={status}
          />
          <MessageInputBox
            layout="thread"
            sendMessage={handleSendMessage}
            status={status}
            onStop={stop}
            isDisabled={status === "submitted" || status === "streaming"}
          />
        </>
      )}
    </WorkspaceChatChrome>
  )
}
