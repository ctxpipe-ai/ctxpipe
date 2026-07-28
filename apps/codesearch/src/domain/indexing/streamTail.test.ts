import { describe, expect, it } from "vitest"
import { readStreamTail } from "./streamTail.js"

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

describe("readStreamTail", () => {
  it("returns empty string for null stream", async () => {
    await expect(readStreamTail(null, 128)).resolves.toBe("")
  })

  it("returns the full text when under the byte limit", async () => {
    const stream = streamFromChunks([new TextEncoder().encode("hello world")])
    await expect(readStreamTail(stream, 1024)).resolves.toBe("hello world")
  })

  it("keeps only the trailing bytes when over the limit", async () => {
    const encoder = new TextEncoder()
    const stream = streamFromChunks([
      encoder.encode("aaaaaaaaaa"),
      encoder.encode("bbbbbbbbbb"),
      encoder.encode("cccccccccc"),
    ])
    const tail = await readStreamTail(stream, 12)
    expect(tail).toBe("bbcccccccccc")
    expect(encoder.encode(tail).byteLength).toBe(12)
  })
})
