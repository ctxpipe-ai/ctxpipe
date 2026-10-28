import { startOpencodeSession } from "@tanstack/ai-opencode"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, expect, it } from "vitest"

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterAll(() => server.close())

it("resolves a prompt only after the event stream sent the text of its reply (CTX-1061)", async () => {
  // OpenCode serializes a message.updated event when it writes the event, not
  // when it publishes it. When the event stream is slow, the first update of
  // the reply already shows the reply as finished, and its text comes later.
  // This fake OpenCode sends the events in that order and answers the prompt
  // before the text.
  const base = "http://opencode.test"
  const encoder = new TextEncoder()
  let events!: ReadableStreamDefaultController<Uint8Array>
  const send = (type: string, properties: Record<string, unknown>) =>
    events.enqueue(
      encoder.encode(`data: ${JSON.stringify({ type, properties })}\n\n`),
    )
  const sessionID = "ses_fixture"
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
  server.use(
    http.get(`${base}/event`, () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          events = controller
          send("server.connected", {})
        },
      })
      return new HttpResponse(body, {
        headers: { "content-type": "text/event-stream" },
      })
    }),
    http.post(`${base}/session`, () => HttpResponse.json({ id: sessionID })),
    http.post(`${base}/session/:id/message`, () => {
      send("session.status", { sessionID, status: { type: "busy" } })
      send("message.updated", { sessionID, info: reply })
      // The text and the final events come after the prompt answer.
      setTimeout(() => {
        send("message.part.updated", { sessionID, part: text })
        send("message.updated", { sessionID, info: reply })
        send("session.status", { sessionID, status: { type: "idle" } })
      }, 50)
      return HttpResponse.json({ info: reply, parts: [text] })
    }),
  )
  const received: Array<{ type: string }> = []
  const session = await startOpencodeSession({
    baseUrl: base,
    providerID: "synthetic",
    modelID: "probe",
    onEvent: (event) => received.push(event),
    onPermissionRequest: () => "reject",
  })
  try {
    const result = await session.prompt("Question")
    expect(result.message.id).toBe(reply.id)
    expect(received.map((event) => event.type)).toContain(
      "message.part.updated",
    )
  } finally {
    await session.dispose()
  }
})
