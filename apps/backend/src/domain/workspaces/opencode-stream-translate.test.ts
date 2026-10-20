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

it("opens a tool call with its input, not with the empty pending input", async () => {
  // OpenCode first sends a tool part as "pending" with an empty input
  // while the model streams the arguments. The input comes with "running".
  const tool = (state: object) => ({
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_tool",
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "tool",
        tool: "read",
        callID: "call_1",
        state,
      },
    },
  })
  const events = [
    {
      type: "message.updated",
      properties: {
        info: { id: "msg_1", sessionID: "ses_1", role: "assistant" },
      },
    },
    tool({ status: "pending", input: {}, raw: "" }),
    tool({
      status: "running",
      input: { filePath: "knowledge/docker.md" },
      time: { start: 1 },
    }),
    tool({
      status: "completed",
      input: { filePath: "knowledge/docker.md" },
      output: "# Docker",
      title: "knowledge/docker.md",
      metadata: {},
      time: { start: 1, end: 2 },
    }),
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

  const args = chunks.flatMap((chunk) =>
    chunk.type === "TOOL_CALL_ARGS" ? [chunk.delta] : [],
  )
  expect(args).toEqual(['{"filePath":"knowledge/docker.md"}'])
  expect(
    chunks.filter((chunk) => chunk.type === "TOOL_CALL_RESULT"),
  ).toHaveLength(1)
})
