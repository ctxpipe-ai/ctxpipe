import {
  type QueryClient,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type ReactNode, useEffect, useState } from "react"

import { useSelectNav } from "@/components/ShellLayoutContext"
import { Button } from "@/components/ui/Button"
import { SkeletonSuspense, SkeletonText } from "@/components/ui/Skeleton"
import { chatColumnClassName } from "@/features/chat/chat-column"
import { chatDraftKey } from "@/features/chat/chat-draft"
import { ConversationThreadSkeleton } from "@/features/chat/components/ConversationThreadSkeleton"
import { MessageInputBox } from "@/features/chat/MessageInputBox"
import type { ConversationListInfiniteData } from "@/features/chat/types"
import { cn } from "@/lib/utils"

import { BaseBranchPicker } from "./BaseBranchPicker"
import { type ParsedPane, paneSearchForOtherConversation } from "./pane"
import {
  workspaceChatPrepareOptions,
  workspaceConversationOptions,
  workspaceKeys,
  workspaceListOptions,
} from "./queries"
import {
  newUiConversationId,
  openWorkspaceConversation,
} from "./start-workspace-conversation-ui"
import type { Workspace } from "./types"
import type { ConversationPublish } from "./useWorkspaceConversationPublish"
import { workspaceSuggestions } from "./workspace-suggestions"
import { WorkspaceChatChrome } from "./WorkspaceChatChrome"
import { WorkspaceChatSession } from "./WorkspaceChatSession"

/**
 * The chat column of a Workspace. Without a conversation id, it is the
 * composer of a new chat. With an id, it loads that conversation and continues
 * it in `WorkspaceChatSession`.
 */
export function WorkspaceChat(props: {
  orgSlug: string
  workspace: Workspace
  conversationId?: string
  headerExtra?: ReactNode
  onOpenPane?: (pane: ParsedPane) => void
  publish?: ConversationPublish | null
  /** A new value mounts a new composer, which reads its draft again. */
  composeRound?: number
}) {
  const { orgSlug, workspace, conversationId: routeConversationId } = props

  if (!routeConversationId) {
    return (
      <WorkspaceComposeChat
        key={`${workspace.id}:${props.composeRound ?? 0}`}
        orgSlug={orgSlug}
        workspace={workspace}
        headerExtra={props.headerExtra}
      />
    )
  }

  return (
    <SkeletonSuspense
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
        onOpenPane={props.onOpenPane}
        publish={props.publish}
      />
    </SkeletonSuspense>
  )
}

/** The conversation that the first message starts, and its base branch. */
type ComposeTarget = { conversationId: string; baseBranch?: string }

function WorkspaceComposeChat(props: {
  orgSlug: string
  workspace: Workspace
  headerExtra?: ReactNode
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const selectNav = useSelectNav()
  // The first message starts the conversation with this id. Opening the
  // composer (it takes focus at once) starts the sandbox prepare for it, so
  // the first turn does not wait for the sandbox. Prepare is the only work
  // that opening starts.
  // The id lives in the query cache, so a remount of this composer keeps it
  // and does not prepare a second sandbox. Send clears it.
  // The prepare records the base branch that the member picked. Until the
  // first message, a new pick prepares the same conversation again: the
  // server replaces the sandbox of the old base branch (ADR-071).
  const { orgSlug } = props
  const workspaceId = props.workspace.id
  const composeKey = [
    "workspace-compose-conversation",
    props.orgSlug,
    props.workspace.id,
  ]
  const [target, setTarget] = useState<ComposeTarget>(() => {
    const kept = queryClient.getQueryData<ComposeTarget>(composeKey)
    if (kept) return kept
    const created: ComposeTarget = { conversationId: newUiConversationId() }
    queryClient.setQueryData(composeKey, created)
    return created
  })
  // The base branch picker shows only when the org's knowledge_plane flag is
  // not off. Without it, the conversation starts from the default branch,
  // also when the member picked a branch before the flag went off. The org
  // route loads the Workspace list, so the composer reads the cached list
  // and does not fetch it again when it opens.
  const showBaseBranchPicker = useQuery({
    ...workspaceListOptions(orgSlug),
    staleTime: Number.POSITIVE_INFINITY,
    select: (list) => list.knowledgePlane !== "off",
  }).data
  const { conversationId } = target
  const baseBranch = showBaseBranchPicker ? target.baseBranch : undefined
  useEffect(() => {
    void queryClient.prefetchQuery(
      workspaceChatPrepareOptions(
        orgSlug,
        conversationId,
        workspaceId,
        baseBranch,
      ),
    )
  }, [queryClient, orgSlug, conversationId, workspaceId, baseBranch])
  return (
    <WorkspaceChatChrome
      workspace={props.workspace}
      orgSlug={orgSlug}
      title="New conversation"
      headerExtra={props.headerExtra}
    >
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10">
        <div className={cn("w-full space-y-5", chatColumnClassName)}>
          <div>
            <h1 className="text-lg font-medium tracking-tight">
              {props.workspace.displayName}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Give ctxpipe a task: find a decision, explain part of the system,
              or record a lesson. Your first message starts the conversation.
            </p>
          </div>
          <MessageInputBox
            layout="empty"
            draftKey={chatDraftKey(props.orgSlug, props.workspace.id)}
            sendMessage={({ text }) => {
              queryClient.removeQueries({ queryKey: composeKey, exact: true })
              openWorkspaceConversation({
                queryClient,
                navigate,
                selectNav,
                orgSlug: props.orgSlug,
                workspace: props.workspace,
                text,
                conversationId,
                baseBranch,
              })
            }}
            tools={
              showBaseBranchPicker ? (
                <BaseBranchPicker
                  orgSlug={orgSlug}
                  workspaceSlug={props.workspace.slug}
                  defaultBranch={props.workspace.defaultBranch}
                  value={baseBranch}
                  onChange={(branch) => {
                    if (branch === baseBranch) return
                    const next: ComposeTarget = {
                      conversationId,
                      baseBranch: branch,
                    }
                    queryClient.setQueryData(composeKey, next)
                    setTarget(next)
                    // A prepare that still runs would answer this fetch too:
                    // cancel it, so the new base branch reaches the server.
                    const prepare = workspaceChatPrepareOptions(
                      orgSlug,
                      conversationId,
                      workspaceId,
                      branch,
                    )
                    void queryClient
                      .cancelQueries({ queryKey: prepare.queryKey })
                      .then(() =>
                        queryClient.fetchQuery({ ...prepare, staleTime: 0 }),
                      )
                  }}
                />
              ) : undefined
            }
            placeholder="What should ctxpipe do in this Workspace?"
            suggestions={workspaceSuggestions}
          />
        </div>
      </div>
    </WorkspaceChatChrome>
  )
}

/** The name of a conversation in the cached conversation list, if loaded. */
export function conversationTitleFromList(
  queryClient: QueryClient,
  orgSlug: string,
  workspaceId: string,
  conversationId: string,
) {
  const cached = queryClient.getQueryData<ConversationListInfiniteData>(
    workspaceKeys.conversations(orgSlug, workspaceId),
  )
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
      title={
        listTitle ?? <SkeletonText className="w-40" boneClassName="w-full" />
      }
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
                search: (prev) => paneSearchForOtherConversation(prev),
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
  onOpenPane?: (pane: ParsedPane) => void
  publish?: ConversationPublish | null
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
      title={detail.conversation.name || "New conversation"}
      conversation={detail.conversation}
      initialMessages={detail.messages}
      headerExtra={props.headerExtra}
      onOpenPane={props.onOpenPane}
      publish={props.publish}
    />
  )
}
