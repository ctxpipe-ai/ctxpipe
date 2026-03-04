import {
  HumanMessage,
  type AIMessage,
  type BaseMessage,
  type BaseMessageLike,
} from "@langchain/core/messages"
import { createUIMessageStreamResponse, type UIMessage } from "ai"
import { toUIMessageStream } from "@ai-sdk/langchain"
import { chatGraph } from "../../graphs/index.js"
import { generateObjectId } from "../../lib/id.js"

type ConversationProtocol = "data" | "text"

type StreamInput = {
  conversationId: string
  checkpointNamespace: string
  prompt: string
  source?: string
  onFinish?: () => Promise<void> | void
}

export interface ConversationTransportAdapter {
  toResponse(input: StreamInput): Promise<Response>
}

export function createHttpConversationTransport(
  protocol: ConversationProtocol,
): ConversationTransportAdapter {
  return protocol === "text"
    ? new TextStreamConversationTransport()
    : new DataStreamConversationTransport()
}

function extractConversationNameFromChunk(chunk: unknown): string | null {
  if (typeof chunk !== "object" || chunk === null) return null
  const obj = chunk as Record<string, unknown>
  if (typeof obj.conversationName === "string") return obj.conversationName
  const values = obj.values as Record<string, unknown> | undefined
  if (values && typeof values.conversationName === "string")
    return values.conversationName
  if (Array.isArray(chunk) && chunk.length >= 2) {
    const second = chunk[1] as Record<string, unknown> | undefined
    if (second && typeof second.conversationName === "string")
      return second.conversationName
    const secondValues = second?.values as Record<string, unknown> | undefined
    if (secondValues && typeof secondValues.conversationName === "string")
      return secondValues.conversationName
  }
  return null
}

async function* captureConversationName(
  stream: AsyncIterable<unknown>,
  capture: { name: string | null },
) {
  for await (const chunk of stream) {
    const name = extractConversationNameFromChunk(chunk)
    if (name) capture.name = name
    yield chunk
  }
}

/**
 * Filters out "messages" stream events from the conversationNaming node.
 * LangGraph emits text-start/text-delta/text-end for ALL model invocations (including
 * model.invoke()). The metadata includes langgraph_node to identify the source node.
 * We filter naming messages so only data-rename-conversation carries the title.
 */
async function* filterNamingMessageChunks(
  stream: AsyncIterable<unknown>,
): AsyncIterable<unknown> {
  for await (const chunk of stream) {
    if (!Array.isArray(chunk) || chunk.length < 2) {
      yield chunk
      continue
    }
    const [mode, data] = chunk.length === 3 ? [chunk[1], chunk[2]] : [chunk[0], chunk[1]]
    if (mode === "messages" && Array.isArray(data) && data.length >= 2) {
      const metadata = data[1] as Record<string, unknown> | undefined
      const node = metadata?.langgraph_node
      if (node === "conversationNaming") continue
    }
    yield chunk
  }
}

class DataStreamConversationTransport implements ConversationTransportAdapter {
  async toResponse(input: StreamInput): Promise<Response> {
    const graphStream = await chatGraph.stream(
      { messages: [new HumanMessage(input.prompt)] },
      {
        streamMode: ["values", "messages"],
        configurable: {
          checkpoint_ns: input.checkpointNamespace,
          thread_id: input.conversationId,
          source: input.source ?? "ui",
        },
      },
    )

    const capturedName = { name: null as string | null }
    const filteredStream = filterNamingMessageChunks(graphStream)
    const wrappedStream = captureConversationName(filteredStream, capturedName)
    const uiStream = toUIMessageStream(
      wrappedStream as Parameters<typeof toUIMessageStream>[0],
    )

    const streamWithRenameAndFinish = uiStream.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk)
        },
        async flush(controller) {
          // Send conversation name only via data-rename-conversation (no text chunks).
          // Naming message chunks are filtered above; name comes from values chunk.
          if (
            input.source === "ui" &&
            capturedName.name &&
            capturedName.name.length > 0
          ) {
            controller.enqueue({
              type: "data-rename-conversation",
              data: { name: capturedName.name },
              transient: true,
            })
          }
          await input.onFinish?.()
        },
      }),
    )

    return createUIMessageStreamResponse({ stream: streamWithRenameAndFinish })
  }
}

class TextStreamConversationTransport implements ConversationTransportAdapter {
  async toResponse(input: StreamInput): Promise<Response> {
    const result = await chatGraph.invoke(
      { messages: [new HumanMessage(input.prompt)] },
      {
        configurable: {
          checkpoint_ns: input.checkpointNamespace,
          thread_id: input.conversationId,
        },
      },
    )
    const snapshot = extractSnapshotFromChunk(result)
    const text = snapshot?.text ?? ""
    await input.onFinish?.()
    return new Response(text, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    })
  }
}

export async function loadConversationUiMessages(input: {
  conversationId: string
  checkpointNamespace: string
}): Promise<UIMessage[]> {
  const graphWithState = chatGraph as unknown as {
    getState?: (config: {
      configurable: { checkpoint_ns?: string; thread_id: string }
    }) => Promise<{
      values?: { messages?: BaseMessage[] }
    }>
  }
  if (!graphWithState.getState) return []

  const config = {
    configurable: {
      thread_id: input.conversationId,
      checkpoint_ns: input.checkpointNamespace,
    },
  }

  let state:
    | {
        values?: { messages?: BaseMessage[] }
      }
    | undefined

  try {
    state = await graphWithState.getState(config)
  } catch {
    return []
  }

  const messages = state.values?.messages ?? []
  return messages.flatMap((message) => {
    const role = toUiRole(message)
    if (!role) return []
    const snapshot = extractSnapshotFromMessage(message)
    const parts: UIMessage["parts"] = []
    if (snapshot.text.length > 0) {
      parts.push({ type: "text", text: snapshot.text })
    }
    if (snapshot.reasoning.length > 0) {
      parts.push({ type: "reasoning", text: snapshot.reasoning })
    }
    for (const source of snapshot.sources) {
      parts.push({
        type: "source-url",
        sourceId: source.sourceId,
        url: source.url,
        title: source.title ?? source.url,
      })
    }
    return [
      {
        id: generateObjectId("msg"),
        role,
        parts,
      },
    ] satisfies UIMessage[]
  })
}

function extractSnapshotFromChunk(chunk: unknown): {
  text: string
  reasoning: string
  sources: Array<{ sourceId: string; url: string; title?: string }>
} | null {
  if (
    typeof chunk !== "object" ||
    chunk === null ||
    !("messages" in chunk) ||
    !Array.isArray(chunk.messages)
  ) {
    return null
  }
  const message = (chunk as { messages: BaseMessageLike[] }).messages.at(-1)
  if (!message || (message as { getType?: () => string }).getType?.() !== "ai") {
    return null
  }
  return extractSnapshotFromMessage(message)
}

function toUiRole(message: BaseMessage): UIMessage["role"] | null {
  const kind = message.getType()
  if (kind === "human") return "user"
  if (kind === "ai") return "assistant"
  if (kind === "system") return "system"
  return null
}

function extractSnapshotFromMessage(message: BaseMessageLike): {
  text: string
  reasoning: string
  sources: Array<{ sourceId: string; url: string; title?: string }>
} {
  let text = ""
  let reasoning = ""
  const sources: Array<{ sourceId: string; url: string; title?: string }> = []

  if (
    typeof message === "object" &&
    message !== null &&
    "content" in message &&
    typeof message.content === "string"
  ) {
    text = message.content
  }

  if (
    typeof message === "object" &&
    message !== null &&
    "content" in message &&
    Array.isArray(message.content)
  ) {
    for (const part of message.content) {
      if (typeof part !== "object" || part === null) continue
      if ("type" in part && part.type === "text" && "text" in part) {
        if (typeof part.text === "string") text += part.text
      }
      if (
        "type" in part &&
        (part.type === "reasoning" || part.type === "thinking") &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        reasoning += part.text
      }
    }
  }

  if (isAIMessage(message)) {
    const rawSources = (message.additional_kwargs as Record<string, unknown>)
      ?.sources
    if (Array.isArray(rawSources)) {
      for (const source of rawSources) {
        if (typeof source === "string") {
          sources.push({ sourceId: source, url: source })
        }
        if (
          typeof source === "object" &&
          source !== null &&
          "url" in source &&
          typeof source.url === "string"
        ) {
          const sourceId =
            "id" in source && typeof source.id === "string"
              ? source.id
              : source.url
          const title =
            "title" in source && typeof source.title === "string"
              ? source.title
              : undefined
          sources.push({ sourceId, url: source.url, title })
        }
      }
    }
  }

  return { text, reasoning, sources }
}

function isAIMessage(message: BaseMessageLike): message is AIMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "getType" in message &&
    typeof message.getType === "function" &&
    message.getType() === "ai"
  )
}

export function toPromptFromIncomingMessage(message: {
  content?: unknown
  parts?: unknown[]
}): string {
  if (typeof message.content === "string" && message.content.trim().length > 0) {
    return message.content
  }
  if (Array.isArray(message.parts)) {
    const textParts = message.parts
      .flatMap((part) => {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          return [part.text]
        }
        return []
      })
      .join("\n")
      .trim()
    if (textParts.length > 0) return textParts
  }
  return ""
}
