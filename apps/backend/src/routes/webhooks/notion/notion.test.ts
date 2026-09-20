import { createHmac } from "node:crypto"
import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../../app/env.js"
import { parseNotionConnectionConfig } from "../../../lib/connection-config.js"
import { encryptConnectionSecret } from "../../../lib/connection-secrets.js"

const connectionsMock = vi.hoisted(() => vi.fn())
const getRowMock = vi.hoisted(() => vi.fn())
const persistSecretMock = vi.hoisted(() => vi.fn())
const runWorkflowMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const notionClientSecret = "notion-client-secret"
const webhookSecret = "notion-webhook-secret"
const AUTH_SECRET = "test-secret-at-least-32-characters-long-xx"
const provisioningToken = createHmac("sha256", notionClientSecret)
  .update("ctxpipe:notion-webhook-provisioning:v1")
  .digest("base64url")

vi.mock("../../../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../../../models/notion-connector.js", () => ({
  listNotionConnectionsForWebhook: connectionsMock,
  getNotionConnectionRowById: getRowMock,
  persistNotionWebhookSecret: persistSecretMock,
}))
vi.mock("../../../observability/logger.js", () => ({
  getLogger: () => ({ error: vi.fn(), info: vi.fn() }),
}))
vi.mock("../../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowMock,
}))
vi.mock("../../../openworkflow/workflows/notion-sync-entity.js", () => ({
  notionSyncEntity: { spec: { name: "notion-sync-entity" } },
}))

import type { NotionConnection } from "../../../models/notion-connector.js"
import { registerNotionWebhookRoute } from "./notion.js"

const envBase = {
  AUTH_SECRET,
  NOTION_CLIENT_SECRET: notionClientSecret,
} as AppEnv["Variables"]["env"]

const connection = {
  id: "con_1",
  orgId: "org_1",
  botId: "bot_1",
  workspaceId: "workspace_1",
  repositoryId: "repo_1",
  branch: "main",
  enabled: true,
  setupPhase: "live",
} as NotionConnection

function candidate(
  connectionOverrides: Partial<NotionConnection> = {},
  stored: Record<string, unknown> = {},
) {
  return {
    connection: { ...connection, ...connectionOverrides } as NotionConnection,
    stored: parseNotionConnectionConfig(stored),
  }
}

function testApp(
  options: {
    webhookSecret?: string
    clientSecret?: string
  } = { webhookSecret },
) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("env", {
      ...envBase,
      NOTION_CLIENT_SECRET: options.clientSecret ?? notionClientSecret,
      NOTION_WEBHOOK_SECRET: options.webhookSecret,
    } as AppEnv["Variables"]["env"])
    await next()
  })
  registerNotionWebhookRoute(app as never)
  return app
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}

describe("Notion webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connectionsMock.mockResolvedValue([candidate()])
    runWorkflowMock.mockResolvedValue(undefined)
    persistSecretMock.mockResolvedValue("ok")
  })

  it("acknowledges provisioning verification without persisting", async () => {
    const response = await testApp({ webhookSecret: undefined }).request(
      `/api/v1/webhook/notion?provisioningToken=${provisioningToken}`,
      {
        method: "POST",
        body: JSON.stringify({ verification_token: "verify-me" }),
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ verified: true })
    expect(persistSecretMock).not.toHaveBeenCalled()
  })

  it("accepts a verification token that matches the configured secret", async () => {
    const response = await testApp({ webhookSecret: "verify-me" }).request(
      `/api/v1/webhook/notion?provisioningToken=${provisioningToken}`,
      {
        method: "POST",
        body: JSON.stringify({ verification_token: "verify-me" }),
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ verified: true })
  })

  it("rejects a verification token that differs from a configured secret", async () => {
    const response = await testApp({ webhookSecret: "already-set" }).request(
      `/api/v1/webhook/notion?provisioningToken=${provisioningToken}`,
      {
        method: "POST",
        body: JSON.stringify({ verification_token: "different-token" }),
      },
    )

    expect(response.status).toBe(409)
  })

  it("rejects unsigned verification-token provisioning", async () => {
    const response = await testApp({ webhookSecret: undefined }).request(
      "/api/v1/webhook/notion",
      {
        method: "POST",
        body: JSON.stringify({ verification_token: "attacker-token" }),
      },
    )

    expect(response.status).toBe(401)
  })

  it("accepts row-only provisioning and stores the token on that row", async () => {
    getRowMock.mockResolvedValue({
      id: "con_draft",
      orgId: "org_1",
      type: "notion",
      config: {
        oauthClientId: "row-id",
        oauthClientSecretEnc: encryptConnectionSecret(
          "row-client-secret",
          envBase,
        ),
      },
    })
    const token = createHmac("sha256", "row-client-secret")
      .update("ctxpipe:notion-webhook-provisioning:v1")
      .digest("base64url")

    const response = await testApp({
      webhookSecret: undefined,
      clientSecret: undefined,
    }).request(
      `/api/v1/webhook/notion?connectionId=con_draft&provisioningToken=${token}`,
      {
        method: "POST",
        body: JSON.stringify({ verification_token: "row-verify" }),
      },
    )

    expect(response.status).toBe(200)
    expect(persistSecretMock).toHaveBeenCalledWith({
      connectionId: "con_draft",
      env: expect.objectContaining({ AUTH_SECRET }),
      verificationToken: "row-verify",
    })
  })

  it("rejects query-scoped provisioning that only matches the env client secret", async () => {
    getRowMock.mockResolvedValue({
      id: "con_draft",
      orgId: "org_1",
      type: "notion",
      config: { setupPhase: "draft" },
    })
    const response = await testApp({ webhookSecret: undefined }).request(
      `/api/v1/webhook/notion?connectionId=con_draft&provisioningToken=${provisioningToken}`,
      {
        method: "POST",
        body: JSON.stringify({ verification_token: "verify-me" }),
      },
    )
    expect(response.status).toBe(401)
    expect(persistSecretMock).not.toHaveBeenCalled()
  })

  it("rejects provisioning with the wrong connectionId or token", async () => {
    getRowMock.mockResolvedValue(undefined)
    const response = await testApp({ webhookSecret: undefined }).request(
      `/api/v1/webhook/notion?connectionId=missing&provisioningToken=${provisioningToken}`,
      {
        method: "POST",
        body: JSON.stringify({ verification_token: "verify-me" }),
      },
    )
    expect(response.status).toBe(401)
    expect(persistSecretMock).not.toHaveBeenCalled()
  })

  it("verifies signed changes and enqueues an entity-scoped sync", async () => {
    const body = JSON.stringify({
      id: "event_1",
      integration_id: "bot_1",
      type: "page.content_updated",
      entity: { id: "page_1", type: "page" },
    })

    const response = await testApp().request("/api/v1/webhook/notion", {
      method: "POST",
      headers: { "x-notion-signature": sign(body, webhookSecret) },
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

  it("verifies a signed event with a row webhook secret when env is empty", async () => {
    connectionsMock.mockResolvedValue([
      candidate(
        {},
        {
          webhookSecretEnc: encryptConnectionSecret("row-hook", envBase),
        },
      ),
    ])
    const body = JSON.stringify({
      id: "event_row",
      workspace_id: "workspace_1",
      type: "page.content_updated",
      entity: { id: "page_1", type: "page" },
    })

    const response = await testApp({ webhookSecret: undefined }).request(
      "/api/v1/webhook/notion",
      {
        method: "POST",
        headers: { "x-notion-signature": sign(body, "row-hook") },
        body,
      },
    )

    expect(response.status).toBe(200)
    expect(runWorkflowMock).toHaveBeenCalledWith(
      { name: "notion-sync-entity" },
      expect.objectContaining({ connectionId: "con_1" }),
      { idempotencyKey: "notion:con_1:event_row" },
    )
  })

  it("does not let a second org's secret authorize the first row", async () => {
    connectionsMock.mockResolvedValue([
      candidate(
        { id: "con_org_a", orgId: "org_a" },
        {
          webhookSecretEnc: encryptConnectionSecret("secret-a", envBase),
        },
      ),
      candidate(
        { id: "con_org_b", orgId: "org_b" },
        {
          webhookSecretEnc: encryptConnectionSecret("secret-b", envBase),
        },
      ),
    ])
    const body = JSON.stringify({
      id: "event_cross",
      workspace_id: "workspace_1",
      type: "page.content_updated",
      entity: { id: "page_1", type: "page" },
    })

    const response = await testApp({ webhookSecret: undefined }).request(
      "/api/v1/webhook/notion",
      {
        method: "POST",
        headers: { "x-notion-signature": sign(body, "secret-b") },
        body,
      },
    )

    expect(response.status).toBe(200)
    expect(runWorkflowMock).toHaveBeenCalledTimes(1)
    expect(runWorkflowMock).toHaveBeenCalledWith(
      { name: "notion-sync-entity" },
      expect.objectContaining({
        orgId: "org_b",
        connectionId: "con_org_b",
      }),
      { idempotencyKey: "notion:con_org_b:event_cross" },
    )
  })

  it("does not let the hosted env secret authorize a row with its own secret", async () => {
    connectionsMock.mockResolvedValue([
      candidate(
        { id: "con_self_host", orgId: "org_a" },
        {
          webhookSecretEnc: encryptConnectionSecret("secret-a", envBase),
        },
      ),
    ])
    const body = JSON.stringify({
      id: "event_env",
      workspace_id: "workspace_1",
      type: "page.content_updated",
      entity: { id: "page_1", type: "page" },
    })

    const response = await testApp({ webhookSecret: "hosted-env-secret" }).request(
      "/api/v1/webhook/notion",
      {
        method: "POST",
        headers: { "x-notion-signature": sign(body, "hosted-env-secret") },
        body,
      },
    )

    expect(response.status).toBe(401)
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("maps data_source deletions to a data_source-scoped delete", async () => {
    const body = JSON.stringify({
      id: "event_2",
      workspace_id: "workspace_1",
      type: "data_source.deleted",
      entity: { id: "ds_1", type: "data_source" },
    })

    const response = await testApp().request("/api/v1/webhook/notion", {
      method: "POST",
      headers: { "x-notion-signature": sign(body, webhookSecret) },
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

  it("returns 503 for signed events when no env or row webhook secret is present", async () => {
    const body = JSON.stringify({
      id: "event_1",
      integration_id: "bot_1",
      type: "page.content_updated",
      entity: { id: "page_1", type: "page" },
    })

    const response = await testApp({ webhookSecret: undefined }).request(
      "/api/v1/webhook/notion",
      {
        method: "POST",
        headers: { "x-notion-signature": sign(body, "any-secret") },
        body,
      },
    )

    expect(response.status).toBe(503)
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("rejects events with an invalid signature", async () => {
    const body = JSON.stringify({
      id: "event_1",
      integration_id: "bot_1",
      type: "page.content_updated",
      entity: { id: "page_1", type: "page" },
    })

    const response = await testApp().request("/api/v1/webhook/notion", {
      method: "POST",
      headers: { "x-notion-signature": sign(body, "wrong-secret") },
      body,
    })

    expect(response.status).toBe(401)
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("asks Notion to retry when sync enqueue fails", async () => {
    runWorkflowMock.mockRejectedValueOnce(new Error("worker unavailable"))
    const body = JSON.stringify({
      integration_id: "bot_1",
      workspace_id: "workspace_1",
      type: "page.content_updated",
      entity: { id: "page_1", type: "page" },
    })

    const response = await testApp().request("/api/v1/webhook/notion", {
      method: "POST",
      headers: { "x-notion-signature": sign(body, webhookSecret) },
      body,
    })

    expect(response.status).toBe(503)
  })

  it("ignores events that do not identify a workspace or integration", async () => {
    const body = JSON.stringify({
      id: "event_1",
      type: "page.content_updated",
      entity: { id: "page_1", type: "page" },
    })

    const response = await testApp().request("/api/v1/webhook/notion", {
      method: "POST",
      headers: { "x-notion-signature": sign(body, webhookSecret) },
      body,
    })

    expect(response.status).toBe(204)
    expect(connectionsMock).not.toHaveBeenCalled()
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("skips connections that are not live using connections.config binding", async () => {
    connectionsMock.mockResolvedValue([
      candidate({ setupPhase: "awaiting_merge" }),
    ])
    const body = JSON.stringify({
      workspace_id: "workspace_1",
      type: "page.content_updated",
      entity: { id: "page_1", type: "page" },
    })

    const response = await testApp().request("/api/v1/webhook/notion", {
      method: "POST",
      headers: { "x-notion-signature": sign(body, webhookSecret) },
      body,
    })

    expect(response.status).toBe(204)
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("no longer exposes the legacy per-connection route", async () => {
    const body = JSON.stringify({
      id: "event_1",
      integration_id: "bot_1",
      type: "page.content_updated",
      entity: { id: "page_1", type: "page" },
    })

    const response = await testApp().request("/api/v1/webhook/notion/con_1", {
      method: "POST",
      headers: { "x-notion-signature": sign(body, webhookSecret) },
      body,
    })

    expect(response.status).toBe(404)
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })
})
