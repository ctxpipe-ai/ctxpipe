import type { ReactElement } from "react"
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import { InlineAlert } from "@/components/ui/InlineAlert"
import type { ChatMessage, ChatStatus } from "@/features/chat/types"
import { formatDate } from "@/lib/format"
import { cn } from "@/lib/utils"

const HIDDEN_DATA_PARTS = new Set(["data-rename-conversation", "data-kg-focus"])

type ChatPart = ChatMessage["parts"][number]

function partText(part: ChatPart): string {
  return (part.content ?? part.text ?? "").trim()
}

function formatMessageTimeLabel(message: ChatMessage): string | null {
  const createdAt =
    message.createdAt instanceof Date
      ? message.createdAt.toISOString()
      : undefined
  if (!createdAt) return null
  const d = new Date(createdAt)
  if (Number.isNaN(d.getTime())) return null
  return formatDate(createdAt)
}

function uniqueToolCalls(
  parts: ChatPart[],
): Array<{ id: string; name: string }> {
  const seen = new Set<string>()
  const tools: Array<{ id: string; name: string }> = []
  for (const part of parts) {
    if (part.type !== "tool-call") continue
    const name = part.name?.trim() || "tool"
    const id = part.id?.trim() || `${name}-${tools.length}`
    if (seen.has(id)) continue
    seen.add(id)
    tools.push({ id, name })
  }
  return tools
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

function ReasoningBox(props: {
  text: string
  live: boolean
  collapsed: boolean
}) {
  const { text, live, collapsed } = props
  if (collapsed) {
    return (
      <details className="rounded-lg border border-teal-400/20 bg-teal-400/5 px-3 py-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">
          Reasoning
        </summary>
        <div className="mt-1.5 text-sm">
          <MessageResponse>{text}</MessageResponse>
        </div>
      </details>
    )
  }
  return (
    <div
      className="rounded-lg border border-teal-400/20 bg-teal-400/5 px-3 py-2"
      role={live ? "status" : undefined}
    >
      <div className="flex items-center gap-2">
        {live ? <span className="ctx-indexing-dot" aria-hidden /> : null}
        <p className="text-xs font-medium text-foreground">Reasoning</p>
      </div>
      <div className="mt-1.5 text-sm text-muted-foreground">
        <MessageResponse isAnimating={live}>{text}</MessageResponse>
      </div>
    </div>
  )
}

function ToolUseRow(props: {
  tools: Array<{ id: string; name: string }>
  live: boolean
}) {
  const { tools, live } = props
  const count = tools.length
  const label = count === 1 ? "Used 1 tool" : `Used ${count} tools`
  return (
    <details className="rounded-lg border border-white/10 px-3 py-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer font-medium text-foreground">
        <span className="inline-flex items-center gap-2">
          {live ? <span className="ctx-indexing-dot" aria-hidden /> : null}
          <span>
            Used <span className="tabular-nums">{count}</span>{" "}
            {count === 1 ? "tool" : "tools"}
          </span>
        </span>
      </summary>
      <ul className="mt-1.5 space-y-0.5 font-mono text-xs">
        {tools.map((tool) => (
          <li key={tool.id}>{tool.name}</li>
        ))}
      </ul>
      <span className="sr-only">{label}</span>
    </details>
  )
}

function renderUserParts(message: ChatMessage): ReactElement[] {
  return message.parts.flatMap((part, index) => {
    if (part.type !== "text" || !partText(part)) return []
    return [
      <MessageResponse key={`${message.id}-${index}`}>
        {partText(part)}
      </MessageResponse>,
    ]
  })
}

function renderAssistantParts(
  message: ChatMessage,
  options: { streaming: boolean },
): ReactElement[] {
  const tools = uniqueToolCalls(message.parts)
  const thinking = message.parts
    .filter((part) => part.type === "thinking")
    .map(partText)
    .filter(Boolean)
    .join("\n\n")
  const replyParts = message.parts.filter(
    (part) =>
      (part.type === "text" && Boolean(partText(part))) ||
      part.type === "source-url",
  )
  const hasReply = replyParts.some(
    (part) => part.type === "text" && Boolean(partText(part)),
  )
  const nodes: ReactElement[] = []
  if (tools.length > 0) {
    nodes.push(
      <ToolUseRow
        key={`${message.id}-tools`}
        tools={tools}
        live={options.streaming && !hasReply}
      />,
    )
  }
  if (thinking) {
    nodes.push(
      <ReasoningBox
        key={`${message.id}-reasoning`}
        text={thinking}
        live={options.streaming && !hasReply}
        collapsed={hasReply}
      />,
    )
  }
  replyParts.forEach((part, index) => {
    const key = `${message.id}-reply-${index}`
    if (part.type === "text") {
      nodes.push(
        <MessageResponse key={key} isAnimating={options.streaming && hasReply}>
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
  return nodes
}

function messageHasVisibleActivity(message: ChatMessage) {
  return message.parts.some(
    (part) => isRenderableMessagePart(part) || isActivityMessagePart(part),
  )
}

function AgentSenderLabel() {
  // biome-ignore format: keep pipe inline so the span has no whitespace around |
  const pipe = <span key="pipe" className="text-teal-400">|</span>
  return <span className="ctx-label-muted">{["ctx", pipe]}</span>
}

export function ConversationThread(props: {
  messages: ChatMessage[]
  error: Error | null
  status?: ChatStatus
  contentClassName?: string
}) {
  const { messages, error, status, contentClassName } = props
  const lastMessage = messages[messages.length - 1]
  const lastAssistantHasVisibleActivity =
    lastMessage?.role === "assistant"
      ? messageHasVisibleActivity(lastMessage)
      : false
  const showPulsatingLoader =
    (status === "submitted" || status === "streaming") &&
    !lastAssistantHasVisibleActivity

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Conversation className="min-h-0 flex-1">
          <ConversationContent
            className={cn(
              "mx-auto max-w-2xl space-y-5 px-4 py-5",
              contentClassName,
            )}
          >
            {messages.map((message, messageIndex) => {
              const streaming =
                status === "streaming" &&
                message.role === "assistant" &&
                messageIndex === messages.length - 1
              const renderedParts =
                message.role === "assistant"
                  ? renderAssistantParts(message, { streaming })
                  : renderUserParts(message)

              if (renderedParts.length === 0) return null

              const role = message.role
              const timeLabel = formatMessageTimeLabel(message)
              const isUser = role === "user"

              return (
                <div
                  key={message.id}
                  className={cn(
                    "flex w-full",
                    isUser ? "justify-end" : "justify-start",
                  )}
                >
                  <Message
                    from={role}
                    className={isUser ? "max-w-md" : undefined}
                  >
                    <div
                      className={cn(
                        "flex w-full flex-col space-y-1",
                        isUser ? "items-end" : "items-start",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {isUser ? (
                          <span className="ctx-label-muted">you</span>
                        ) : (
                          <AgentSenderLabel />
                        )}
                        {timeLabel ? (
                          <span className="text-xs text-muted-foreground">
                            {timeLabel}
                          </span>
                        ) : null}
                      </div>
                      <MessageContent>{renderedParts}</MessageContent>
                    </div>
                  </Message>
                </div>
              )
            })}
            {showPulsatingLoader && (
              // biome-ignore lint/a11y/useSemanticElements: div + role="status" for loading indicator; output is for form/calculation results, not live status
              <div
                className="flex w-full justify-start"
                role="status"
                aria-live="polite"
                aria-label="Waiting for response"
              >
                <div className="flex w-full flex-col items-start space-y-1">
                  <AgentSenderLabel />
                  <div className="flex items-center gap-2">
                    <span className="ctx-indexing-dot" aria-hidden />
                    <p className="text-xs text-muted-foreground">Thinking…</p>
                  </div>
                </div>
              </div>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
        {error ? (
          <div className="px-4 pb-2">
            <div className="mx-auto max-w-2xl">
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
