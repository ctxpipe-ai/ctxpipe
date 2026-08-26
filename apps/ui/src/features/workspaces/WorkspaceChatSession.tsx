import type { StreamChunk, UIMessage } from "@tanstack/ai"
import { useChat } from "@tanstack/ai-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { ConversationThread } from "@/features/chat/ConversationThread"
import { insertConversationListItem } from "@/features/chat/insertConversationListItem"
import { MessageInputBox } from "@/features/chat/MessageInputBox"
import type {
  ChatMessage,
  ConversationDetail,
  ConversationListInfiniteData,
  ConversationListItem,
} from "@/features/chat/types"
import {
  setPendingWorkspaceCompose,
  takeHomeDraftSend,
} from "@/features/home/pending-workspace-compose"
import { conversationWriteToolSignature } from "./conversationFileLive"
import {
  conversationBranchShortName,
  conversationCommitPushEnabled,
  conversationGithubTreeHref,
  conversationPullRequestAction,
  conversationSessionBranch,
} from "./conversationPublish"
import {
  conversationGitStatusOptions,
  conversationPullRequestOptions,
  createConversationPullRequest,
  pushConversationBranch,
  workspaceChatPrepareOptions,
  workspaceKeys,
} from "./queries"
import type { Workspace } from "./types"
import { WorkspaceChatChrome } from "./WorkspaceChatChrome"
import { workspaceChatWebSocket } from "./workspaceChatWebSocket"

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

export type SandboxPhase = "idle" | "starting" | "ready"

export function workspaceChatWaitLabel(phase: SandboxPhase) {
  return phase === "starting" ? "Setting up sandbox" : "Thinking…"
}

export function sandboxPhaseFromChunk(chunk: StreamChunk): SandboxPhase | null {
  if (chunk.type !== "CUSTOM") return null
  if (!("name" in chunk) || chunk.name !== "sandbox-setup") return null
  const value = "value" in chunk ? chunk.value : null
  if (
    value &&
    typeof value === "object" &&
    "phase" in value &&
    (value.phase === "starting" || value.phase === "ready")
  ) {
    return value.phase
  }
  return null
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
  draftSeed?: string | null
  autoSendDraft?: boolean
  conversation?: ConversationListItem
  headerExtra?: ReactNode
}) {
  const {
    orgSlug,
    workspace,
    conversationId,
    composing,
    title,
    initialMessages,
    draftSeed,
    autoSendDraft,
  } = props
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const sendFailedRef = useRef(false)
  const committedRef = useRef(false)
  const [headerTitle, setHeaderTitle] = useState(title)
  const [seenTitle, setSeenTitle] = useState(title)
  const [sandboxPhase, setSandboxPhase] = useState<SandboxPhase>("idle")
  const [phaseConversationId, setPhaseConversationId] = useState(conversationId)
  const [draftConsumed, setDraftConsumed] = useState(false)
  const activeDraft = draftConsumed ? null : (draftSeed ?? null)
  if (title !== seenTitle) {
    setSeenTitle(title)
    setHeaderTitle(title)
  }
  if (conversationId !== phaseConversationId) {
    setPhaseConversationId(conversationId)
    setSandboxPhase("idle")
    setDraftConsumed(false)
  }

  const connection = useMemo(
    () => workspaceChatWebSocket(orgSlug, conversationId),
    [orgSlug, conversationId],
  )

  useEffect(() => {
    connection.warm()
  }, [connection])

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

  const prepareQuery = useQuery(
    workspaceChatPrepareOptions(orgSlug, conversationId, workspace.id),
  )
  const statusQuery = useQuery({
    ...conversationGitStatusOptions(orgSlug, conversationId),
    enabled: !composing && prepareQuery.isSuccess,
  })
  const pullQuery = useQuery(
    conversationPullRequestOptions(
      orgSlug,
      conversationId,
      !composing && (props.conversation?.lastChatPrNumber ?? null) != null,
    ),
  )
  const pushMutation = useMutation({
    mutationFn: () => pushConversationBranch(orgSlug, conversationId),
    onSuccess: (result) => {
      queryClient.setQueryData<ConversationDetail>(
        workspaceKeys.conversation(orgSlug, conversationId, workspace.id),
        (old) =>
          old
            ? {
                ...old,
                conversation: {
                  ...old.conversation,
                  lastBranch: result.branch,
                  branchTreeUrl: result.treeUrl,
                },
              }
            : old,
      )
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.conversationGitStatus(orgSlug, conversationId),
      })
    },
  })
  const createPrMutation = useMutation({
    mutationFn: () =>
      createConversationPullRequest(orgSlug, conversationId, {
        title: headerTitle,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData<ConversationDetail>(
        workspaceKeys.conversation(orgSlug, conversationId, workspace.id),
        (old) =>
          old
            ? {
                ...old,
                conversation: {
                  ...old.conversation,
                  lastBranch: result.branch,
                  lastChatPrNumber: result.prNumber,
                  lastChatPrUrl: result.pullUrl,
                  prState: result.prState,
                },
              }
            : old,
      )
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.conversationPullRequest(orgSlug, conversationId),
      })
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.conversationGitStatus(orgSlug, conversationId),
      })
    },
  })

  const { messages, sendMessage, status, error, isLoading, stop } = useChat({
    threadId: conversationId,
    connection,
    persistence: true,
    initialMessages: initialMessages as UIMessage[],
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
      const phase = sandboxPhaseFromChunk(chunk)
      if (phase) setSandboxPhase(phase)
      if (chunk.type === "TOOL_CALL" || chunk.type === "TOOL_CALL_DELTA") {
        void queryClient.invalidateQueries({
          queryKey: workspaceKeys.conversationGitStatus(orgSlug, conversationId),
        })
        void queryClient.invalidateQueries({
          queryKey: workspaceKeys.conversationGitTree(orgSlug, conversationId),
        })
      }
      if (chunk.type === "RUN_FINISHED" || chunk.type === "RUN_ERROR") {
        setSandboxPhase("idle")
        if (chunk.type === "RUN_FINISHED") {
          void queryClient.invalidateQueries({
            queryKey: workspaceKeys.conversations(orgSlug, workspace.id),
          })
          void queryClient.invalidateQueries({
            queryKey: workspaceKeys.list(orgSlug),
          })
        }
      }
    },
    onFinish: () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.conversations(orgSlug, workspace.id),
      })
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.conversationGitStatus(orgSlug, conversationId),
      })
    },
  })

  const writeSignature = conversationWriteToolSignature(
    messages as ChatMessage[],
  )
  useEffect(() => {
    if (!writeSignature) return
    void queryClient.invalidateQueries({
      queryKey: workspaceKeys.conversationGitStatus(orgSlug, conversationId),
    })
    void queryClient.invalidateQueries({
      queryKey: workspaceKeys.conversationGitTree(orgSlug, conversationId),
    })
    for (const path of writeSignature.split("\0").filter(Boolean)) {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.conversationGitBlob(
          orgSlug,
          conversationId,
          path,
        ),
      })
    }
  }, [conversationId, orgSlug, queryClient, writeSignature])

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

  const sendMessageRef = useRef<(params: { text: string }) => Promise<void>>(
    async () => undefined,
  )

  const handleSendMessage = async (params: { text: string }) => {
    setDraftConsumed(true)
    sendFailedRef.current = false
    setSandboxPhase("idle")
    try {
      await sendMessage(params.text)
    } catch {
      setSandboxPhase("idle")
      return
    }
    if (sendFailedRef.current) {
      setSandboxPhase("idle")
      return
    }
    setPendingWorkspaceCompose(null)
    insertComposeRow()
    commitComposeRoute()
  }
  sendMessageRef.current = handleSendMessage

  useEffect(() => {
    if (!autoSendDraft || !draftSeed?.trim()) return
    if (!takeHomeDraftSend(conversationId)) {
      setDraftConsumed(true)
      return
    }
    setDraftConsumed(true)
    void sendMessageRef.current({ text: draftSeed })
  }, [autoSendDraft, conversationId, draftSeed])

  return (
    <WorkspaceChatChrome
      workspace={workspace}
      title={headerTitle}
      headerExtra={props.headerExtra}
      branch={
        !composing && prepareQuery.isSuccess
          ? {
              shortName: conversationBranchShortName(
                props.conversation?.lastBranch ??
                  conversationSessionBranch(conversationId),
              ),
              fullRef:
                props.conversation?.lastBranch ??
                conversationSessionBranch(conversationId),
              href: statusQuery.data?.published
                ? (props.conversation?.branchTreeUrl ??
                    conversationGithubTreeHref(
                      workspace.workspaceRepositoryUrl,
                      props.conversation?.lastBranch ??
                        conversationSessionBranch(conversationId),
                    ))
                : null,
            }
          : null
      }
      publish={
        !composing &&
        prepareQuery.isSuccess &&
        workspace.writeStatus === "writable"
          ? {
              commitPush: {
                enabled: conversationCommitPushEnabled(
                  statusQuery.data ?? null,
                ),
                pending: pushMutation.isPending,
                onPress: () => pushMutation.mutate(),
              },
              pullRequest: {
                action: conversationPullRequestAction(
                  pullQuery.data?.prState ?? props.conversation?.prState,
                ),
                pending: createPrMutation.isPending,
                href:
                  pullQuery.data?.pullUrl ??
                  props.conversation?.lastChatPrUrl ??
                  null,
                onPress: () => createPrMutation.mutate(),
              },
            }
          : null
      }
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
              isDisabled={isLoading}
              placeholder="Ask about this Workspace…"
              draftSeed={activeDraft}
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
            waitLabel={workspaceChatWaitLabel(sandboxPhase)}
          />
          <MessageInputBox
            layout="thread"
            sendMessage={handleSendMessage}
            status={status}
            onStop={stop}
            isDisabled={isLoading}
            draftSeed={activeDraft}
          />
        </>
      )}
    </WorkspaceChatChrome>
  )
}
