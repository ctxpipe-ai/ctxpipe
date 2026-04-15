import type { UIMessageChunk } from "ai"

const DEFAULT_MAX_CHARS_PER_DELTA = 96

/**
 * Some OpenAI-compatible providers return one huge `text-delta` per completion.
 * The UI only updates when chunks arrive, so split large deltas into smaller
 * pieces for progressive rendering (same total text, more SSE events).
 */
export function createSplitLargeTextDeltaTransform(
  maxCharsPerDelta: number = DEFAULT_MAX_CHARS_PER_DELTA,
): TransformStream<UIMessageChunk, UIMessageChunk> {
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (chunk.type !== "text-delta") {
        controller.enqueue(chunk)
        return
      }
      const delta = chunk.delta
      if (typeof delta !== "string" || delta.length <= maxCharsPerDelta) {
        controller.enqueue(chunk)
        return
      }
      const id = (chunk as { id?: string }).id
      let offset = 0
      while (offset < delta.length) {
        let end = Math.min(offset + maxCharsPerDelta, delta.length)
        if (end < delta.length) {
          const space = delta.lastIndexOf(" ", end)
          if (space > offset + 12) end = space + 1
        }
        const piece = delta.slice(offset, end)
        controller.enqueue({
          type: "text-delta",
          delta: piece,
          ...(id !== undefined ? { id } : {}),
        } as UIMessageChunk)
        offset = end
      }
    },
  })
}
