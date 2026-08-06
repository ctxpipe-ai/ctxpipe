import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../../app/env.js"

const listConnectionsMock = vi.hoisted(() => vi.fn())
const getTargetMock = vi.hoisted(() => vi.fn())
const markDirtyMock = vi.hoisted(() => vi.fn())
const runWorkflowMock = vi.hoisted(() => vi.fn())
const verifySignatureMock = vi.hoisted(() => vi.fn())

vi.mock("../../../models/slack-connector.js", () => ({
  getSlackSyncTargetByConnectionId: getTargetMock,
  listSlackConnectionsByTeamId: listConnectionsMock,
  markSlackThreadDirty: markDirtyMock,
}))
vi.mock("../../../observability/logger.js", () => ({
  getLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}))
vi.mock("../../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowMock,
}))
vi.mock("../../../openworkflow/workflows/slack-sync-flush.js", () => ({
  slackSyncFlush: { spec: { name: "slack-sync-flush" } },
}))
vi.mock("../../../services/slack/cadence.js", () => ({
  slackFlushIdempotencyBucket: () => 123,
}))
vi.mock("../../../services/slack/verify-signature.js", () => ({
  verifySlackRequestSignature: verifySignatureMock,
}))

import { registerSlackWebhookRoute } from "./slack.js"

function testApp() {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("env", {
      SLACK_SIGNING_SECRET: "signing-secret",
    } as AppEnv["Variables"]["env"])
    await next()
  })
  registerSlackWebhookRoute(app as never)
  return app
}

function eventRequest() {
  return testApp().request("/api/v1/webhook/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": "1710000000",
      "x-slack-signature": "v0=test",
    },
    body: JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev1",
      event: {
        type: "message",
        channel: "C1",
        ts: "1710000000.000001",
      },
    }),
  })
}

describe("Slack webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifySignatureMock.mockReturnValue(true)
    listConnectionsMock.mockResolvedValue([{ id: "con_1", orgId: "org_1" }])
    getTargetMock.mockResolvedValue({
      connectionId: "con_1",
      orgId: "org_1",
      enabled: true,
      setupPhase: "live",
    })
    markDirtyMock.mockResolvedValue(undefined)
    runWorkflowMock.mockResolvedValue(undefined)
  })

  it("marks and enqueues message events for live connectors", async () => {
    const response = await eventRequest()

    expect(response.status).toBe(200)
    expect(markDirtyMock).toHaveBeenCalledWith({
      connectionId: "con_1",
      channelId: "C1",
      threadTs: "1710000000.000001",
    })
    expect(runWorkflowMock).toHaveBeenCalledWith(
      { name: "slack-sync-flush" },
      { orgId: "org_1", connectionId: "con_1" },
      { idempotencyKey: "slack-flush:con_1:123" },
    )
  })

  it("marks the edited thread from a nested message_changed payload", async () => {
    const response = await testApp().request("/api/v1/webhook/slack", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": "1710000000",
        "x-slack-signature": "v0=test",
      },
      body: JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event_id: "Ev2",
        event: {
          type: "message",
          subtype: "message_changed",
          channel: "C1",
          ts: "1710000099.000099",
          message: {
            ts: "1710000001.000001",
            thread_ts: "1710000000.000001",
          },
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(markDirtyMock).toHaveBeenCalledWith({
      connectionId: "con_1",
      channelId: "C1",
      threadTs: "1710000000.000001",
    })
  })

  it.each([
    { enabled: false, setupPhase: "live" },
    { enabled: true, setupPhase: "draft" },
    { enabled: true, setupPhase: "awaiting_merge" },
    { enabled: true, setupPhase: "initial_sync" },
  ])("ignores events for non-live targets %#", async (target) => {
    getTargetMock.mockResolvedValue({
      connectionId: "con_1",
      orgId: "org_1",
      ...target,
    })

    const response = await eventRequest()

    expect(response.status).toBe(200)
    expect(markDirtyMock).not.toHaveBeenCalled()
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("rejects invalid signatures before parsing the payload", async () => {
    verifySignatureMock.mockReturnValue(false)

    const response = await eventRequest()

    expect(response.status).toBe(401)
    expect(listConnectionsMock).not.toHaveBeenCalled()
  })

  it("answers Slack URL verification challenges", async () => {
    const response = await testApp().request("/api/v1/webhook/slack", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": "1710000000",
        "x-slack-signature": "v0=test",
      },
      body: JSON.stringify({
        type: "url_verification",
        challenge: "challenge-token",
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      challenge: "challenge-token",
    })
  })
})
