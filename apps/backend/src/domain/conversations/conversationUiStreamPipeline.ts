import type { UIMessageChunk } from "ai"
import { createTextStartRepairTransform } from "./uiMessageStreamTextStartRepair.js"
import { createToolInvocationRepairTransform } from "./uiMessageStreamToolInvocationRepair.js"

/**
 * Applies tool-invocation repair, optional flush transforms (e.g. rename onFinish),
 * then text-start repair last so no downstream transform can emit text-delta/text-end
 * without a matching text-start reaching the client.
 */
export function pipeConversationUiStreamTransforms(
  uiStream: ReadableStream<UIMessageChunk>,
  flushTransforms: TransformStream<UIMessageChunk, UIMessageChunk>[] = [],
): ReadableStream<UIMessageChunk> {
  let stream: ReadableStream<UIMessageChunk> = uiStream.pipeThrough(
    createToolInvocationRepairTransform(),
  )
  for (const transform of flushTransforms) {
    stream = stream.pipeThrough(transform)
  }
  return stream.pipeThrough(createTextStartRepairTransform())
}
