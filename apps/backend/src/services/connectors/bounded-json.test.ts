import { describe, expect, it } from "vitest"
import { readBoundedJson } from "./bounded-json.js"

function streamOf(chunks: string[]): {
  body: ReadableStream<Uint8Array>
  pulled: () => number
} {
  let index = 0
  return {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++]
        if (chunk === undefined) return controller.close()
        controller.enqueue(new TextEncoder().encode(chunk))
      },
    }),
    pulled: () => index,
  }
}

describe("readBoundedJson", () => {
  it("parses an answer at the limit", async () => {
    const text = JSON.stringify({ a: "bc" })
    expect(await readBoundedJson(new Response(text), text.length)).toEqual({
      a: "bc",
    })
  })

  it("refuses a declared length above the limit and reads none of the body", async () => {
    const { body, pulled } = streamOf(["[1]", "[2]"])
    const response = new Response(body, {
      headers: { "content-length": "11" },
    })
    await expect(readBoundedJson(response, 10)).rejects.toThrow(
      "larger than 10 bytes",
    )
    expect(pulled()).toBeLessThanOrEqual(1)
  })

  it("stops a streamed body when it passes the limit", async () => {
    const { body, pulled } = streamOf(["[1,", "2,", "3,", "4,", "5]"])
    await expect(readBoundedJson(new Response(body), 5)).rejects.toThrow(
      "larger than 5 bytes",
    )
    expect(pulled()).toBeLessThan(5)
  })
})
