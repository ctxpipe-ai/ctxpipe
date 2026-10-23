import HyperDX from "@hyperdx/browser"
import type { StreamChunk, UIMessage } from "@tanstack/ai"
import { useChat } from "@tanstack/ai-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { ConversationThread } from "@/features/chat/ConversationThread"
import { chatDraftKey } from "@/features/chat/chat-draft"
import { MessageInputBox } from "@/features/chat/MessageInputBox"
import { reviveChatMessages } from "@/features/chat/reviveChatMessageCreatedAt"
import type {
  ChatMessage,
  ConversationDetail,
  ConversationListInfiniteData,
  ConversationListItem,
} from "@/features/chat/types"
import { createTreeFileResolver } from "@/lib/workspace-file-path"
import { ConversationSyncEntry } from "./ConversationSyncEntry"
import { ConversationTitleButton } from "./ConversationTitleButton"
import { ConversationTurnChangesCard } from "./ConversationTurnChangesCard"
import { placeThreadRecords } from "./conversationDiff"
import {
  conversationAllowsEdits,
  conversationBranchShortName,
  conversationGithubTreeHref,
} from "./conversationPublish"
import type { ParsedPane } from "./pane"
import {
  conversationGitTreeOptions,
  conversationTurnChangesOptions,
  isDefaultConversationName,
  refreshConversationAfterTurn,
  waitForConversationTitle,
  workspaceChatPrepareOptions,
  workspaceKeys,
} from "./queries"
import { scheduleFirstMessage } from "./start-workspace-conversation-ui"
import type { Workspace } from "./types"
import type { ConversationPublish } from "./useWorkspaceConversationPublish"
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

type SandboxPhase = "idle" | "starting" | "ready"

/** Null lets the thread show the current thought or "Thinking". */
export function workspaceChatWaitLabel(phase: SandboxPhase): string | null {
  return phase === "starting" ? "Setting up sandbox" : null
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
  /** Opens a tools pane, such as the Diff pane from a turn card. */
  onOpenPane?: (pane: ParsedPane) => void
  /** The page makes the publish state one time and shares it with the tools pane. */
  publish?: ConversationPublish | null
}) {
  const { orgSlug, workspace, conversationId, title, initialMessages } = props
  // A new conversation has no server row until its first turn runs.
  const [started, setStarted] = useState((initialMessages?.length ?? 0) > 0)
  const turnChanges = useQuery(
    conversationTurnChangesOptions(orgSlug, conversationId, started),
  )
  const treeQuery = useQuery(
    conversationGitTreeOptions(orgSlug, conversationId),
  )
  const treePaths = treeQuery.data?.paths
  const onOpenPane = props.onOpenPane
  // Without a known tree there is no file to link, so file links stay off.
  const fileLinks = useMemo(
    () =>
      treePaths && onOpenPane
        ? {
            resolve: createTreeFileResolver(treePaths),
            open: (path: string) => onOpenPane({ kind: "file", path }),
          }
        : undefined,
    [treePaths, onOpenPane],
  )
  const queryClient = useQueryClient()
  const [headerTitle, setHeaderTitle] = useState(title)
  const [sandboxPhase, setSandboxPhase] = useState<SandboxPhase>("idle")
  const [sendError, setSendError] = useState<Error | null>(null)
  const [draftSeed, setDraftSeed] = useState<string | null>(null)
  // The first message of a new conversation while its turn runs.
  const firstMessageRef = useRef<string | null>(null)
  // The conversation that the user renamed in this session. Its automatic
  // title can arrive later and must not replace the user's name.
  const userRenamedRef = useRef<string | null>(null)
  // Reads a title that the backend saves after the final event of a turn.
  const titleWaitRef = useRef<AbortController | null>(null)
  useEffect(() => {
    setHeaderTitle(title)
  }, [title])

  // The conversation whose transcript load from the server has ended.
  const [hydratedConversation, setHydratedConversation] = useState<
    string | null
  >(null)
  const connection = useMemo(
    () =>
      workspaceChatWebSocket(orgSlug, conversationId, {
        onHydrated: () => setHydratedConversation(conversationId),
      }),
    [orgSlug, conversationId],
  )
  const revivedInitialMessages = useMemo(
    () =>
      initialMessages && initialMessages.length > 0
        ? (reviveChatMessages(initialMessages) as UIMessage[])
        : undefined,
    [initialMessages],
  )

  // A layout effect closes the sockets before every cleanup of `useChat`.
  // The cleanup of `useChat` aborts the turn's signal, and the adapter sends an
  // abort frame on a socket that is open. Thus leaving the conversation sends
  // none, and the turn continues on the server. Only Stop sends one.
  useLayoutEffect(() => {
    connection.warm()
    return () => {
      connection.dispose()
      titleWaitRef.current?.abort()
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
  const gitStatus = props.publish?.status ?? null
  // A cached status can omit the field; derive it the way the backend does.
  const workspaceMovedUnderChanges =
    gitStatus?.workspaceMovedUnderChanges ??
    Boolean(
      gitStatus?.stale && (gitStatus.differsFromDefault || gitStatus.unpushed),
    )

  // When the first turn fails, the backend can drop the new conversation.
  // Give the text back to the composer and reload the list from the server.
  const firstSendFailed = () => {
    const text = firstMessageRef.current
    if (text === null) return
    firstMessageRef.current = null
    setDraftSeed(text)
    void queryClient.invalidateQueries({
      queryKey: workspaceKeys.conversations(orgSlug, workspace.id),
    })
  }

  const {
    messages,
    sendMessage,
    reload,
    status,
    error,
    isLoading,
    stop,
    runId,
  } = useChat({
    threadId: conversationId,
    connection,
    persistence: true,
    ...(revivedInitialMessages
      ? { initialMessages: revivedInitialMessages }
      : {}),
    forwardedProps: {
      workspaceId: workspace.id,
      source: "ui",
    },
    onError: firstSendFailed,
    onChunk: (chunk) => {
      const name = renameFromChunk(chunk)
      if (name && userRenamedRef.current !== conversationId) applyRename(name)
      const phase = sandboxPhaseFromChunk(chunk)
      if (phase) setSandboxPhase(phase)
      if (
        chunk.type === "RUN_STARTED" ||
        chunk.type === "RUN_FINISHED" ||
        chunk.type === "RUN_ERROR"
      ) {
        // The status dot of this chat in the list follows the run record.
        void queryClient.invalidateQueries({
          queryKey: workspaceKeys.conversations(orgSlug, workspace.id),
        })
      }
      if (chunk.type === "RUN_FINISHED" || chunk.type === "RUN_ERROR") {
        setSandboxPhase("idle")
        if (chunk.type === "RUN_FINISHED") firstMessageRef.current = null
        if (chunk.type === "RUN_ERROR") {
          firstSendFailed()
          const message =
            "error" in chunk && typeof chunk.error === "string"
              ? chunk.error
              : "message" in chunk && typeof chunk.message === "string"
                ? chunk.message
                : "Chat request failed."
          setSendError(new Error(message))
        }
        if (chunk.type === "RUN_FINISHED") {
          setStarted(true)
          void refreshConversationAfterTurn(
            queryClient,
            orgSlug,
            conversationId,
          )
          const named = queryClient.getQueryData<ConversationDetail>(
            workspaceKeys.conversation(orgSlug, conversationId, workspace.id),
          )?.conversation.name
          if (
            isDefaultConversationName(named) &&
            userRenamedRef.current !== conversationId
          ) {
            titleWaitRef.current?.abort()
            const wait = new AbortController()
            titleWaitRef.current = wait
            void waitForConversationTitle(
              orgSlug,
              conversationId,
              workspace.id,
              { signal: wait.signal },
            ).then((name) => {
              if (name && userRenamedRef.current !== conversationId)
                applyRename(name)
            })
          }
        }
      }
    },
  })

  const placed = useMemo(
    () =>
      placeThreadRecords(messages as ChatMessage[], {
        turns: turnChanges.data?.items ?? [],
        syncs: turnChanges.data?.syncs ?? [],
      }),
    [messages, turnChanges.data],
  )

  // Each turn sets up the sandbox before the agent thinks. The backend
  // sends "starting" after RUN_STARTED, so the label starts there at once.
  const handleSendMessage = async (params: { text: string }) => {
    setSandboxPhase("starting")
    setSendError(null)
    HyperDX.addAction("chat_question_sent")
    try {
      await sendMessage(params.text)
    } catch (error) {
      setSandboxPhase("idle")
      firstSendFailed()
      setSendError(
        error instanceof Error ? error : new Error("Failed to send message"),
      )
    }
  }

  // A turn continues on the server when its socket closes, so Stop also
  // tells the server, for a turn that this view attached to again.
  const handleStop = () => {
    if (runId) connection.stopRun(runId)
    stop()
  }

  // The last turn has the question but no answer: it stopped before the
  // first answer. A turn that still runs shows as running after the load.
  const turnStopped =
    hydratedConversation === conversationId &&
    status === "ready" &&
    !isLoading &&
    !error &&
    !sendError &&
    messages.at(-1)?.role === "user"

  const retryStoppedTurn = async () => {
    setSandboxPhase("starting")
    setSendError(null)
    try {
      await reload()
    } catch (error) {
      setSandboxPhase("idle")
      setSendError(
        error instanceof Error ? error : new Error("Failed to send message"),
      )
    }
  }

  // A new conversation's first message waits in the query cache. The
  // session takes it once and sends it on this chat, so the first turn
  // streams live.
  const sendFirstMessage = useEffectEvent((text: string) => {
    firstMessageRef.current = text
    void handleSendMessage({ text })
  })
  useEffect(
    () =>
      scheduleFirstMessage(queryClient, orgSlug, conversationId, (text) =>
        sendFirstMessage(text),
      ),
    [queryClient, orgSlug, conversationId],
  )

  return (
    <WorkspaceChatChrome
      workspace={workspace}
      hintOrgSlug={orgSlug}
      orgSlug={orgSlug}
      title={
        <ConversationTitleButton
          orgSlug={orgSlug}
          conversationId={conversationId}
          name={headerTitle}
          onRenamed={(name) => {
            userRenamedRef.current = conversationId
            applyRename(name)
          }}
        />
      }
      headerExtra={props.headerExtra}
      branch={
        prepareQuery.isSuccess && gitStatus?.branch
          ? {
              shortName: conversationBranchShortName(gitStatus.branch),
              href: gitStatus.published
                ? conversationGithubTreeHref(
                    workspace.workspaceRepositoryUrl,
                    gitStatus.branch,
                  )
                : null,
            }
          : null
      }
      cta={
        conversationAllowsEdits(
          workspace.writeStatus,
          workspace.conversationWritable,
        )
          ? (props.publish?.chrome ?? null)
          : null
      }
    >
      {prepareQuery.isError ? (
        <div className="px-6 pt-3">
          <InlineAlert variant="error" title="Workspace chat is unavailable">
            {prepareQuery.error.message}
          </InlineAlert>
        </div>
      ) : null}
      {/* A conversation with no changes moves to the new commit at its next
          turn, so it gets no notice. */}
      {workspaceMovedUnderChanges ? (
        <div className="px-6 pt-3">
          <InlineAlert variant="warning" title="The Workspace has new commits">
            Send your next message to bring this conversation up to date. Then
            you can publish.
          </InlineAlert>
        </div>
      ) : null}
      <ConversationThread
        messages={messages as ChatMessage[]}
        error={error ?? sendError}
        status={status}
        waitLabel={workspaceChatWaitLabel(sandboxPhase)}
        onRetryStoppedTurn={
          turnStopped ? () => void retryStoppedTurn() : undefined
        }
        renderAfterMessage={(messageId) => {
          const after = [
            ...(placed.turns.get(messageId)?.map((changes) => (
              <ConversationTurnChangesCard
                key={changes.runId}
                changes={changes}
                onOpenDiff={(path) =>
                  props.onOpenPane?.({
                    kind: "diff",
                    turn: changes.runId,
                    ...(path ? { path } : {}),
                  })
                }
              />
            )) ?? []),
            ...(placed.syncs
              .get(messageId)
              ?.map((sync) => (
                <ConversationSyncEntry key={sync.sha} sync={sync} />
              )) ?? []),
          ]
          return after.length > 0 ? after : null
        }}
        fileLinks={fileLinks}
      />
      <MessageInputBox
        layout="thread"
        sendMessage={handleSendMessage}
        status={status}
        onStop={handleStop}
        isDisabled={isLoading}
        draftSeed={draftSeed}
        draftKey={chatDraftKey(orgSlug, workspace.id, conversationId)}
      />
    </WorkspaceChatChrome>
  )
}
