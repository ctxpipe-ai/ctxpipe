import type { ReactElement } from "react"
import { IconMessageCircle } from "@tabler/icons-react"
import type { UIMessage } from "ai"
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
import { CardContent } from "@/components/ui/Card"
import { cn } from "@/lib/utils"

function isRenderableMessagePart(part: UIMessage["parts"][number]) {
  if (part.type === "data-rename-conversation") return false
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
        className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3 text-sm text-zinc-300"
      >
        <summary className="cursor-pointer text-zinc-200">Reasoning</summary>
        <MessageResponse>{part.text}</MessageResponse>
      </details>
    )
  }
  if (part.type === "source-url") {
    return (
      <p key={key} className="text-xs text-zinc-400">
        Source:{" "}
        <a className="text-teal-300 underline" href={part.url} target="_blank">
          {part.title ?? part.url}
        </a>
      </p>
    )
  }
  // if (part.type === "source-document") {
  //   return (
  //     <p key={key} className="text-xs text-zinc-400">
  //       Source:{" "}
  //       <a className="text-teal-300 underline" href={part.url} target="_blank">
  //         {part.title ?? part.url}
  //       </a>
  //     </p>
  //   )
  // }
  if (part.type.startsWith("data-") && "data" in part) {
    return (
      <pre key={key} className="text-xs text-zinc-400">
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

export function ConversationThread(props: {
  messages: UIMessage[]
  error: Error | null
  status?: ChatStatus
}) {
  const { messages, error, status } = props
  const lastMessage = messages[messages.length - 1]
  const lastAssistantHasRenderableParts =
    lastMessage?.role === "assistant"
      ? messageHasRenderableParts(lastMessage)
      : false
  const showPulsatingLoader =
    status === "submitted" ||
    (status === "streaming" && !lastAssistantHasRenderableParts)

  return (
    <div className="flex min-h-0 flex-1 flex-col border-zinc-800 bg-zinc-950/70 ring-0">
      <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden px-0">
        <div className="shrink-0 border-b border-zinc-800 px-4 py-3 h-10" />
        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="px-6 py-6 max-w-5xl mx-auto">
            {messages.length === 0 ? (
              <ConversationEmptyState
                icon={<IconMessageCircle className="h-10 w-10" />}
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

                  return (
                    <Message key={message.id} from={message.role}>
                      <MessageContent>{renderedParts}</MessageContent>
                    </Message>
                  )
                })}
                {showPulsatingLoader && (
                  // biome-ignore lint/a11y/useSemanticElements: div + role="status" for loading indicator; output is for form/calculation results, not live status
                  <div
                    className="flex w-full max-w-[95%] flex-col gap-2 is-assistant"
                    role="status"
                    aria-live="polite"
                    aria-label="Waiting for response"
                  >
                    <div
                      className={cn(
                        "flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
                        "animate-pulse",
                      )}
                    >
                      <div className="flex gap-1.5">
                        <span className="size-2 rounded-full bg-zinc-500" />
                        <span className="size-2 rounded-full bg-zinc-500" />
                        <span className="size-2 rounded-full bg-zinc-500" />
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
          <p className="px-4 pb-2 text-sm text-red-400">
            {error.message || "Chat request failed."}
          </p>
        ) : null}
      </CardContent>
    </div>
  )
}
