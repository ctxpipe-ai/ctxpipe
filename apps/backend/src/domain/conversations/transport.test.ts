import { describe, expect, it } from "vitest"
import type { UIMessageChunk } from "ai"
import { pipeConversationUiStreamTransforms } from "./conversationUiStreamPipeline.js"

async function readAllChunks(
  stream: ReadableStream<UIMessageChunk>,
): Promise<UIMessageChunk[]> {
  const reader = stream.getReader()
  const chunks: UIMessageChunk[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return chunks
}

describe("pipeConversationUiStreamTransforms", () => {
  it("repairs text-end emitted by a later flush transform without text-start", async () => {
    const msgId = "gen-1779258149-JKCU23nzgbXiWMotz6jt"
    const lateTextEndOnFlush = new TransformStream<UIMessageChunk, UIMessageChunk>(
      {
        transform(chunk, controller) {
          controller.enqueue(chunk)
        },
        flush(controller) {
          controller.enqueue({ type: "text-end", id: msgId })
        },
      },
    )

    const input = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.close()
      },
    })

    const out = pipeConversationUiStreamTransforms(input, [lateTextEndOnFlush])
    const chunks = await readAllChunks(out)

    expect(chunks).toEqual([
      { type: "text-start", id: msgId },
      { type: "text-end", id: msgId },
    ])
  })

  it("applies tool repair before text-start repair", async () => {
    const toolCallId = "tool_search_abc12345678"
    const input = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue({
          type: "tool-output-available",
          toolCallId,
          output: { ok: true },
        })
        controller.close()
      },
    })

    const chunks = await readAllChunks(pipeConversationUiStreamTransforms(input))

    expect(chunks[0]).toMatchObject({
      type: "tool-input-start",
      toolCallId,
      toolName: "search",
    })
    expect(chunks[1]?.type).toBe("tool-output-available")
  })
})
