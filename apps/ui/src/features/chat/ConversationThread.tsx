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
import { Card, CardContent } from "@/components/ui/Card"
import type { UIMessage } from "ai"
import { IconMessageCircle } from "@tabler/icons-react"

function renderMessagePart(part: UIMessage["parts"][number], key: string) {
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
  if (part.type.startsWith("data-")) {
    return (
      <pre key={key} className="text-xs text-zinc-400">
        {JSON.stringify(part.data)}
      </pre>
    )
  }
  return null
}

export function ConversationThread(props: {
  messages: UIMessage[]
  error: Error | null
}) {
  const { messages, error } = props

  return (
    <Card className="h-full min-h-0 border-zinc-800 bg-zinc-950/70 py-0">
      <CardContent className="flex h-full min-h-0 flex-col px-0">
        <div className="border-b border-zinc-800 px-4 py-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            Conversation
          </p>
        </div>
        <Conversation className="min-h-0">
          <ConversationContent className="px-4 py-6">
            {messages.length === 0 ? (
              <ConversationEmptyState
                icon={<IconMessageCircle className="h-10 w-10" />}
                title="No messages yet"
                description="Send the first message to begin."
              />
            ) : (
              messages.map((message) => (
                <Message key={message.id} from={message.role}>
                  <MessageContent>
                    {message.parts.map((part, index) =>
                      renderMessagePart(part, `${message.id}-${index}`),
                    )}
                  </MessageContent>
                </Message>
              ))
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
    </Card>
  )
}
