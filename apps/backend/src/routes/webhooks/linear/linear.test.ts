import { createHmac } from "node:crypto"
import { OpenAPIHono } from "@hono/zod-openapi"
import { context, trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { createLogger } from "evlog"
import type { MiddlewareHandler } from "hono"
import { contextStorage } from "hono/context-storage"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import type { AppEnv } from "../../../app/env.js"
import { parseEnv } from "../../../config/env.js"
import {
  linearEntityTargetForPayload,
  registerLinearWebhookRoute,
} from "./linear.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

beforeAll(() => {
  provider.register()
})

afterAll(async () => {
  await provider.shutdown()
})

function withRequestSpan(): MiddlewareHandler {
  return async (_c, next) => {
    const span = trace.getTracer("ctxpipe-webhook-test").startSpan("request")
    try {
      await context.with(trace.setSpan(context.active(), span), () => next())
    } finally {
      span.end()
    }
  }
}

function requestSpanAttributes(): Record<string, unknown> {
  const span = exporter
    .getFinishedSpans()
    .find((item) => item.name === "request")
  return span ? { ...span.attributes } : {}
}

const mocks = vi.hoisted(() => ({
  listConnections: vi.fn(),
  getSyncTarget: vi.fn(),
  recordRevocation: vi.fn(),
  runWorkflow: vi.fn(),
}))

vi.mock("../../../models/linear-connector.js", () => ({
  getLinearBindingByConnectionId: mocks.getSyncTarget,
  listLinearWebhookConnectionsByWorkspaceId: mocks.listConnections,
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

function createTestApp(before?: MiddlewareHandler) {
  const app = new OpenAPIHono<AppEnv>()
  app.use(contextStorage())
  if (before) app.use("*", before)
  app.use("*", async (c, next) => {
    c.set("env", env)
    c.set("log", createLogger())
    await next()
  })
  registerLinearWebhookRoute(app)
  return app
}

function signedRequest(
  payload: Record<string, unknown>,
  signingSecret = secret,
) {
  const body = JSON.stringify(payload)
  return {
    body,
    signature: createHmac("sha256", signingSecret).update(body).digest("hex"),
  }
}

function createTestAppWithEnv(testEnv: typeof env) {
  const app = new OpenAPIHono<AppEnv>()
  app.use(contextStorage())
  app.use("*", async (c, next) => {
    c.set("env", testEnv)
    c.set("log", createLogger())
    await next()
  })
  registerLinearWebhookRoute(app)
  return app
}

beforeEach(() => {
  exporter.reset()
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

  it("returns 503 when no webhook secret exists on env or rows", async () => {
    const emptyEnv = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://localhost:5432/ctxpipe",
      AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
    } as Record<string, string | undefined>)
    mocks.listConnections.mockResolvedValueOnce([
      { id: "con_linear", orgId: "org_1", status: "installed" },
    ])
    const request = signedRequest({
      type: "Issue",
      action: "update",
      organizationId: "workspace-1",
      webhookTimestamp: Date.now(),
      data: { id: "issue-1" },
    })
    const response = await createTestAppWithEnv(emptyEnv).request(
      "/api/v1/webhook/linear",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": request.signature,
        },
        body: request.body,
      },
    )
    expect(response.status).toBe(503)
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
  })

  it("rejects a tampered body that still has a signature", async () => {
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
      body: request.body.replace("issue-1", "issue-2"),
    })
    expect(response.status).toBe(401)
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
  })

  it("verifies only the connection whose row secret matches", async () => {
    const rowSecretA = "linear-row-secret-a"
    const rowSecretB = "linear-row-secret-b"
    mocks.listConnections.mockResolvedValueOnce([
      {
        id: "con_a",
        orgId: "org_1",
        status: "installed",
        webhookSecret: rowSecretA,
      },
      {
        id: "con_b",
        orgId: "org_2",
        status: "installed",
        webhookSecret: rowSecretB,
      },
    ])
    const webhookTimestamp = Date.now()
    const request = signedRequest(
      {
        type: "Issue",
        action: "update",
        organizationId: "workspace-1",
        webhookTimestamp,
        data: { id: "issue-1" },
      },
      rowSecretA,
    )
    const response = await createTestApp().request("/api/v1/webhook/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": request.signature,
      },
      body: request.body,
    })
    expect(response.status).toBe(200)
    expect(mocks.runWorkflow).toHaveBeenCalledTimes(1)
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      { name: "linear-sync-entity" },
      expect.objectContaining({ connectionId: "con_a", orgId: "org_1" }),
    )
  })

  it("enqueues one job per org when one workspace is connected twice", async () => {
    mocks.listConnections.mockResolvedValueOnce([
      {
        id: "con_a",
        orgId: "org_a",
        status: "installed",
        webhookSecret: secret,
      },
      {
        id: "con_b",
        orgId: "org_b",
        status: "installed",
        webhookSecret: secret,
      },
    ])
    const request = signedRequest({
      type: "Issue",
      action: "update",
      organizationId: "workspace-1",
      webhookTimestamp: Date.now(),
      data: { id: "issue-1" },
    })
    const response = await createTestApp(withRequestSpan()).request(
      "/api/v1/webhook/linear",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": request.signature,
        },
        body: request.body,
      },
    )

    expect(response.status).toBe(200)
    expect(mocks.runWorkflow).toHaveBeenCalledTimes(2)
    expect(mocks.runWorkflow).toHaveBeenNthCalledWith(
      1,
      { name: "linear-sync-entity" },
      {
        orgId: "org_a",
        connectionId: "con_a",
        entityType: "issue",
        externalId: "issue-1",
        action: "upsert",
      },
    )
    expect(mocks.runWorkflow).toHaveBeenNthCalledWith(
      2,
      { name: "linear-sync-entity" },
      {
        orgId: "org_b",
        connectionId: "con_b",
        entityType: "issue",
        externalId: "issue-1",
        action: "upsert",
      },
    )
    expect(exporter.getFinishedSpans().map((span) => span.name)).toContain(
      "request",
    )
    expect(requestSpanAttributes()["ctxpipe.org.id"]).toBeUndefined()
    expect(requestSpanAttributes()["ctxpipe.connection.id"]).toBeUndefined()
  })

  it("does not apply an env-signed webhook to rows that have their own secret", async () => {
    mocks.listConnections.mockResolvedValueOnce([
      {
        id: "con_row",
        orgId: "org_row",
        status: "installed",
        webhookSecret: "linear-row-secret-a",
      },
      {
        id: "con_env",
        orgId: "org_env",
        status: "installed",
      },
    ])
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
    expect(mocks.runWorkflow).toHaveBeenCalledTimes(1)
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      { name: "linear-sync-entity" },
      expect.objectContaining({ connectionId: "con_env", orgId: "org_env" }),
    )
  })

  it("does not revoke row-secret connections from an env-signed OAuth revocation", async () => {
    mocks.listConnections.mockResolvedValueOnce([
      {
        id: "con_row",
        orgId: "org_row",
        status: "installed",
        webhookSecret: "linear-row-secret-a",
      },
      {
        id: "con_env",
        orgId: "org_env",
        status: "installed",
      },
    ])
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
    expect(mocks.recordRevocation).toHaveBeenCalledTimes(1)
    expect(mocks.recordRevocation).toHaveBeenCalledWith({
      connectionId: "con_env",
      env,
      payload,
    })
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
