import { createHmac } from "node:crypto"
import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../../app/env.js"

const connectionMock = vi.hoisted(() => vi.fn())
const connectionsMock = vi.hoisted(() => vi.fn())
const appVerificationMock = vi.hoisted(() => vi.fn())
const verificationMock = vi.hoisted(() => vi.fn())
const verificationConfigMock = vi.hoisted(() => vi.fn())
const runWorkflowMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const notionClientSecret = "notion-client-secret"
const provisioningToken = createHmac("sha256", notionClientSecret)
  .update("ctxpipe:notion-webhook-provisioning:v1")
  .digest("base64url")

vi.mock("../../../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../../../models/notion-connector.js", () => ({
  getNotionConnectionForWebhook: connectionMock,
  getNotionWebhookVerificationToken: appVerificationMock,
  listNotionConnectionsForWebhook: connectionsMock,
  storeNotionWebhookVerificationConfig: verificationConfigMock,
  updateNotionWebhookVerificationToken: verificationMock,
}))
vi.mock("../../../observability/logger.js", () => ({
  getLogger: () => ({ error: vi.fn() }),
}))
vi.mock("../../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowMock,
}))
vi.mock("../../../openworkflow/workflows/notion-sync-entity.js", () => ({
  notionSyncEntity: { spec: { name: "notion-sync-entity" } },
}))

import type { NotionConnection } from "../../../models/notion-connector.js"
import { registerNotionWebhookRoute } from "./notion.js"

const connection = {
  id: "con_1",
  orgId: "org_1",
  botId: "bot_1",
  workspaceId: "workspace_1",
  webhookVerificationToken: null,
  repositoryId: "repo_1",
  branch: "main",
  enabled: true,
  setupPhase: "live",
} as NotionConnection

function testApp() {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("env", {
      NOTION_CLIENT_SECRET: notionClientSecret,
    } as AppEnv["Variables"]["env"])
    await next()
  })
  registerNotionWebhookRoute(app as never)
  return app
}

describe("Notion webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connectionMock.mockResolvedValue(connection)
    connectionsMock.mockResolvedValue([connection])
    runWorkflowMock.mockResolvedValue(undefined)
    appVerificationMock.mockResolvedValue(null)
  })

  it("stores the one-time verification token", async () => {
    const response = await testApp().request(
      `/api/v1/webhook/notion/con_1?provisioningToken=${provisioningToken}`,
      {
        method: "POST",
        body: JSON.stringify({ verification_token: "verify-me" }),
      },
    )

    expect(response.status).toBe(200)
    expect(verificationMock).toHaveBeenCalledWith({
      orgId: "org_1",
      connectionId: "con_1",
      verificationToken: "verify-me",
    })
  })

  it("verifies signed changes and enqueues an entity-scoped sync", async () => {
    const signedConnection = {
      ...connection,
      webhookVerificationToken: "verify-me",
    } as NotionConnection
    connectionMock.mockResolvedValue(signedConnection)
    connectionsMock.mockResolvedValue([signedConnection])
    const body = JSON.stringify({
      id: "event_1",
      integration_id: "bot_1",
      type: "page.content_updated",
      entity: { id: "page_1", type: "page" },
    })
    const signature = `sha256=${createHmac("sha256", "verify-me")
      .update(body)
      .digest("hex")}`

    const response = await testApp().request("/api/v1/webhook/notion", {
      method: "POST",
      headers: { "x-notion-signature": signature },
      body,
    })

    expect(response.status).toBe(200)
    expect(runWorkflowMock).toHaveBeenCalledWith(
      { name: "notion-sync-entity" },
      {
        orgId: "org_1",
        connectionId: "con_1",
        entityType: "page",
        externalId: "page_1",
        action: "upsert",
        eventId: "event_1",
      },
      { idempotencyKey: "notion:con_1:event_1" },
    )
  })

  it("maps data_source deletions to a database-scoped delete", async () => {
    appVerificationMock.mockResolvedValue("app-token")
    const body = JSON.stringify({
      id: "event_2",
      workspace_id: "workspace_1",
      type: "data_source.deleted",
      entity: { id: "ds_1", type: "data_source" },
    })
    const signature = `sha256=${createHmac("sha256", "app-token")
      .update(body)
      .digest("hex")}`

    const response = await testApp().request("/api/v1/webhook/notion", {
      method: "POST",
      headers: { "x-notion-signature": signature },
      body,
    })

    expect(response.status).toBe(200)
    expect(runWorkflowMock).toHaveBeenCalledWith(
      { name: "notion-sync-entity" },
      {
        orgId: "org_1",
        connectionId: "con_1",
        entityType: "data_source",
        externalId: "ds_1",
        action: "delete",
        eventId: "event_2",
      },
      { idempotencyKey: "notion:con_1:event_2" },
    )
  })

  it("stores app-level verification tokens", async () => {
    const response = await testApp().request(
      `/api/v1/webhook/notion?provisioningToken=${provisioningToken}`,
      {
        method: "POST",
        body: JSON.stringify({ verification_token: "verify-me" }),
      },
    )

    expect(response.status).toBe(200)
    expect(verificationConfigMock).toHaveBeenCalledWith("verify-me", null)
  })

  it("rejects unsigned verification-token provisioning", async () => {
    const response = await testApp().request("/api/v1/webhook/notion", {
      method: "POST",
      body: JSON.stringify({ verification_token: "attacker-token" }),
    })

    expect(response.status).toBe(401)
    expect(verificationConfigMock).not.toHaveBeenCalled()
  })

  it("accepts the app token without a tenant-local copy", async () => {
    appVerificationMock.mockResolvedValue("app-token")
    const body = JSON.stringify({
      integration_id: "other-integration-id",
      workspace_id: "workspace_1",
      type: "page.content_updated",
      entity: { id: "page_1", type: "page" },
    })
    const signature = `sha256=${createHmac("sha256", "app-token")
      .update(body)
      .digest("hex")}`

    const response = await testApp().request("/api/v1/webhook/notion", {
      method: "POST",
      headers: { "x-notion-signature": signature },
      body,
    })

    expect(response.status).toBe(200)
    expect(runWorkflowMock).toHaveBeenCalled()
  })

  it("asks Notion to retry when sync enqueue fails", async () => {
    const signedConnection = {
      ...connection,
      webhookVerificationToken: "verify-me",
    } as NotionConnection
    connectionsMock.mockResolvedValue([signedConnection])
    runWorkflowMock.mockRejectedValueOnce(new Error("worker unavailable"))
    const body = JSON.stringify({
      integration_id: "bot_1",
      workspace_id: "workspace_1",
      type: "page.content_updated",
      entity: { id: "page_1", type: "page" },
    })
    const signature = `sha256=${createHmac("sha256", "verify-me")
      .update(body)
      .digest("hex")}`

    const response = await testApp().request("/api/v1/webhook/notion", {
      method: "POST",
      headers: { "x-notion-signature": signature },
      body,
    })

    expect(response.status).toBe(503)
  })

  it("ignores events that do not identify a workspace or integration", async () => {
    appVerificationMock.mockResolvedValue("app-token")
    const body = JSON.stringify({
      id: "event_1",
      type: "page.content_updated",
      entity: { id: "page_1", type: "page" },
    })
    const signature = `sha256=${createHmac("sha256", "app-token")
      .update(body)
      .digest("hex")}`

    const response = await testApp().request("/api/v1/webhook/notion", {
      method: "POST",
      headers: { "x-notion-signature": signature },
      body,
    })

    expect(response.status).toBe(204)
    expect(connectionsMock).not.toHaveBeenCalled()
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("skips connections that are not live using connections.config binding", async () => {
    appVerificationMock.mockResolvedValue("app-token")
    connectionsMock.mockResolvedValue([
      {
        ...connection,
        setupPhase: "awaiting_merge",
      } as NotionConnection,
    ])
    const body = JSON.stringify({
      workspace_id: "workspace_1",
      type: "page.content_updated",
      entity: { id: "page_1", type: "page" },
    })
    const signature = `sha256=${createHmac("sha256", "app-token")
      .update(body)
      .digest("hex")}`

    const response = await testApp().request("/api/v1/webhook/notion", {
      method: "POST",
      headers: { "x-notion-signature": signature },
      body,
    })

    expect(response.status).toBe(204)
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })
})
