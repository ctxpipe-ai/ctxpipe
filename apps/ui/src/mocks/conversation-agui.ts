import { HttpResponse } from "msw"

export function conversationPostPath({ request }: { request: Request }) {
  return /\/api\/v1\/conversations\/[^/]+$/.test(new URL(request.url).pathname)
}

export function conversationAguiSse(events: object[]) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
}

export function conversationAguiTextEvents(input: {
  threadId: string
  runId?: string
  messageId: string
  text: string
}): object[] {
  const runId = input.runId ?? "run_1"
  return [
    { type: "RUN_STARTED", threadId: input.threadId, runId },
    {
      type: "TEXT_MESSAGE_START",
      messageId: input.messageId,
      role: "assistant",
    },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: input.messageId,
      delta: input.text,
    },
    { type: "TEXT_MESSAGE_END", messageId: input.messageId },
    { type: "RUN_FINISHED", threadId: input.threadId, runId },
  ]
}

export function conversationAguiSseResponse(events: object[]) {
  return new HttpResponse(conversationAguiSse(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}
