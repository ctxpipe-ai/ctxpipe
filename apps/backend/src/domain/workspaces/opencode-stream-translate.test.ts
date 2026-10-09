import type { AdapterYieldChunk } from "@tanstack/ai"
import {
  type OpencodeStreamEvent,
  translateOpencodeStream,
} from "@tanstack/ai-opencode"
import { expect, it } from "vitest"

it("streams each text delta once when a part arrives before its message role", async () => {
  // OpenCode can send a part, and deltas for it, before the
  // message.updated event that tells the role of its message.
  const part = (text: string) => ({
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_1",
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "text",
        text,
      },
    },
  })
  const delta = (text: string) => ({
    type: "message.part.delta",
    properties: {
      sessionID: "ses_1",
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: text,
    },
  })
  const events = [
    part(""),
    delta("A"),
    delta("B"),
    {
      type: "message.updated",
      properties: {
        info: { id: "msg_1", sessionID: "ses_1", role: "assistant" },
      },
    },
    delta("C"),
    part("ABC"),
  ]
  async function* replay(): AsyncGenerator<OpencodeStreamEvent> {
    for (const event of events)
      yield { kind: "event", event } as unknown as OpencodeStreamEvent
  }
  const chunks: AdapterYieldChunk[] = []
  let id = 0
  for await (const chunk of translateOpencodeStream(replay(), {
    model: "synthetic/probe",
    runId: "run",
    threadId: "thread",
    genId: () => `gen-${id++}`,
  }))
    chunks.push(chunk)

  expect(
    chunks.flatMap((chunk) =>
      chunk.type === "TEXT_MESSAGE_CONTENT" ? [chunk.delta] : [],
    ),
  ).toEqual(["A", "B", "C"])
})
