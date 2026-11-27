import type { StreamChunk } from "@tanstack/ai"

/**
 * Keeps the order of thoughts and tool calls in the stored transcript.
 * OpenCode runs its own tools, so each tool call is marked as
 * provider-executed. The engine then splits the stored message at each
 * thought that follows a tool call. TanStack AI 1.x starts a new thinking
 * part at each REASONING_MESSAGE_START, so no step events are needed.
 */
async function* withProviderExecutedTools(
  chunks: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  for await (const chunk of chunks) {
    if (chunk.type === "TOOL_CALL_START") {
      yield {
        ...chunk,
        metadata: { ...chunk.metadata, providerExecuted: true },
      } as StreamChunk
      continue
    }
    yield chunk
  }
}

/** The adapter, with its stream passed through `withProviderExecutedTools`. */
export function withOrderedTranscript<
  T extends { chatStream(options: never): AsyncIterable<StreamChunk> },
>(adapter: T): T {
  return Object.create(adapter, {
    chatStream: {
      value: (options: never) =>
        withProviderExecutedTools(adapter.chatStream(options)),
    },
  }) as T
}
