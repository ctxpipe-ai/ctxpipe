import type { StreamChunk, UIMessage } from "@tanstack/ai"
import { useChat } from "@tanstack/ai-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { ConversationThread } from "@/features/chat/ConversationThread"
import { MessageInputBox } from "@/features/chat/MessageInputBox"
import type {
  ChatMessage,
  ConversationDetail,
  ConversationListInfiniteData,
  ConversationListItem,
} from "@/features/chat/types"
import {
  conversationAllowsEdits,
  conversationBranchShortName,
  conversationGithubTreeHref,
} from "./conversationPublish"
import { workspaceChatPrepareOptions, workspaceKeys } from "./queries"
import type { Workspace } from "./types"
import { useConversationPublish } from "./useConversationPublish"
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
  title: string
  initialMessages?: ConversationDetail["messages"]
  conversation?: ConversationListItem
  headerExtra?: ReactNode
}) {
  const { orgSlug, workspace, conversationId, title, initialMessages } = props
  const queryClient = useQueryClient()
  const [headerTitle, setHeaderTitle] = useState(title)
  const [sandboxPhase, setSandboxPhase] = useState<SandboxPhase>("idle")
  useEffect(() => {
    setHeaderTitle(title)
  }, [title])

  const connection = useMemo(
    () => workspaceChatWebSocket(orgSlug, conversationId),
    [orgSlug, conversationId],
  )

  useEffect(() => {
    connection.warm()
    return () => {
      connection.dispose()
    }
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
  const publish = useConversationPublish({
    orgSlug,
    conversationId,
    workspaceId: workspace.id,
    title: headerTitle,
    statusEnabled: prepareQuery.isSuccess,
    pullEnabled: (props.conversation?.lastChatPrNumber ?? null) != null,
    fallbackPrState: props.conversation?.prState,
    fallbackPullUrl: props.conversation?.lastChatPrUrl,
  })
  const gitStatus = publish.status

  const { messages, sendMessage, status, error, isLoading, stop } = useChat({
    threadId: conversationId,
    connection,
    persistence: true,
    ...(initialMessages && initialMessages.length > 0
      ? { initialMessages: initialMessages as UIMessage[] }
      : {}),
    forwardedProps: {
      workspaceId: workspace.id,
      source: "ui",
    },
    onChunk: (chunk) => {
      const name = renameFromChunk(chunk)
      if (name) applyRename(name)
      const phase = sandboxPhaseFromChunk(chunk)
      if (phase) setSandboxPhase(phase)
      if (chunk.type === "RUN_FINISHED" || chunk.type === "RUN_ERROR") {
        setSandboxPhase("idle")
        if (chunk.type === "RUN_FINISHED") {
          void queryClient.invalidateQueries({
            queryKey: workspaceKeys.conversationGitTree(
              orgSlug,
              conversationId,
            ),
          })
          void queryClient.invalidateQueries({
            queryKey: workspaceKeys.conversationGitStatus(
              orgSlug,
              conversationId,
            ),
          })
        }
      }
    },
  })

  const handleSendMessage = async (params: { text: string }) => {
    setSandboxPhase("idle")
    try {
      await sendMessage(params.text)
    } catch {
      setSandboxPhase("idle")
    }
  }

  return (
    <WorkspaceChatChrome
      workspace={workspace}
      title={headerTitle}
      headerExtra={props.headerExtra}
      branch={
        prepareQuery.isSuccess && gitStatus?.branch
          ? {
              shortName: conversationBranchShortName(gitStatus.branch),
              fullRef: gitStatus.branch,
              href: gitStatus.published
                ? conversationGithubTreeHref(
                    workspace.workspaceRepositoryUrl,
                    gitStatus.branch,
                  )
                : null,
            }
          : null
      }
      publish={
        conversationAllowsEdits(
          workspace.writeStatus,
          workspace.conversationWritable,
        )
          ? publish.chrome
          : null
      }
    >
      {gitStatus?.stale ? (
        <InlineAlert variant="warning" title="Branch needs a rebase">
          This conversation is on {gitStatus.sha?.slice(0, 7)}; the workspace is
          now {gitStatus.desiredSha?.slice(0, 7)}. Continue chatting to resolve
          the conflict before publishing.
        </InlineAlert>
      ) : null}
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
      />
    </WorkspaceChatChrome>
  )
}
