import { createHmac } from "node:crypto"
import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"

const connectionMock = vi.hoisted(() => vi.fn())
const connectionsMock = vi.hoisted(() => vi.fn())
const appVerificationMock = vi.hoisted(() => vi.fn())
const targetMock = vi.hoisted(() => vi.fn())
const slugMock = vi.hoisted(() => vi.fn())
const verificationMock = vi.hoisted(() => vi.fn())
const verificationConfigMock = vi.hoisted(() => vi.fn())
const runWorkflowMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock("../../../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../../../models/notion-connector.js", () => ({
  getNotionConnectionForWebhook: connectionMock,
  getNotionWebhookVerificationToken: appVerificationMock,
  listNotionConnectionsForWebhook: connectionsMock,
  getNotionSyncTargetByConnectionId: targetMock,
  getOrganizationSlugForNotionOrgId: slugMock,
  updateNotionWebhookVerificationToken: verificationMock,
  upsertNotionWebhookVerificationConfig: verificationConfigMock,
}))
vi.mock("../../../observability/logger.js", () => ({
  getLogger: () => ({ error: vi.fn() }),
}))
vi.mock("../../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowMock,
}))
vi.mock("../../../openworkflow/notion-sync-content.js", () => ({
  notionSyncContent: { spec: { name: "notion-sync-content" } },
}))

import type { NotionConnection } from "../../../models/notion-connector.js"
import { registerNotionWebhookRoute } from "./notion.js"

const connection = {
  id: "con_1",
  orgId: "org_1",
  botId: "bot_1",
  workspaceId: "workspace_1",
  webhookVerificationToken: null,
} as NotionConnection

function testApp() {
  const app = new Hono()
  registerNotionWebhookRoute(app as never)
  return app
}

describe("Notion webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connectionMock.mockResolvedValue(connection)
    connectionsMock.mockResolvedValue([connection])
    slugMock.mockResolvedValue("acme")
    targetMock.mockResolvedValue({ enabled: true, setupPhase: "live" })
    runWorkflowMock.mockResolvedValue(undefined)
    appVerificationMock.mockResolvedValue(null)
  })

  it("stores the one-time verification token", async () => {
    const response = await testApp().request("/api/v1/webhook/notion/con_1", {
      method: "POST",
      body: JSON.stringify({ verification_token: "verify-me" }),
    })

    expect(response.status).toBe(200)
    expect(verificationMock).toHaveBeenCalledWith({
      orgId: "org_1",
      connectionId: "con_1",
      verificationToken: "verify-me",
    })
  })

  it("verifies signed changes and enqueues a full scoped sync", async () => {
    const signedConnection = {
      ...connection,
      webhookVerificationToken: "verify-me",
    } as NotionConnection
    connectionMock.mockResolvedValue(signedConnection)
    connectionsMock.mockResolvedValue([signedConnection])
    const body = JSON.stringify({
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
      { name: "notion-sync-content" },
      { orgId: "org_1", orgSlug: "acme", connectionId: "con_1" },
    )
  })

  it("stores app-level verification tokens", async () => {
    const response = await testApp().request("/api/v1/webhook/notion", {
      method: "POST",
      body: JSON.stringify({ verification_token: "verify-me" }),
    })

    expect(response.status).toBe(200)
    expect(verificationConfigMock).toHaveBeenCalledWith("verify-me", null)
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
})
