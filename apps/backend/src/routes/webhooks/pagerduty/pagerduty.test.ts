import { createHmac } from "node:crypto"
import { OpenAPIHono } from "@hono/zod-openapi"
import { createLogger } from "evlog"
import { contextStorage } from "hono/context-storage"
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
  app.use(contextStorage())
  app.use("*", async (c, next) => {
    c.set("env", env)
    c.set("log", createLogger())
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

  function postIncident(serviceId: string) {
    const { body, signature } = signedBody({
      event: {
        id: "evt_1",
        event_type: "incident.triggered",
        occurred_at: new Date().toISOString(),
        data: { id: "PINCIDENT", service: { id: serviceId } },
      },
    })
    return createTestApp().request("/api/v1/webhook/pagerduty", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pagerduty-signature": signature,
        "x-pagerduty-subscription": "PFSUB",
      },
      body,
    })
  }

  const sourcesSyncCall = [
    expect.objectContaining({ name: "workspace-sources-sync" }),
    {
      kind: "connection",
      orgId: "org_1",
      connectionId: "con_pd",
      provider: "pagerduty",
      event: { incidentId: "PINCIDENT", serviceId: "PSERVICE" },
    },
    { idempotencyKey: "workspace-sources:con_pd:evt_1" },
  ]

  it("enqueues only the Workspace sources sync when the legacy binding is not live", async () => {
    mocks.listConnections.mockResolvedValue([
      { ...liveConnection, setupPhase: "draft" },
    ])
    const response = await postIncident("PSERVICE")
    expect(response.status).toBe(200)
    expect(mocks.runWorkflow).toHaveBeenCalledTimes(1)
    expect(mocks.runWorkflow).toHaveBeenCalledWith(...sourcesSyncCall)
  })

  it("returns 503 when the Workspace sources sync cannot start, so PagerDuty retries", async () => {
    mocks.listConnections.mockResolvedValue([
      { ...liveConnection, setupPhase: "draft" },
    ])
    mocks.runWorkflow.mockRejectedValue(new Error("database is down"))
    expect((await postIncident("PSERVICE")).status).toBe(503)
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

  it("does not start the legacy sync for a service out of the legacy scope", async () => {
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
    expect(mocks.runWorkflow).toHaveBeenCalledTimes(1)
    expect(mocks.runWorkflow).not.toHaveBeenCalledWith(
      { name: "pagerduty-sync-entity" },
      expect.anything(),
      expect.anything(),
    )
    expect(mocks.loadConfig).toHaveBeenCalled()
  })

  it("binds HMAC verification to the matching connection when subscription ids collide", async () => {
    const otherSecret = "other-subscription-secret"
    const otherEnc = encryptConnectionSecret(otherSecret, env)
    mocks.listConnections.mockResolvedValue([
      {
        ...liveConnection,
        id: "con_wrong",
        webhookSecretEnc: otherEnc,
      },
      liveConnection,
    ])
    const occurredAt = new Date().toISOString()
    const { body, signature } = signedBody({
      event: {
        id: "evt_dup",
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
    // One legacy sync and one sources sync, both for the verified connection.
    expect(mocks.runWorkflow).toHaveBeenCalledTimes(2)
    for (const [, input] of mocks.runWorkflow.mock.calls)
      expect(input).toMatchObject({ connectionId: "con_pd" })
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      { name: "pagerduty-sync-entity" },
      expect.objectContaining({ connectionId: "con_pd" }),
      { idempotencyKey: "pagerduty:con_pd:evt_dup" },
    )
  })
})
