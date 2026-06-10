import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

const {
  ensureConversationMock,
  touchConversationLastMessageMock,
  recordAgentActivityEventMock,
  toPromptFromIncomingMessageMock,
  toResponseMock,
  warnMock,
} = vi.hoisted(() => ({
  ensureConversationMock: vi.fn(async () => ({})),
  touchConversationLastMessageMock: vi.fn(async () => {}),
  recordAgentActivityEventMock: vi.fn(async () => {}),
  toPromptFromIncomingMessageMock: vi.fn(() => "hello"),
  toResponseMock: vi.fn(() => new Response("stream")),
  warnMock: vi.fn(),
}))

vi.mock("../../models/conversations.js", () => ({
  deleteConversation: vi.fn(),
  ensureConversation: ensureConversationMock,
  getConversation: vi.fn(),
  listConversationsPaginated: vi.fn(),
  touchConversationLastMessage: touchConversationLastMessageMock,
  updateConversation: vi.fn(),
}))

vi.mock("../../models/agent-activity-events.js", () => ({
  recordAgentActivityEvent: recordAgentActivityEventMock,
}))

vi.mock("../../domain/conversations/transport.js", () => ({
  createDataStreamConversationTransport: () => ({ toResponse: toResponseMock }),
  loadConversationUiMessages: vi.fn(),
  toPromptFromIncomingMessage: toPromptFromIncomingMessageMock,
}))

vi.mock("../../observability/logger.js", () => ({
  getLogger: () => ({ warn: warnMock }),
}))

import { conversationRoutes } from "./conversations.js"

function appForConversations() {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
    c.set("orgId", "org_1")
    await next()
  })
  app.route("/conversations", conversationRoutes)
  return app
}

describe("conversation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureConversationMock.mockResolvedValue({})
    touchConversationLastMessageMock.mockResolvedValue(undefined)
    recordAgentActivityEventMock.mockResolvedValue(undefined)
    toPromptFromIncomingMessageMock.mockReturnValue("hello")
    toResponseMock.mockReturnValue(new Response("stream"))
  })

  it("awaits activity recording before returning the streaming response", async () => {
    let resolveRecord: () => void = () => {}
    recordAgentActivityEventMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRecord = resolve
        }),
    )

    const responsePromise = appForConversations().request(
      "/conversations/conv_1",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: { role: "user", content: "hello" },
          source: "ui",
        }),
      },
    )
    await vi.waitFor(() => {
      expect(recordAgentActivityEventMock).toHaveBeenCalledTimes(1)
    })

    expect(toResponseMock).not.toHaveBeenCalled()

    resolveRecord()
    const res = await responsePromise

    expect(res.status).toBe(200)
    expect(recordAgentActivityEventMock).toHaveBeenCalledWith({
      orgId: "org_1",
      userId: "user_1",
      source: "ui",
      eventType: "conversation.message",
      subjectId: "conv_1",
    })
    expect(toResponseMock).toHaveBeenCalledTimes(1)
  })

  it("still returns the streaming response when activity recording fails", async () => {
    recordAgentActivityEventMock.mockRejectedValueOnce(
      new Error("write failed"),
    )

    const res = await appForConversations().request("/conversations/conv_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { role: "user", content: "hello" },
        source: "knowledge-graph",
      }),
    })

    expect(res.status).toBe(200)
    expect(toResponseMock).toHaveBeenCalledTimes(1)
    expect(warnMock).toHaveBeenCalledWith(
      "dashboard_activity_event_write_failed",
      {
        error: "write failed",
        source: "knowledge-graph",
      },
    )
  })
})
