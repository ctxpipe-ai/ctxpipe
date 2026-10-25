import { IconBrain, IconFile, IconSearch, IconTool } from "@tabler/icons-react"
import {
  Fragment,
  type ReactElement,
  type ReactNode,
  useId,
  useState,
} from "react"
import { Button as AriaButton } from "react-aria-components"
import { useStickToBottomContext } from "use-stick-to-bottom"
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  type AnswerFileLinks,
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import {
  type ActivityChipKind,
  type ActivityEntry,
  activityChips,
  activityLog,
  groupAssistantTurns,
  toolBucketCounts,
} from "@/features/chat/conversation-thread-utils"
import type { ChatMessage, ChatStatus } from "@/features/chat/types"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import { chatColumnClassName, chatUserBubbleClassName } from "./chat-column"

const HIDDEN_DATA_PARTS = new Set(["data-rename-conversation", "data-kg-focus"])

type ChatPart = ChatMessage["parts"][number]

function partText(part: ChatPart): string {
  return (part.content ?? part.text ?? "").trim()
}

function chipIcon(kind: ActivityChipKind) {
  if (kind === "read") return <IconFile className="size-4" aria-hidden />
  if (kind === "search") return <IconSearch className="size-4" aria-hidden />
  if (kind === "thought") return <IconBrain className="size-4" aria-hidden />
  return <IconTool className="size-4" aria-hidden />
}

function isActivityMessagePart(part: ChatPart) {
  if (part.type === "tool-call") return true
  if (part.type === "thinking") return Boolean(partText(part))
  return false
}

function isRenderableMessagePart(part: ChatPart) {
  if (HIDDEN_DATA_PARTS.has(part.type) || part.type.startsWith("data-")) {
    return false
  }
  if (part.type === "text" || part.type === "thinking") {
    return Boolean(partText(part))
  }
  if (part.type === "source-url" || part.type === "tool-call") return true
  return false
}

function IconSlot(props: { children: ReactElement }) {
  return (
    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-zinc-500">
      {props.children}
    </span>
  )
}

const reasoningResponseClassName =
  "ctx-streamdown-reasoning h-auto space-y-1 text-xs leading-relaxed text-muted-foreground [&_blockquote]:text-muted-foreground [&_h1]:text-muted-foreground [&_h2]:text-muted-foreground [&_h3]:text-muted-foreground [&_h4]:text-muted-foreground [&_li]:text-muted-foreground [&_ol]:text-muted-foreground [&_p]:text-muted-foreground [&_strong]:text-muted-foreground [&_ul]:text-muted-foreground"

/**
 * The one live line of a working turn: the current thought's title, else a
 * real system state such as "Setting up sandbox", else "Thinking".
 */
function StatusLine(props: { label: string }) {
  return (
    <div
      className="flex w-full min-w-0 items-start gap-2"
      role="status"
      aria-label={props.label}
    >
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        <span className="ctx-indexing-dot" aria-hidden />
      </span>
      <p className="line-clamp-1 min-w-0 flex-1 text-xs font-medium leading-relaxed text-muted-foreground">
        {props.label}
      </p>
    </div>
  )
}

function LogEntry(props: { entry: ActivityEntry }) {
  const { entry } = props
  if (entry.kind === "thought") {
    const { thought } = entry
    return (
      <li className="flex min-w-0 items-start gap-2">
        <IconSlot>{chipIcon("thought")}</IconSlot>
        <div className="min-w-0 flex-1 space-y-1">
          {thought.hasHeading ? (
            <p className="font-medium text-muted-foreground">{thought.title}</p>
          ) : null}
          {thought.body ? (
            <MessageResponse className={reasoningResponseClassName}>
              {thought.body}
            </MessageResponse>
          ) : null}
        </div>
      </li>
    )
  }
  const { tool } = entry
  return (
    <li className="flex min-w-0 items-start gap-2">
      <IconSlot>{chipIcon(tool.bucket)}</IconSlot>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
        <span className="font-medium text-muted-foreground">{tool.action}</span>
        {tool.detail ? (
          <span className="min-w-0 break-all font-mono text-muted-foreground/80">
            {tool.detail}
          </span>
        ) : null}
      </span>
    </li>
  )
}

/**
 * The counters line. It opens the log of every thought and tool call. The
 * status line comes after it, at the same gap as the log items.
 */
function ActivityLog(props: { entries: ActivityEntry[]; status: ReactNode }) {
  const { entries } = props
  const [expanded, setExpanded] = useState(false)
  const logId = useId()
  // The open log makes the thread taller. Stop the stick to the bottom, so
  // the thread does not scroll away from the counters.
  const { stopScroll } = useStickToBottomContext()
  const tools = entries.flatMap((entry) =>
    entry.kind === "tool" ? [entry.tool] : [],
  )
  const chips = activityChips({
    ...toolBucketCounts(tools),
    thoughts: entries.length - tools.length,
  })

  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <AriaButton
        aria-expanded={expanded}
        aria-controls={expanded ? logId : undefined}
        aria-label={chips.map((chip) => chip.label).join(", ")}
        onPress={() => {
          if (!expanded) stopScroll()
          setExpanded(!expanded)
        }}
        className={cn(
          focusVisibleClassName,
          "flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md text-left text-xs leading-relaxed text-muted-foreground",
          "hover:text-foreground/80",
        )}
      >
        {chips.map((chip) => (
          <span
            key={chip.kind}
            className="inline-flex min-w-0 items-center gap-1.5"
          >
            <IconSlot>{chipIcon(chip.kind)}</IconSlot>
            <span className="tabular-nums">{chip.label}</span>
          </span>
        ))}
      </AriaButton>
      {expanded ? (
        <section
          id={logId}
          aria-label="Activity log"
          className="min-w-0 text-xs leading-relaxed text-muted-foreground"
        >
          <ol className="flex min-w-0 flex-col gap-2">
            {entries.map((entry) => (
              <LogEntry key={entry.key} entry={entry} />
            ))}
          </ol>
        </section>
      ) : null}
      {props.status}
    </div>
  )
}

function renderUserParts(message: ChatMessage): ReactElement[] {
  return message.parts.flatMap((part, index) => {
    if (part.type !== "text" || !partText(part)) return []
    return [
      // Plain text: the user's words show as typed. Markdown would block
      // a relative link and show "[blocked]".
      <p
        key={`${message.id}-${index}`}
        className="whitespace-pre-wrap break-words text-sm leading-relaxed"
      >
        {partText(part)}
      </p>,
    ]
  })
}

function renderAssistantParts(
  message: ChatMessage,
  options: {
    working: boolean
    systemStatus: string | null
    fileLinks?: AnswerFileLinks
  },
): ReactElement[] {
  const entries = activityLog(message.parts)
  const replyParts = message.parts.filter(
    (part) =>
      (part.type === "text" && Boolean(partText(part))) ||
      part.type === "source-url",
  )
  // The status line stays until the run ends, also while text streams.
  const thoughts = entries.flatMap((entry) =>
    entry.kind === "thought" ? [entry.thought] : [],
  )
  const status =
    options.working && entries.length > 0 ? (
      <StatusLine
        key={`${message.id}-status`}
        label={thoughts.at(-1)?.title ?? options.systemStatus ?? "Thinking"}
      />
    ) : null
  const statusAfterReply = replyParts.length > 0
  const nodes: ReactElement[] = []
  if (entries.length > 0) {
    nodes.push(
      <ActivityLog
        key={`${message.id}-activity`}
        entries={entries}
        status={statusAfterReply ? null : status}
      />,
    )
  }
  replyParts.forEach((part, index) => {
    const key = `${message.id}-reply-${index}`
    if (part.type === "text") {
      nodes.push(
        <MessageResponse
          key={key}
          isAnimating={options.working}
          fileLinks={options.fileLinks}
        >
          {partText(part)}
        </MessageResponse>,
      )
      return
    }
    nodes.push(
      <p key={key} className="text-xs text-muted-foreground">
        Source:{" "}
        <a
          className="text-teal-400 underline"
          href={part.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {part.title ?? part.url}
        </a>
      </p>,
    )
  })
  if (status && statusAfterReply) nodes.push(status)
  return nodes
}

function messageHasVisibleActivity(message: ChatMessage) {
  return message.parts.some(
    (part) => isRenderableMessagePart(part) || isActivityMessagePart(part),
  )
}

export function ConversationThread(props: {
  messages: ChatMessage[]
  error: Error | null
  status?: ChatStatus
  /** A real system state, such as "Setting up sandbox"; null shows "Thinking" or the current thought. */
  waitLabel?: string | null
  contentClassName?: string
  /**
   * Content after the shown message with this id, when the message is not
   * live (for example, the files a turn changed).
   */
  renderAfterMessage?: (messageId: string) => ReactNode
  /**
   * Turns file paths in an answer into buttons that open the file. Only a path
   * that `resolve` finds in the git tree becomes a button. Keep it stable.
   */
  fileLinks?: AnswerFileLinks
  /**
   * Set when the last turn stopped before its first answer. The thread then
   * shows that the turn stopped, with a Retry action.
   */
  onRetryStoppedTurn?: () => void
}) {
  const { messages, error, status, waitLabel, contentClassName } = props
  const turns = groupAssistantTurns(messages)
  const lastMessage = turns[turns.length - 1]
  const lastAssistantHasVisibleActivity =
    lastMessage?.role === "assistant"
      ? messageHasVisibleActivity(lastMessage)
      : false
  const running = status === "submitted" || status === "streaming"
  const showPulsatingLoader = running && !lastAssistantHasVisibleActivity

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Conversation className="min-h-0 flex-1">
          <ConversationContent
            className={cn(
              "mx-auto gap-6 p-5",
              chatColumnClassName,
              contentClassName,
            )}
          >
            {turns.map((message, messageIndex) => {
              const working =
                running &&
                message.role === "assistant" &&
                messageIndex === turns.length - 1
              const renderedParts =
                message.role === "assistant"
                  ? renderAssistantParts(message, {
                      working,
                      systemStatus: waitLabel ?? null,
                      fileLinks: props.fileLinks,
                    })
                  : renderUserParts(message)

              const isUser = message.role === "user"
              const after = working
                ? null
                : props.renderAfterMessage?.(message.id)
              if (renderedParts.length === 0 && !after) return null

              return (
                <Fragment key={message.id}>
                  {renderedParts.length > 0 ? (
                    <div
                      className={cn(
                        "flex w-full",
                        isUser ? "justify-end" : "justify-start",
                      )}
                    >
                      <Message
                        from={message.role}
                        className={isUser ? chatUserBubbleClassName : undefined}
                      >
                        <MessageContent
                          className={isUser ? undefined : "gap-5"}
                        >
                          {renderedParts}
                        </MessageContent>
                      </Message>
                    </div>
                  ) : null}
                  {after ? (
                    <div className="flex w-full min-w-0 flex-col gap-3">
                      {after}
                    </div>
                  ) : null}
                </Fragment>
              )
            })}
            {showPulsatingLoader && (
              <StatusLine label={waitLabel ?? "Thinking"} />
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
        {props.onRetryStoppedTurn ? (
          <div className="px-4 pb-2">
            <div className={cn("mx-auto", chatColumnClassName)}>
              <InlineAlert
                variant="warning"
                title="The agent stopped before it answered"
                actions={
                  <Button
                    variant="secondary"
                    size="sm"
                    onPress={props.onRetryStoppedTurn}
                  >
                    Retry
                  </Button>
                }
              >
                Your question is saved. Retry to send it to the agent again.
              </InlineAlert>
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="px-4 pb-2">
            <div className={cn("mx-auto", chatColumnClassName)}>
              <InlineAlert variant="error" title="Could not send">
                {error.message || "Chat request failed."} Send again to retry.
              </InlineAlert>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
