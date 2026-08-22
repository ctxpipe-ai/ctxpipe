import { describe, expect, it } from "vitest"
import {
  aguiChunkToUiMessageChunks,
  aguiIterableToUiMessageChunks,
} from "./agui-to-ui-message.js"

describe("aguiChunkToUiMessageChunks", () => {
  it("maps text deltas and run lifecycle", () => {
    expect(aguiChunkToUiMessageChunks({ type: "RUN_STARTED" }, "t1")).toEqual([
      { type: "start", messageId: "t1" },
    ])
    expect(
      aguiChunkToUiMessageChunks(
        { type: "TEXT_MESSAGE_CONTENT", delta: "Hi" },
        "t1",
      ),
    ).toEqual([{ type: "text-delta", id: "t1", delta: "Hi" }])
    expect(aguiChunkToUiMessageChunks({ type: "RUN_FINISHED" }, "t1")).toEqual([
      { type: "finish" },
    ])
    expect(() =>
      aguiChunkToUiMessageChunks(
        { type: "RUN_ERROR", message: "Unexpected server error" },
        "t1",
      ),
    ).toThrow("Unexpected server error")
  })
})

describe("aguiIterableToUiMessageChunks", () => {
  it("opens and closes a text message around a bare content stream", async () => {
    async function* chunks() {
      yield { type: "TEXT_MESSAGE_CONTENT", delta: "Hello" }
    }
    const out: unknown[] = []
    for await (const chunk of aguiIterableToUiMessageChunks(chunks(), "t1")) {
      out.push(chunk)
    }
    expect(out).toEqual([
      { type: "start", messageId: "t1" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Hello" },
      { type: "text-end", id: "t1" },
      { type: "finish" },
    ])
  })
})
