import { startOpencodeSession } from "@tanstack/ai-opencode"
import { HttpResponse, http } from "msw"
import { expect, it } from "vitest"

import { useMswServer } from "../../../test/msw.js"

const server = useMswServer()

const base = "http://opencode.test"
const sessionID = "ses_fixture"
const encoder = new TextEncoder()

type Event = { type: string; properties: Record<string, unknown> }

/**
 * A fake OpenCode server. In POST /message, `answer` returns the events to
 * send before the answer and the events to send after it. The late events go
 * to the event stream only after the client read all of the answer, and after
 * the microtasks that follow that read.
 */
function fakeOpencode(
  answer: () => {
    early: Event[]
    late: Event[]
    reply: Record<string, unknown>
    parts: unknown[]
  },
) {
  let events!: ReadableStreamDefaultController<Uint8Array>
  const send = (event: Event) =>
    events.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
  server.use(
    http.get(`${base}/event`, () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          events = controller
          send({ type: "server.connected", properties: {} })
        },
      })
      return new HttpResponse(body, {
        headers: { "content-type": "text/event-stream" },
      })
    }),
    http.post(`${base}/session`, () => HttpResponse.json({ id: sessionID })),
    http.post(`${base}/session/:id/message`, () => {
      const { early, late, reply, parts } = answer()
      for (const event of early) send(event)
      const json = encoder.encode(JSON.stringify({ info: reply, parts }))
      let pulls = 0
      // The client pulls again after the last chunk. Then it has all of the
      // answer. setImmediate lets the microtasks of that read run first.
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1
          if (pulls === 1) return controller.enqueue(json)
          controller.close()
          setImmediate(() => {
            for (const event of late) send(event)
          })
        },
      })
      return new HttpResponse(body, {
        headers: { "content-type": "application/json" },
      })
    }),
  )
}

const updated = (info: Record<string, unknown>): Event => ({
  type: "message.updated",
  properties: { sessionID, info },
})
const status = (type: "busy" | "idle"): Event => ({
  type: "session.status",
  properties: { sessionID, status: { type } },
})

async function promptOnce() {
  const received: Event[] = []
  const session = await startOpencodeSession({
    baseUrl: base,
    providerID: "synthetic",
    modelID: "probe",
    onEvent: (event) => received.push(event as Event),
    onPermissionRequest: () => "reject",
  })
  try {
    const result = await session.prompt("Question")
    return { result, receivedAtResolve: received.map((event) => event.type) }
  } finally {
    await session.dispose()
  }
}

it("resolves a prompt only after the event stream sent the text of its reply (CTX-1061)", async () => {
  // OpenCode serializes a message.updated event when it writes the event, not
  // when it publishes it. When the event stream is slow, the first update of
  // the reply already shows the reply as finished, and its text comes after
  // the prompt answer.
  const reply = {
    id: "msg_reply",
    sessionID,
    role: "assistant",
    finish: "stop",
    time: { created: 1, completed: 2 },
  }
  const text = {
    id: "prt_text",
    sessionID,
    messageID: reply.id,
    type: "text",
    text: "Native reply completed.",
  }
  fakeOpencode(() => ({
    early: [status("busy"), updated(reply)],
    late: [
      {
        type: "message.part.updated",
        properties: { sessionID, part: text },
      },
      updated(reply),
      status("idle"),
    ],
    reply,
    parts: [text],
  }))

  const { result, receivedAtResolve } = await promptOnce()

  expect(result.message.id).toBe(reply.id)
  expect(receivedAtResolve).toContain("message.part.updated")
})

it("resolves an errored prompt at the idle that follows its error update", async () => {
  // When a model call fails or the user aborts, OpenCode sets the session idle
  // before it writes the error to the reply. It sets the session idle again
  // when the run stops.
  const toolStep = {
    id: "msg_tool_step",
    sessionID,
    role: "assistant",
    finish: "tool-calls",
    time: { created: 1, completed: 2 },
  }
  const pending = {
    id: "msg_reply",
    sessionID,
    role: "assistant",
    time: { created: 3 },
  }
  const failed = {
    ...pending,
    time: { created: 3, completed: 4 },
    error: { name: "APIError", data: { message: "Invalid API key" } },
  }
  fakeOpencode(() => ({
    early: [
      status("busy"),
      updated(toolStep),
      status("busy"),
      updated(pending),
      {
        type: "session.error",
        properties: { sessionID, error: failed.error },
      },
      status("idle"),
    ],
    late: [updated(failed), status("idle")],
    reply: failed,
    parts: [],
  }))

  const { result, receivedAtResolve } = await promptOnce()

  expect(result.message.error).toEqual(failed.error)
  expect(receivedAtResolve.filter((type) => type === "session.status")).toEqual(
    ["session.status", "session.status", "session.status", "session.status"],
  )
})
