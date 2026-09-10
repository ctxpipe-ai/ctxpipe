import {
  type QueryClient,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type ReactNode, Suspense, useState } from "react"
import { Button } from "@/components/ui/Button"
import { Skeleton } from "@/components/ui/Skeleton"
import { ConversationThreadSkeleton } from "@/features/chat/components/ConversationThreadSkeleton"
import { createObjectId } from "@/lib/id"
import { workspaceConversationOptions, workspaceKeys } from "./queries"
import type { Workspace } from "./types"
import { WorkspaceChatChrome } from "./WorkspaceChatChrome"
import { WorkspaceChatSession } from "./WorkspaceChatSession"

export function WorkspaceChat(props: {
  orgSlug: string
  workspace: Workspace
  conversationId?: string
  headerExtra?: ReactNode
}) {
  const { orgSlug, workspace, conversationId: routeConversationId } = props

  if (!routeConversationId) {
    return (
      <WorkspaceComposeChat
        key={workspace.id}
        orgSlug={orgSlug}
        workspace={workspace}
        headerExtra={props.headerExtra}
      />
    )
  }

  return (
    <Suspense
      fallback={
        <WorkspaceChatResumeFallback
          orgSlug={orgSlug}
          workspace={workspace}
          conversationId={routeConversationId}
          headerExtra={props.headerExtra}
        />
      }
    >
      <WorkspaceChatResume
        orgSlug={orgSlug}
        workspace={workspace}
        conversationId={routeConversationId}
        headerExtra={props.headerExtra}
      />
    </Suspense>
  )
}

function WorkspaceComposeChat(props: {
  orgSlug: string
  workspace: Workspace
  headerExtra?: ReactNode
}) {
  const [conversationId] = useState(() => createObjectId("conv"))
  return (
    <WorkspaceChatSession
      orgSlug={props.orgSlug}
      workspace={props.workspace}
      conversationId={conversationId}
      composing
      title="New conversation"
      headerExtra={props.headerExtra}
    />
  )
}

function conversationTitleFromList(
  queryClient: QueryClient,
  orgSlug: string,
  workspaceId: string,
  conversationId: string,
) {
  const cached = queryClient.getQueryData<{
    pages: { items: { id: string; name: string }[] }[]
  }>(workspaceKeys.conversations(orgSlug, workspaceId))
  return cached?.pages
    .flatMap((page) => page.items)
    .find((item) => item.id === conversationId)?.name
}

function WorkspaceChatResumeFallback(props: {
  orgSlug: string
  workspace: Workspace
  conversationId: string
  headerExtra?: ReactNode
}) {
  const queryClient = useQueryClient()
  const listTitle = conversationTitleFromList(
    queryClient,
    props.orgSlug,
    props.workspace.id,
    props.conversationId,
  )
  return (
    <WorkspaceChatChrome
      workspace={props.workspace}
      title={listTitle ?? <Skeleton className="inline-block h-4 w-40" />}
      headerExtra={props.headerExtra}
    >
      <ConversationThreadSkeleton />
    </WorkspaceChatChrome>
  )
}

function ConversationNotFound(props: {
  workspace: Workspace
  orgSlug: string
  headerExtra?: ReactNode
}) {
  const navigate = useNavigate()
  return (
    <WorkspaceChatChrome
      workspace={props.workspace}
      title="Conversation not found"
      headerExtra={props.headerExtra}
    >
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
        <div className="w-full max-w-sm space-y-5">
          <div>
            <h1 className="text-lg font-medium tracking-tight">
              Conversation not found
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              That conversation is not in this Workspace. Start a new one.
            </p>
          </div>
          <Button
            variant="primary"
            onPress={() => {
              void navigate({
                to: "/$orgSlug/ws/$workspaceSlug",
                params: {
                  orgSlug: props.orgSlug,
                  workspaceSlug: props.workspace.slug,
                },
                search: (prev) => prev,
              })
            }}
          >
            New conversation
          </Button>
        </div>
      </div>
    </WorkspaceChatChrome>
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

  if (!detail || detail.conversation.workspaceId !== workspace.id) {
    return (
      <ConversationNotFound
        orgSlug={orgSlug}
        workspace={workspace}
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
      composing={false}
      title={detail.conversation.name || "New conversation"}
      conversation={detail.conversation}
      initialMessages={detail.messages}
      headerExtra={props.headerExtra}
    />
  )
}
