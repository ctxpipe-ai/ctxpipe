import type { UIMessageChunk } from "ai"

/**
 * LangGraph / LangChain sometimes emits tool results whose `tool_call_id` does not match
 * the id seen in streamed `tool_call_chunks`, so @ai-sdk/langchain never emits
 * `tool-input-start` for that id. The AI SDK UI stream processor then throws
 * "No tool invocation found for tool call ID ..." on `tool-output-available`.
 *
 * When the id follows the synthetic pattern `tool_<toolName>_<opaqueSuffix>`, infer the
 * tool name and inject a `tool-input-start` so the client can attach the output.
 */
export function syntheticToolNameFromToolCallId(
  toolCallId: string,
): string | undefined {
  if (!toolCallId.startsWith("tool_")) return undefined
  const rest = toolCallId.slice("tool_".length)
  const lastUnderscore = rest.lastIndexOf("_")
  if (lastUnderscore <= 0) return undefined
  const candidate = rest.slice(0, lastUnderscore)
  const suffix = rest.slice(lastUnderscore + 1)
  if (suffix.length < 8 || !/^[a-zA-Z0-9_-]+$/.test(suffix)) return undefined
  if (candidate.length === 0) return undefined
  return candidate
}

function chunkNeedsExistingToolInvocation(
  chunk: UIMessageChunk,
): chunk is UIMessageChunk & { toolCallId: string } {
  if (chunk.type !== "tool-output-available" && chunk.type !== "tool-output-error")
    return false
  return typeof (chunk as { toolCallId?: unknown }).toolCallId === "string"
}

/**
 * Pass-through transform that prepends a synthetic `tool-input-start` when we would
 * otherwise hit the AI SDK's missing-invocation error for tool output chunks.
 */
export function createToolInvocationRepairTransform(): TransformStream<
  UIMessageChunk,
  UIMessageChunk
> {
  const seenToolCallIds = new Set<string>()

  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (
        chunk.type === "tool-input-start" ||
        chunk.type === "tool-input-available" ||
        chunk.type === "tool-input-delta"
      ) {
        const id = (chunk as { toolCallId?: string }).toolCallId
        if (typeof id === "string" && id.length > 0) seenToolCallIds.add(id)
      }

      if (chunkNeedsExistingToolInvocation(chunk)) {
        const { toolCallId } = chunk
        if (!seenToolCallIds.has(toolCallId)) {
          const toolName = syntheticToolNameFromToolCallId(toolCallId)
          if (toolName !== undefined) {
            controller.enqueue({
              type: "tool-input-start",
              toolCallId,
              toolName,
              dynamic: true,
            })
            seenToolCallIds.add(toolCallId)
          }
        }
      }

      controller.enqueue(chunk)
    },
  })
}
