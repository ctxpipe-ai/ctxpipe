import { createHmac } from "node:crypto"
import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../../app/env.js"
import { parseEnv } from "../../../config/env.js"
import {
  linearEntityTargetForPayload,
  registerLinearWebhookRoute,
} from "./linear.js"

const mocks = vi.hoisted(() => ({
  listConnections: vi.fn(),
  getSyncTarget: vi.fn(),
  recordRevocation: vi.fn(),
  runWorkflow: vi.fn(),
}))

vi.mock("../../../models/linear-connector.js", () => ({
  getLinearBindingByConnectionId: mocks.getSyncTarget,
  listLinearConnectionsByWorkspaceId: mocks.listConnections,
  recordLinearOAuthRevocation: mocks.recordRevocation,
}))
vi.mock("../../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: mocks.runWorkflow,
}))
vi.mock("../../../openworkflow/workflows/linear-sync-entity.js", () => ({
  linearSyncEntity: { spec: { name: "linear-sync-entity" } },
}))

const secret = "linear-webhook-secret"
const env = parseEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost:5432/ctxpipe",
  AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
  LINEAR_WEBHOOK_SECRET: secret,
} as Record<string, string | undefined>)

function createTestApp() {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("env", env)
    c.set("log", {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    } as unknown as AppEnv["Variables"]["log"])
    await next()
  })
  registerLinearWebhookRoute(app)
  return app
}

function signedRequest(payload: Record<string, unknown>) {
  const body = JSON.stringify(payload)
  return {
    body,
    signature: createHmac("sha256", secret).update(body).digest("hex"),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listConnections.mockResolvedValue([
    { id: "con_linear", orgId: "org_1", status: "installed" },
  ])
  mocks.getSyncTarget.mockResolvedValue({
    enabled: true,
    setupPhase: "live",
  })
  mocks.recordRevocation.mockResolvedValue(undefined)
  mocks.runWorkflow.mockResolvedValue({ workflowRun: { id: "run_1" } })
})

describe("POST /api/v1/webhook/linear", () => {
  it("verifies the raw body and enqueues a comment event for its issue", async () => {
    const webhookTimestamp = Date.now()
    const request = signedRequest({
      type: "Comment",
      action: "update",
      organizationId: "workspace-1",
      webhookTimestamp,
      data: { id: "comment-1", issueId: "issue-1" },
    })

    const response = await createTestApp().request("/api/v1/webhook/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": request.signature,
      },
      body: request.body,
    })

    expect(response.status).toBe(200)
    expect(mocks.listConnections).toHaveBeenCalledWith("workspace-1", env)
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      { name: "linear-sync-entity" },
      {
        orgId: "org_1",
        connectionId: "con_linear",
        entityType: "issue",
        externalId: "issue-1",
        action: "upsert",
      },
    )
  })

  it("rejects a correctly signed but stale event", async () => {
    const request = signedRequest({
      type: "Issue",
      action: "update",
      organizationId: "workspace-1",
      webhookTimestamp: Date.now() - 120_000,
      data: { id: "issue-1" },
    })
    const response = await createTestApp().request("/api/v1/webhook/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": request.signature,
      },
      body: request.body,
    })

    expect(response.status).toBe(401)
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
  })

  it("records OAuth revocation without enqueueing content sync", async () => {
    const payload = {
      type: "OAuthApp",
      action: "revoked",
      organizationId: "workspace-1",
      oauthClientId: "oauth-client",
      webhookTimestamp: Date.now(),
    }
    const request = signedRequest(payload)
    const response = await createTestApp().request("/api/v1/webhook/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": request.signature,
      },
      body: request.body,
    })

    expect(response.status).toBe(200)
    expect(mocks.recordRevocation).toHaveBeenCalledWith({
      connectionId: "con_linear",
      env,
      payload,
    })
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: "the target is disabled",
      connection: { id: "con_linear", orgId: "org_1", status: "installed" },
      target: { enabled: false, setupPhase: "live" },
    },
    {
      name: "setup is not live",
      connection: { id: "con_linear", orgId: "org_1", status: "installed" },
      target: { enabled: true, setupPhase: "awaiting_merge" },
    },
  ])("ignores entity updates when $name", async ({ connection, target }) => {
    mocks.listConnections.mockResolvedValueOnce([connection])
    mocks.getSyncTarget.mockResolvedValue(target)
    const request = signedRequest({
      type: "Issue",
      action: "update",
      organizationId: "workspace-1",
      webhookTimestamp: Date.now(),
      data: { id: "issue-1" },
    })

    const response = await createTestApp().request("/api/v1/webhook/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": request.signature,
      },
      body: request.body,
    })

    expect(response.status).toBe(200)
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: "initial sync is running",
      connection: { id: "con_linear", orgId: "org_1", status: "installed" },
      target: { enabled: true, setupPhase: "initial_sync" },
    },
    {
      name: "OAuth is revoked",
      connection: { id: "con_linear", orgId: "org_1", status: "revoked" },
      target: { enabled: true, setupPhase: "live" },
    },
  ])("skips entity updates when $name", async ({ connection, target }) => {
    mocks.listConnections.mockResolvedValueOnce([connection])
    mocks.getSyncTarget.mockResolvedValue(target)
    const request = signedRequest({
      type: "Issue",
      action: "update",
      organizationId: "workspace-1",
      webhookTimestamp: Date.now(),
      data: { id: "issue-1" },
    })

    const response = await createTestApp().request("/api/v1/webhook/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": request.signature,
      },
      body: request.body,
    })

    expect(response.status).toBe(200)
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
  })
})

describe("linearEntityTargetForPayload", () => {
  it("maps child updates to their mirrored parent and root removals to deletes", () => {
    expect(
      linearEntityTargetForPayload({
        type: "ProjectUpdate",
        action: "remove",
        data: { id: "update-1", projectId: "project-1" },
      }),
    ).toEqual({
      entityType: "project",
      externalId: "project-1",
      action: "upsert",
    })
    expect(
      linearEntityTargetForPayload({
        type: "Document",
        action: "remove",
        data: { id: "document-1" },
      }),
    ).toEqual({
      entityType: "document",
      externalId: "document-1",
      action: "delete",
    })
    expect(
      linearEntityTargetForPayload({
        type: "Team",
        action: "update",
        data: { id: "team-1" },
      }),
    ).toEqual({
      entityType: "team",
      externalId: "team-1",
      action: "upsert",
    })
  })
})
