import { useQuery } from "@tanstack/react-query"
import { type ReactNode, useState } from "react"
import { ShimmerPlaceholder } from "@/components/ui/ShimmerPlaceholder"
import { ConversationThreadSkeleton } from "@/features/chat/components/ConversationThreadSkeleton"
import { createObjectId } from "@/lib/id"
import { fetchConversation, workspaceKeys } from "./queries"
import type { Workspace } from "./types"
import { WorkspaceChatChrome } from "./WorkspaceChatChrome"
import { WorkspaceChatSession } from "./WorkspaceChatSession"

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
    queryKey: conversationIdFromParams
      ? workspaceKeys.conversation(
          orgSlug,
          conversationIdFromParams,
          workspace.id,
        )
      : ["conversation", orgSlug, "pending", workspace.id],
    enabled: Boolean(conversationIdFromParams),
    queryFn: () => {
      if (!conversationIdFromParams) throw new Error("Missing conversation id")
      return fetchConversation(orgSlug, conversationIdFromParams, workspace.id)
    },
  })

  if (conversationIdFromParams && detailQuery.isPending) {
    return (
      <WorkspaceChatChrome
        workspace={workspace}
        title={<ShimmerPlaceholder className="inline-block h-4 w-40" />}
        headerExtra={props.headerExtra}
      >
        <ConversationThreadSkeleton />
      </WorkspaceChatChrome>
    )
  }

  if (conversationIdFromParams) {
    const detail = detailQuery.data
    const belongsHere = detail?.conversation.workspaceId === workspace.id
    if (!detail || !belongsHere) {
      return (
        <WorkspaceChatChrome
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
        </WorkspaceChatChrome>
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
