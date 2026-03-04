/**
 * Composable stream enhancer for conversation renaming.
 * Filters naming message chunks, captures the conversation name from values,
 * and emits data-rename-conversation on flush when source is "ui".
 */

export interface StreamEnhancer {
  wrapGraphStream(stream: AsyncIterable<unknown>): AsyncIterable<unknown>
  getFlushTransform(): TransformStream<unknown, unknown>
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
    const [mode, data] =
      chunk.length === 3 ? [chunk[1], chunk[2]] : [chunk[0], chunk[1]]
    if (mode === "messages" && Array.isArray(data) && data.length >= 2) {
      const metadata = data[1] as Record<string, unknown> | undefined
      const node = metadata?.langgraph_node
      if (node === "conversationNaming") continue
    }
    yield chunk
  }
}

export function createRenameStreamEnhancer(input: {
  source?: string
  onFinish?: () => Promise<void> | void
}): StreamEnhancer {
  const capturedName = { name: null as string | null }

  return {
    wrapGraphStream(stream: AsyncIterable<unknown>) {
      const filtered = filterNamingMessageChunks(stream)
      return captureConversationName(filtered, capturedName)
    },
    getFlushTransform() {
      return new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk)
        },
        async flush(controller) {
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
      })
    },
  }
}
