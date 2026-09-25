import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"

vi.mock("../../graphs/index.js", () => ({
  conversationGraph: { stream: vi.fn() },
}))

vi.mock("../../observability/langfuse.js", () => ({
  runWithLangfuseContext: vi.fn(
    async () => new Response(null, { status: 200 }),
  ),
  getLangfuseHandler: vi.fn(() => ({})),
}))

import { attributionRecorder } from "../../../test/recordingSpan.js"
import { createDataStreamConversationTransport } from "./transport.js"

function appForActor(assign: (c: { set: Hono<AppEnv>["set"] }) => void): {
  app: Hono<AppEnv>
  attributes: () => Record<string, unknown>
} {
  const recorded = attributionRecorder()
  const app = new Hono<AppEnv>()
  app.use(contextStorage())
  app.use(recorded.middleware)
  app.post("/message", async (c) => {
    c.set("orgId", "org_acme")
    c.set("orgSlug", "acme")
    assign(c)
    return createDataStreamConversationTransport().toResponse({
      conversationId: "conv_1",
      checkpointNamespace: "",
      prompt: "hello",
      userId: c.get("user")?.id,
    })
  })
  return { app, attributes: recorded.attributes }
}

describe("conversation transport actor", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("keeps an oauth client actor", async () => {
    const { app, attributes } = appForActor((c) => {
      c.set("user", { id: "user_oauth" } as AppEnv["Variables"]["user"])
      c.set("session", { id: "sess_oauth" } as AppEnv["Variables"]["session"])
      c.set("oauthClientId", "client_oauth")
      c.set("oauthOrganizationId", "org_acme")
      c.set("orgApiKey", null)
    })

    const response = await app.request("/message", { method: "POST" })

    expect(response.status).toBe(200)
    expect(attributes()["ctxpipe.actor.type"]).toBe("oauth_client")
    expect(attributes()["ctxpipe.conversation.id"]).toBe("conv_1")
    expect(attributes()["enduser.id"]).toBe("user_oauth")
  })

  it("keeps an org api key actor", async () => {
    const { app, attributes } = appForActor((c) => {
      c.set("user", null)
      c.set("session", null)
      c.set("oauthClientId", null)
      c.set("oauthOrganizationId", null)
      c.set("orgApiKey", {
        id: "key_org",
        orgId: "org_acme",
        configId: "organization",
      })
    })

    const response = await app.request("/message", { method: "POST" })

    expect(response.status).toBe(200)
    expect(attributes()["ctxpipe.actor.type"]).toBe("org_api_key")
    expect(attributes()["enduser.id"]).toBeUndefined()
  })

  it("attributes a user actor", async () => {
    const { app, attributes } = appForActor((c) => {
      c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
      c.set("session", { id: "sess_1" } as AppEnv["Variables"]["session"])
      c.set("oauthClientId", null)
      c.set("oauthOrganizationId", null)
      c.set("orgApiKey", null)
    })

    const response = await app.request("/message", { method: "POST" })

    expect(response.status).toBe(200)
    expect(attributes()["ctxpipe.actor.type"]).toBe("user")
    expect(attributes()["enduser.id"]).toBe("user_1")
  })
})
