import type { UIMessageChunk } from "ai"

export type AguiChunk = {
  type?: string
  delta?: string
  messageId?: string
  id?: string
}

/** Map TanStack AG-UI text chunks onto the Vercel AI SDK UI-message stream. */
export function aguiChunkToUiMessageChunks(
  chunk: AguiChunk,
  textId: string,
): UIMessageChunk[] {
  if (chunk.type === "RUN_STARTED") {
    return [{ type: "start", messageId: chunk.messageId ?? textId }]
  }
  if (chunk.type === "TEXT_MESSAGE_START") {
    return [{ type: "text-start", id: chunk.id ?? textId }]
  }
  if (
    chunk.type === "TEXT_MESSAGE_CONTENT" &&
    typeof chunk.delta === "string"
  ) {
    return [{ type: "text-delta", id: chunk.id ?? textId, delta: chunk.delta }]
  }
  if (chunk.type === "TEXT_MESSAGE_END") {
    return [{ type: "text-end", id: chunk.id ?? textId }]
  }
  if (chunk.type === "RUN_FINISHED" || chunk.type === "RUN_ERROR") {
    return [{ type: "finish" }]
  }
  return []
}

export async function* aguiIterableToUiMessageChunks(
  stream: AsyncIterable<AguiChunk>,
  textId: string,
): AsyncGenerator<UIMessageChunk> {
  let started = false
  let textOpen = false
  for await (const chunk of stream) {
    if (!started && chunk.type === "TEXT_MESSAGE_CONTENT") {
      started = true
      yield { type: "start", messageId: textId }
      yield { type: "text-start", id: textId }
      textOpen = true
    }
    const mapped = aguiChunkToUiMessageChunks(chunk, textId)
    if (chunk.type === "TEXT_MESSAGE_START") textOpen = true
    if (chunk.type === "TEXT_MESSAGE_END") textOpen = false
    if (chunk.type === "RUN_STARTED") started = true
    for (const next of mapped) yield next
  }
  if (textOpen) yield { type: "text-end", id: textId }
  if (started) yield { type: "finish" }
}
