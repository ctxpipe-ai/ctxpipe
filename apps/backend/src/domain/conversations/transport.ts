import { toUIMessageStream } from "@ai-sdk/langchain"
import {
  type AIMessage,
  type BaseMessage,
  type BaseMessageLike,
  HumanMessage,
} from "@langchain/core/messages"
import {
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk,
} from "ai"
import { conversationGraph } from "../../graphs/index.js"
import { generateObjectId } from "../../lib/id.js"
import { runWithLangfuseContext } from "../../observability/langfuse.js"
import { langfusePipelineCallbacks } from "../../observability/langfusePipelineMetrics.js"
import type { StreamEnhancer } from "./renameStream.js"
import { pipeConversationUiStreamTransforms } from "./conversationUiStreamPipeline.js"

export type StreamInput = {
  conversationId: string
  checkpointNamespace: string
  prompt: string
  source?: string | null
  onFinish?: () => Promise<void> | void
  streamEnhancers?: StreamEnhancer[]
}

export interface ConversationTransportAdapter {
  toResponse(input: StreamInput): Promise<Response>
}

export function createDataStreamConversationTransport(): ConversationTransportAdapter {
  return new DataStreamConversationTransport()
}

class DataStreamConversationTransport implements ConversationTransportAdapter {
  async toResponse(input: StreamInput): Promise<Response> {
    return runWithLangfuseContext(
      {
        sessionId: input.conversationId,
        tags: input.source ? [input.source] : undefined,
      },
      async () => {
        const graphStream = await conversationGraph.stream(
          { messages: [new HumanMessage(input.prompt)] },
          {
            // "custom" carries conversationNaming's getWriter() events (rename) interleaved with LLM chunks.
            streamMode: ["values", "messages", "custom"],
            configurable: {
              checkpoint_ns: input.checkpointNamespace,
              thread_id: input.conversationId,
              source: input.source ?? null,
            },
            callbacks: langfusePipelineCallbacks({
              step: "conversation.graph",
              dimensions: {
                conversationId: input.conversationId,
                ...(input.source ? { source: input.source } : {}),
              },
            }),
          },
        )

        let wrappedStream: AsyncIterable<unknown> = graphStream
        const flushTransforms: TransformStream<unknown, unknown>[] = []

        for (const enhancer of input.streamEnhancers ?? []) {
          wrappedStream = enhancer.wrapGraphStream(wrappedStream)
          flushTransforms.push(enhancer.getFlushTransform())
        }

        const uiStream = toUIMessageStream(
          wrappedStream as Parameters<typeof toUIMessageStream>[0],
        )

        const stream = pipeConversationUiStreamTransforms(
          uiStream,
          flushTransforms as TransformStream<UIMessageChunk, UIMessageChunk>[],
        )

        return createUIMessageStreamResponse({ stream })
      },
    )
  }
}

export async function loadConversationUiMessages(input: {
  conversationId: string
  checkpointNamespace: string
}): Promise<UIMessage[]> {
  const graphWithState = conversationGraph as unknown as {
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
  if (
    typeof message.content === "string" &&
    message.content.trim().length > 0
  ) {
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
