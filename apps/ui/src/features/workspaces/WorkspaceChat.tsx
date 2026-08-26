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
import { usePendingWorkspaceCompose } from "@/features/home/pending-workspace-compose"
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
  const queryClient = useQueryClient()
  const [composeId, setComposeId] = useState(() => createObjectId("conv"))
  const [seenRouteId, setSeenRouteId] = useState(routeConversationId)

  if (routeConversationId !== seenRouteId) {
    const leavingForCompose = !routeConversationId && seenRouteId != null
    setSeenRouteId(routeConversationId)
    if (leavingForCompose) {
      setComposeId(createObjectId("conv"))
    }
  }

  const pendingCompose = usePendingWorkspaceCompose()
  if (
    pendingCompose &&
    routeConversationId === pendingCompose.conversationId &&
    workspace.id === pendingCompose.workspaceId &&
    composeId !== routeConversationId
  ) {
    setComposeId(pendingCompose.conversationId)
  }

  const isOwnCompose = !routeConversationId || routeConversationId === composeId
  const homeDraft =
    pendingCompose?.conversationId === composeId &&
    pendingCompose.workspaceId === workspace.id
      ? pendingCompose.text
      : null

  if (isOwnCompose) {
    return (
      <WorkspaceChatSession
        key={composeId}
        orgSlug={orgSlug}
        workspace={workspace}
        conversationId={composeId}
        composing={!routeConversationId}
        title="New conversation"
        initialMessages={[]}
        draftSeed={homeDraft}
        autoSendDraft={homeDraft != null}
        headerExtra={props.headerExtra}
      />
    )
  }

  const listTitle = conversationTitleFromList(
    queryClient,
    orgSlug,
    workspace.id,
    routeConversationId,
  )

  return (
    <Suspense
      fallback={
        <WorkspaceChatChrome
          workspace={workspace}
          title={listTitle ?? <Skeleton className="inline-block h-4 w-40" />}
          headerExtra={props.headerExtra}
        >
          <ConversationThreadSkeleton />
        </WorkspaceChatChrome>
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

function WorkspaceChatResume(props: {
  orgSlug: string
  workspace: Workspace
  conversationId: string
  headerExtra?: ReactNode
}) {
  const { orgSlug, workspace, conversationId } = props
  const navigate = useNavigate()
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
                    orgSlug,
                    workspaceSlug: workspace.slug,
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

  return (
      <WorkspaceChatSession
        key={conversationId}
        orgSlug={orgSlug}
        workspace={workspace}
        conversationId={conversationId}
        composing={false}
        title={detail.conversation.name || "New conversation"}
        initialMessages={detail.messages}
        conversation={detail.conversation}
        headerExtra={props.headerExtra}
      />
  )
}
