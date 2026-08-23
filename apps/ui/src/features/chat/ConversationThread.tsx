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

function partText(part: ChatMessage["parts"][number]): string {
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

function isRenderableMessagePart(part: ChatMessage["parts"][number]) {
  if (HIDDEN_DATA_PARTS.has(part.type) || part.type.startsWith("data-")) {
    return false
  }
  if (part.type === "text" || part.type === "thinking") {
    return Boolean(partText(part))
  }
  if (part.type === "source-url") return true
  return false
}

function renderMessagePart(part: ChatMessage["parts"][number], key: string) {
  if (!isRenderableMessagePart(part)) return null
  if (part.type === "text") {
    return <MessageResponse key={key}>{partText(part)}</MessageResponse>
  }
  if (part.type === "thinking") {
    return (
      <details key={key} className="rounded-lg text-sm text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">
          Reasoning
        </summary>
        <div className="mt-1.5">
          <MessageResponse>{partText(part)}</MessageResponse>
        </div>
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
  return null
}

function messageHasRenderableParts(message: ChatMessage) {
  return message.parts.some(isRenderableMessagePart)
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
            className={cn(
              "mx-auto max-w-2xl space-y-5 px-4 py-5",
              contentClassName,
            )}
          >
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
