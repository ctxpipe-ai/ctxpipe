import type { UIMessageChunk } from "ai"
import { log } from "../../observability/logger.js"

/**
 * When upstream LangGraph chunks are filtered (e.g. internal planner/naming nodes),
 * @ai-sdk/langchain can emit `text-delta` / `text-end` for a message id without a prior
 * `text-start` for that id. The AI SDK UI stream processor then throws
 * "Received text-end for missing text part...".
 *
 * This transform prepends a synthetic `text-start` whenever we see text-delta or
 * text-end for an id that has not yet received `text-start` in this stream.
 */
export function createTextStartRepairTransform(): TransformStream<
  UIMessageChunk,
  UIMessageChunk
> {
  const textStartSeen = new Set<string>()

  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (chunk.type === "text-start") {
        const id = (chunk as { id?: unknown }).id
        if (typeof id === "string" && id.length > 0) {
          if (textStartSeen.has(id)) return
          textStartSeen.add(id)
        }
        controller.enqueue(chunk)
        return
      }

      if (chunk.type === "text-delta" || chunk.type === "text-end") {
        const id = (chunk as { id?: unknown }).id
        if (typeof id === "string" && id.length > 0 && !textStartSeen.has(id)) {
          log.warn({
            step: "conversation.ui_stream.text_start_repair",
            message: "Synthesised missing text-start before text chunk",
            textPartId: id,
            followingChunkType: chunk.type,
          })
          controller.enqueue({ type: "text-start", id })
          textStartSeen.add(id)
        }
      }

      controller.enqueue(chunk)
    },
  })
}
