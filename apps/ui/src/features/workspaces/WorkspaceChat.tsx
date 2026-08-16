import { useChat } from "@ai-sdk/react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { ShimmerPlaceholder } from "@/components/ui/ShimmerPlaceholder"
import { ConversationThread } from "@/features/chat/ConversationThread"
import { createTransport } from "@/features/chat/chatTransport"
import { ConversationThreadSkeleton } from "@/features/chat/components/ConversationThreadSkeleton"
import { MessageInputBox } from "@/features/chat/MessageInputBox"
import type { ConversationDetail } from "@/features/chat/types"
import { createObjectId } from "@/lib/id"
import { fetchConversation, workspaceKeys } from "./queries"
import type { Workspace } from "./types"

export function WorkspaceChat(props: {
  orgSlug: string
  workspace: Workspace
  conversationId?: string
  headerExtra?: ReactNode
}) {
  const { orgSlug, workspace, conversationId: conversationIdFromParams } = props
  const [pendingId] = useState(
    () => conversationIdFromParams ?? createObjectId("conv"),
  )
  const conversationId = conversationIdFromParams ?? pendingId

  const detailQuery = useQuery({
    queryKey: ["conversation", orgSlug, conversationIdFromParams, workspace.id],
    enabled: Boolean(conversationIdFromParams),
    queryFn: () => {
      if (!conversationIdFromParams) throw new Error("Missing conversation id")
      return fetchConversation(orgSlug, conversationIdFromParams, workspace.id)
    },
  })

  if (conversationIdFromParams && detailQuery.isPending) {
    return (
      <ChatChrome
        workspace={workspace}
        title={<ShimmerPlaceholder className="inline-block h-4 w-40" />}
        headerExtra={props.headerExtra}
      >
        <ConversationThreadSkeleton />
      </ChatChrome>
    )
  }

  if (conversationIdFromParams) {
    const detail = detailQuery.data
    const belongsHere = detail?.conversation.workspaceId === workspace.id
    if (!detail || !belongsHere) {
      return (
        <ChatChrome
          workspace={workspace}
          title="Conversation not found"
          headerExtra={props.headerExtra}
        >
          <div className="flex min-h-0 flex-1 items-center justify-center p-8">
            <p className="max-w-sm text-sm text-muted-foreground">
              That conversation is not in this Workspace. Resume from the
              Workspace list, or start a new conversation.
            </p>
          </div>
        </ChatChrome>
      )
    }
    return (
      <WorkspaceChatSession
        key={conversationId}
        orgSlug={orgSlug}
        workspace={workspace}
        conversationId={conversationId}
        composing={false}
        title={detail.conversation.name || "New conversation"}
        initialMessages={detail.messages}
        headerExtra={props.headerExtra}
      />
    )
  }

  return (
    <WorkspaceChatSession
      key={conversationId}
      orgSlug={orgSlug}
      workspace={workspace}
      conversationId={conversationId}
      composing
      title="New conversation"
      initialMessages={[]}
      headerExtra={props.headerExtra}
    />
  )
}

function WorkspaceChatSession(props: {
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
        queryClient.setQueryData<ConversationDetail>(
          ["conversation", orgSlug, conversationId],
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
    <ChatChrome
      workspace={workspace}
      title={title}
      headerExtra={props.headerExtra}
    >
      {composing && messages.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-8">
          <div className="w-full max-w-2xl space-y-6">
            <div>
              <h1 className="text-lg font-medium tracking-tight">
                {workspace.displayName}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
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
    </ChatChrome>
  )
}

function ChatChrome(props: {
  workspace: Workspace
  title: ReactNode
  headerExtra?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="min-w-0 flex-1">
          {typeof props.title === "string" ? (
            <p className="truncate text-sm font-medium">{props.title}</p>
          ) : (
            props.title
          )}
          <p className="truncate font-mono text-xs text-muted-foreground">
            {props.workspace.workspaceRepositoryUrl}
          </p>
        </div>
        {props.workspace.readOnlyReason ? (
          <span
            title={props.workspace.readOnlyReason}
            className="shrink-0 rounded-lg border border-amber-500 bg-amber-950 px-2 py-0.5 text-xs font-medium text-amber-200"
          >
            Read-only
          </span>
        ) : null}
        {props.headerExtra}
      </header>
      {props.children}
    </div>
  )
}
