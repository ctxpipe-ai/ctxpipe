import type { StreamChunk } from "@tanstack/ai"

/**
 * Keeps the order of thoughts and tool calls in the stored transcript.
 * OpenCode sends no step events, and without a step the chat engine adds all
 * reasoning of a turn to its first thinking part. OpenCode runs its own tools,
 * so each tool call is marked as provider-executed. The engine then splits the
 * stored message at each thought that follows a tool call.
 */
async function* withReasoningSteps(
  chunks: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  for await (const chunk of chunks) {
    if (chunk.type === "REASONING_MESSAGE_START") {
      yield {
        type: "STEP_STARTED",
        stepName: chunk.messageId,
        timestamp: chunk.timestamp,
      } as StreamChunk
    }
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

/** The adapter, with its stream passed through `withReasoningSteps`. */
export function withOrderedTranscript<
  T extends { chatStream(options: never): AsyncIterable<StreamChunk> },
>(adapter: T): T {
  return Object.create(adapter, {
    chatStream: {
      value: (options: never) =>
        withReasoningSteps(adapter.chatStream(options)),
    },
  }) as T
}
