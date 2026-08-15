import { useChat } from "@ai-sdk/react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type ReactNode, useMemo, useRef, useState } from "react"
import { ShimmerPlaceholder } from "@/components/ui/ShimmerPlaceholder"
import { ConversationThread } from "@/features/chat/ConversationThread"
import { createTransport } from "@/features/chat/chatTransport"
import { ConversationThreadSkeleton } from "@/features/chat/components/ConversationThreadSkeleton"
import { MessageInputBox } from "@/features/chat/MessageInputBox"
import type { ConversationDetail } from "@/features/chat/types"
import { client } from "@/lib/api"
import { createObjectId } from "@/lib/id"
import { workspaceKeys } from "./queries"
import type { Workspace } from "./types"

export function WorkspaceChat(props: {
  orgSlug: string
  workspace: Workspace
  conversationId?: string
  headerExtra?: ReactNode
}) {
  const { orgSlug, workspace, conversationId: conversationIdFromParams } = props
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [pendingId] = useState(
    () => conversationIdFromParams ?? createObjectId("conv"),
  )
  const conversationId = conversationIdFromParams ?? pendingId
  const composing = conversationIdFromParams === undefined
  const sendFailedRef = useRef(false)

  const detailQuery = useQuery({
    queryKey: ["conversation", orgSlug, conversationIdFromParams],
    enabled: Boolean(conversationIdFromParams),
    queryFn: async () => {
      if (!conversationIdFromParams) throw new Error("Missing conversation id")
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
    () =>
      createTransport({
        orgSlug,
        conversationId,
        workspaceId: workspace.id,
      }),
    [orgSlug, conversationId, workspace.id],
  )

  const initialMessages =
    conversationIdFromParams && detailQuery.data
      ? detailQuery.data.messages
      : []

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

  const title = composing
    ? "New conversation"
    : (detailQuery.data?.conversation.name ?? "New conversation")

  const handleSendMessage = async (params: { text: string }) => {
    sendFailedRef.current = false
    try {
      await sendMessage(params)
    } catch {
      return
    }
    if (sendFailedRef.current) return
    void queryClient.invalidateQueries({
      queryKey: workspaceKeys.conversations(orgSlug, workspace.id),
    })
    void queryClient.invalidateQueries({
      queryKey: workspaceKeys.list(orgSlug),
    })
    if (composing) {
      void navigate({
        to: "/$orgSlug/ws/$workspaceSlug/$conversationId",
        params: {
          orgSlug,
          workspaceSlug: workspace.slug,
          conversationId,
        },
      })
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="min-w-0 flex-1">
          {conversationIdFromParams && detailQuery.isLoading ? (
            <ShimmerPlaceholder className="inline-block h-4 w-40" />
          ) : (
            <p className="truncate text-sm font-medium">{title}</p>
          )}
          <p className="truncate font-mono text-xs text-muted-foreground">
            {workspace.workspaceRepositoryUrl}
          </p>
        </div>
        {workspace.readOnlyReason ? (
          <span
            title={workspace.readOnlyReason}
            className="shrink-0 rounded-lg border border-amber-500 bg-amber-950 px-2 py-0.5 text-xs font-medium text-amber-200"
          >
            Read-only
          </span>
        ) : null}
        {props.headerExtra}
      </header>
      {conversationIdFromParams &&
      detailQuery.isLoading &&
      messages.length === 0 ? (
        <ConversationThreadSkeleton />
      ) : composing && messages.length === 0 ? (
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
    </div>
  )
}
