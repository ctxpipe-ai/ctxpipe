import { IconBrain, IconTool } from "@tabler/icons-react"
import { type ReactElement, useState } from "react"
import { Button as AriaButton } from "react-aria-components"
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
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"

const HIDDEN_DATA_PARTS = new Set(["data-rename-conversation", "data-kg-focus"])

type ChatPart = ChatMessage["parts"][number]

function partText(part: ChatPart): string {
  return (part.content ?? part.text ?? "").trim()
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

function ActivityIconSlot(props: { live: boolean; children: ReactElement }) {
  return (
    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-zinc-500">
      {props.live ? (
        <span className="ctx-indexing-dot" aria-hidden />
      ) : (
        props.children
      )}
    </span>
  )
}

function reasoningResponseClassName() {
  return "text-xs leading-relaxed text-muted-foreground [&_blockquote]:text-muted-foreground [&_h1]:text-muted-foreground [&_h2]:text-muted-foreground [&_h3]:text-muted-foreground [&_h4]:text-muted-foreground [&_li]:text-muted-foreground [&_ol]:text-muted-foreground [&_p]:text-muted-foreground [&_strong]:text-muted-foreground [&_ul]:text-muted-foreground"
}

function ReasoningBox(props: {
  text: string
  live: boolean
  collapsed: boolean
}) {
  const { text, live, collapsed } = props
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null)
  const expanded = live || (userExpanded ?? !collapsed)

  if (live) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: live reasoning is a status, not a form output
      <div
        className="flex w-full min-w-0 items-start gap-2"
        role="status"
        aria-label="Reasoning"
      >
        <ActivityIconSlot live>
          <IconBrain className="size-4" aria-hidden />
        </ActivityIconSlot>
        <div className="min-w-0 flex-1">
          <MessageResponse className={reasoningResponseClassName()} isAnimating>
            {text}
          </MessageResponse>
        </div>
      </div>
    )
  }

  return (
    <AriaButton
      aria-expanded={expanded}
      aria-label="Reasoning"
      onPress={() => setUserExpanded(!expanded)}
      className={cn(
        focusVisibleClassName,
        "flex w-full min-w-0 items-start gap-2 rounded-lg text-left text-xs leading-relaxed text-muted-foreground",
        "hover:text-foreground/80",
      )}
    >
      <ActivityIconSlot live={false}>
        <IconBrain className="size-4" aria-hidden />
      </ActivityIconSlot>
      <span className={cn("min-w-0 flex-1", !expanded && "line-clamp-1")}>
        {text}
      </span>
    </AriaButton>
  )
}

function ToolUseRow(props: {
  tools: Array<{ id: string; name: string }>
  live: boolean
}) {
  const { tools, live } = props
  const [expanded, setExpanded] = useState(false)
  const count = tools.length
  const label = count === 1 ? "Used 1 tool" : `Used ${count} tools`
  const names = tools.map((tool, index) => (
    <span key={tool.id}>
      {index > 0 ? <span className="text-muted-foreground/40"> · </span> : null}
      {tool.name}
    </span>
  ))

  const button = (
    <AriaButton
      aria-expanded={expanded}
      aria-label={label}
      onPress={() => setExpanded(!expanded)}
      className={cn(
        focusVisibleClassName,
        "flex w-full min-w-0 items-start gap-2 rounded-lg text-left text-xs leading-relaxed text-muted-foreground",
        "hover:text-foreground/80",
      )}
    >
      <ActivityIconSlot live={live}>
        <IconTool className="size-4" aria-hidden />
      </ActivityIconSlot>
      {expanded ? (
        <span className="min-w-0 flex-1 font-mono">{names}</span>
      ) : (
        <span className="min-w-0 flex-1">
          Used <span className="tabular-nums">{count}</span>{" "}
          {count === 1 ? "tool" : "tools"}
        </span>
      )}
    </AriaButton>
  )

  if (live) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: live tool use is a status, not a form output
      <div role="status">{button}</div>
    )
  }

  return button
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
  const activity: ReactElement[] = []
  if (tools.length > 0) {
    activity.push(
      <ToolUseRow
        key={`${message.id}-tools`}
        tools={tools}
        live={options.streaming && !hasReply}
      />,
    )
  }
  if (thinking) {
    activity.push(
      <ReasoningBox
        key={`${message.id}-reasoning`}
        text={thinking}
        live={options.streaming && !hasReply}
        collapsed={hasReply}
      />,
    )
  }
  if (activity.length > 0) {
    nodes.push(
      <div
        key={`${message.id}-activity`}
        className="flex w-full min-w-0 flex-col gap-1.5"
      >
        {activity}
      </div>,
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
            className={cn("mx-auto max-w-2xl gap-6 p-5", contentClassName)}
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

              const isUser = message.role === "user"

              return (
                <div
                  key={message.id}
                  className={cn(
                    "flex w-full",
                    isUser ? "justify-end" : "justify-start",
                  )}
                >
                  <Message
                    from={message.role}
                    className={isUser ? "max-w-md" : undefined}
                  >
                    <MessageContent className={isUser ? undefined : "gap-5"}>
                      {renderedParts}
                    </MessageContent>
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
                <div className="flex items-center gap-2">
                  <span className="ctx-indexing-dot" aria-hidden />
                  <p className="text-xs text-muted-foreground">Thinking…</p>
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
