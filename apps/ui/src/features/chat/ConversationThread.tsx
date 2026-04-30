import { IconMessageCircle } from "@tabler/icons-react"
import type { UIMessage } from "ai"
import type { ReactElement } from "react"
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import { formatDate } from "@/lib/format"
import { cn } from "@/lib/utils"

const HIDDEN_DATA_PARTS = new Set(["data-rename-conversation", "data-kg-focus"])

function formatMessageTimeLabel(message: UIMessage): string | null {
  const meta = message.metadata as { createdAt?: string } | undefined
  if (!meta?.createdAt) return null
  const d = new Date(meta.createdAt)
  if (Number.isNaN(d.getTime())) return null
  return formatDate(meta.createdAt)
}

function isRenderableMessagePart(part: UIMessage["parts"][number]) {
  if (HIDDEN_DATA_PARTS.has(part.type)) return false
  if (part.type === "text") return Boolean(part.text?.trim())
  if (part.type === "reasoning") return Boolean(part.text?.trim())
  if (part.type === "source-url") return true
  if (part.type.startsWith("data-")) return "data" in part
  return false
}

function renderMessagePart(part: UIMessage["parts"][number], key: string) {
  if (!isRenderableMessagePart(part)) return null
  if (part.type === "text") {
    return <MessageResponse key={key}>{part.text}</MessageResponse>
  }
  if (part.type === "reasoning") {
    return (
      <details
        key={key}
        className="rounded-none border border-border/60 bg-foreground/[0.04] p-3 text-sm text-muted-foreground"
      >
        <summary className="cursor-pointer text-foreground">Reasoning</summary>
        <MessageResponse>{part.text}</MessageResponse>
      </details>
    )
  }
  if (part.type === "source-url") {
    return (
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
      </p>
    )
  }
  if (part.type.startsWith("data-") && "data" in part) {
    return (
      <pre key={key} className="text-xs text-muted-foreground">
        {JSON.stringify(part.data)}
      </pre>
    )
  }
  return null
}

export type ChatStatus = "submitted" | "streaming" | "ready" | "error"

function messageHasRenderableParts(message: UIMessage) {
  return message.parts.some(isRenderableMessagePart)
}

function AgentSenderLabel() {
  // biome-ignore format: keep pipe inline so the span has no whitespace around |
  const pipe = <span key="pipe" className="text-teal-400">|</span>
  return <span className="ctx-label-muted">{["ctx", pipe]}</span>
}

export function ConversationThread(props: {
  messages: UIMessage[]
  error: Error | null
  status?: ChatStatus
  contentClassName?: string
}) {
  const { messages, error, status, contentClassName } = props
  const lastMessage = messages[messages.length - 1]
  const lastAssistantHasRenderableParts =
    lastMessage?.role === "assistant"
      ? messageHasRenderableParts(lastMessage)
      : false
  const showPulsatingLoader =
    status === "submitted" ||
    (status === "streaming" && !lastAssistantHasRenderableParts)

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Conversation className="min-h-0 flex-1">
          <ConversationContent
            className={cn("mx-auto max-w-2xl space-y-6 p-6", contentClassName)}
          >
            {messages.length === 0 ? (
              <ConversationEmptyState
                icon={
                  <IconMessageCircle className="h-10 w-10 text-muted-foreground" />
                }
                title="No messages yet"
                description="Send the first message to begin."
              />
            ) : (
              <>
                {messages.map((message) => {
                  const renderedParts = message.parts
                    .map((part, index) =>
                      renderMessagePart(part, `${message.id}-${index}`),
                    )
                    .filter((part): part is ReactElement => part !== null)

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
                      <Message from={role}>
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
                              <span className="text-[10px] text-muted-foreground/50">
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
                    <div className="flex w-full max-w-[85%] items-center gap-3">
                      <div
                        className="flex size-8 shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-foreground/[0.04]"
                        aria-hidden
                      >
                        <span className="ctx-indexing-dot" />
                      </div>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <AgentSenderLabel />
                        <p className="text-xs text-muted-foreground">
                          Thinking…
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
        {error ? (
          <p className="px-6 pb-2 text-sm text-destructive">
            {error.message || "Chat request failed."}
          </p>
        ) : null}
      </div>
    </div>
  )
}
