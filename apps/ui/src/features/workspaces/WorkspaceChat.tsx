import { useSuspenseQuery } from "@tanstack/react-query"
import { type ReactNode, Suspense, useState } from "react"
import { Skeleton } from "@/components/ui/Skeleton"
import { ConversationThreadSkeleton } from "@/features/chat/components/ConversationThreadSkeleton"
import { createObjectId } from "@/lib/id"
import { workspaceConversationOptions } from "./queries"
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

  if (conversationIdFromParams) {
    return (
      <Suspense
        fallback={
          <WorkspaceChatChrome
            workspace={workspace}
            title={<Skeleton className="inline-block h-4 w-40" />}
            headerExtra={props.headerExtra}
          >
            <ConversationThreadSkeleton />
          </WorkspaceChatChrome>
        }
      >
        <WorkspaceChatResume
          orgSlug={orgSlug}
          workspace={workspace}
          conversationId={conversationIdFromParams}
          headerExtra={props.headerExtra}
        />
      </Suspense>
    )
  }

  return <WorkspaceChatCompose {...props} />
}

function WorkspaceChatCompose(props: {
  orgSlug: string
  workspace: Workspace
  headerExtra?: ReactNode
}) {
  const [pendingId] = useState(() => createObjectId("conv"))
  return (
    <WorkspaceChatSession
      key={pendingId}
      orgSlug={props.orgSlug}
      workspace={props.workspace}
      conversationId={pendingId}
      composing
      title="New conversation"
      initialMessages={[]}
      headerExtra={props.headerExtra}
    />
  )
}

function WorkspaceChatResume(props: {
  orgSlug: string
  workspace: Workspace
  conversationId: string
  headerExtra?: ReactNode
}) {
  const { orgSlug, workspace, conversationId } = props
  const { data: detail } = useSuspenseQuery(
    workspaceConversationOptions(orgSlug, conversationId, workspace.id),
  )

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
