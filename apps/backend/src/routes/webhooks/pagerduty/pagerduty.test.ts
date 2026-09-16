import { createHmac } from "node:crypto"
import { OpenAPIHono } from "@hono/zod-openapi"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../../app/env.js"
import { parseEnv } from "../../../config/env.js"
import { encryptConnectionSecret } from "../../../lib/connection-secrets.js"
import { registerPagerdutyWebhookRoute } from "./pagerduty.js"

const mocks = vi.hoisted(() => ({
  listConnections: vi.fn(),
  getBinding: vi.fn(),
  loadConfig: vi.fn(),
  runWorkflow: vi.fn(),
}))

vi.mock("../../../models/pagerduty-connector.js", () => ({
  listPagerdutyConnectionsByWebhookSubscriptionId: mocks.listConnections,
  getPagerdutyBindingWithRepoByConnectionId: mocks.getBinding,
}))
vi.mock("../../../services/pagerduty/config-from-repo.js", () => ({
  loadPagerdutyScopeFromRepo: mocks.loadConfig,
}))
vi.mock("../../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: mocks.runWorkflow,
}))
vi.mock("../../../openworkflow/workflows/pagerduty-sync-entity.js", () => ({
  pagerdutySyncEntity: { spec: { name: "pagerduty-sync-entity" } },
}))

const env = parseEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost:5432/ctxpipe",
  AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
} as Record<string, string | undefined>)

const webhookSecret = "pagerduty-subscription-secret"
const webhookSecretEnc = encryptConnectionSecret(webhookSecret, env)

function createTestApp() {
  const app = new OpenAPIHono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("env", env)
    await next()
  })
  registerPagerdutyWebhookRoute(app)
  return app
}

function signedBody(payload: unknown) {
  const body = JSON.stringify(payload)
  return {
    body,
    signature: `v1=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`,
  }
}

const liveConnection = {
  id: "con_pd",
  orgId: "org_1",
  status: "installed",
  repositoryId: "repo_1",
  enabled: true,
  setupPhase: "live",
  webhookSecretEnc,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listConnections.mockResolvedValue([liveConnection])
  mocks.getBinding.mockResolvedValue({
    repositoryName: "acme/context",
    githubConnectionId: "con_gh",
    branch: "main",
  })
  mocks.loadConfig.mockResolvedValue({
    services: [{ id: "PSERVICE", name: "checkout" }],
  })
  mocks.runWorkflow.mockResolvedValue({ workflowRun: { id: "run_1" } })
})

describe("POST /api/v1/webhook/pagerduty", () => {
  it("verifies the raw body and enqueues an in-scope incident", async () => {
    const occurredAt = new Date().toISOString()
    const { body, signature } = signedBody({
      event: {
        id: "evt_1",
        event_type: "incident.triggered",
        occurred_at: occurredAt,
        data: {
          id: "PINCIDENT",
          service: { id: "PSERVICE" },
        },
      },
    })
    const response = await createTestApp().request(
      "/api/v1/webhook/pagerduty",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pagerduty-signature": signature,
          "x-pagerduty-subscription": "PFSUB",
        },
        body,
      },
    )
    expect(response.status).toBe(200)
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      { name: "pagerduty-sync-entity" },
      expect.objectContaining({
        orgId: "org_1",
        connectionId: "con_pd",
        incidentId: "PINCIDENT",
        action: "upsert",
      }),
      { idempotencyKey: "pagerduty:con_pd:evt_1" },
    )
  })

  it("rejects a tampered body", async () => {
    const { signature } = signedBody({
      event: {
        id: "evt_1",
        event_type: "incident.triggered",
        occurred_at: new Date().toISOString(),
        data: { id: "PINCIDENT", service: { id: "PSERVICE" } },
      },
    })
    const response = await createTestApp().request(
      "/api/v1/webhook/pagerduty",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pagerduty-signature": signature,
          "x-pagerduty-subscription": "PFSUB",
        },
        body: JSON.stringify({ event: { event_type: "tampered" } }),
      },
    )
    expect(response.status).toBe(401)
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
  })

  it("rejects a stale event", async () => {
    const { body, signature } = signedBody({
      event: {
        id: "evt_1",
        event_type: "incident.triggered",
        occurred_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        data: { id: "PINCIDENT", service: { id: "PSERVICE" } },
      },
    })
    const response = await createTestApp().request(
      "/api/v1/webhook/pagerduty",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pagerduty-signature": signature,
          "x-pagerduty-subscription": "PFSUB",
        },
        body,
      },
    )
    expect(response.status).toBe(401)
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
  })

  it("skips enqueue when the connection is not live", async () => {
    mocks.listConnections.mockResolvedValue([
      { ...liveConnection, setupPhase: "draft" },
    ])
    const { body, signature } = signedBody({
      event: {
        id: "evt_1",
        event_type: "incident.triggered",
        occurred_at: new Date().toISOString(),
        data: { id: "PINCIDENT", service: { id: "PSERVICE" } },
      },
    })
    const response = await createTestApp().request(
      "/api/v1/webhook/pagerduty",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pagerduty-signature": signature,
          "x-pagerduty-subscription": "PFSUB",
        },
        body,
      },
    )
    expect(response.status).toBe(200)
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
  })

  it("acks incidents with no service id without enqueue", async () => {
    const { body, signature } = signedBody({
      event: {
        id: "evt_1",
        event_type: "incident.triggered",
        occurred_at: new Date().toISOString(),
        data: { id: "PINCIDENT" },
      },
    })
    const response = await createTestApp().request(
      "/api/v1/webhook/pagerduty",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pagerduty-signature": signature,
          "x-pagerduty-subscription": "PFSUB",
        },
        body,
      },
    )
    expect(response.status).toBe(200)
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
  })

  it("acks out-of-scope services without enqueue", async () => {
    const { body, signature } = signedBody({
      event: {
        id: "evt_1",
        event_type: "incident.triggered",
        occurred_at: new Date().toISOString(),
        data: { id: "PINCIDENT", service: { id: "POUT" } },
      },
    })
    const response = await createTestApp().request(
      "/api/v1/webhook/pagerduty",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pagerduty-signature": signature,
          "x-pagerduty-subscription": "PFSUB",
        },
        body,
      },
    )
    expect(response.status).toBe(200)
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
    expect(mocks.loadConfig).toHaveBeenCalled()
  })
})
