import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../../app/env.js"

const getConnectionMock = vi.hoisted(() => vi.fn())
const getTargetMock = vi.hoisted(() => vi.fn())
const revokeMock = vi.hoisted(() => vi.fn())
const runWorkflowMock = vi.hoisted(() => vi.fn())
const verifySignatureMock = vi.hoisted(() => vi.fn())
const postStatusMock = vi.hoisted(() => vi.fn())
const logInfoMock = vi.hoisted(() => vi.fn())

vi.mock("../../../models/slack-connector.js", () => ({
  getSlackConnectionByTeamId: getConnectionMock,
  getSlackSyncTargetByConnectionId: getTargetMock,
  revokeSlackConnectionByTeamId: revokeMock,
}))
vi.mock("../../../observability/logger.js", () => ({
  getLogger: () => ({
    error: vi.fn(),
    info: logInfoMock,
    warn: vi.fn(),
  }),
}))
vi.mock("../../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowMock,
}))
vi.mock("../../../openworkflow/workflows/slack-mention-agent.js", () => ({
  slackMentionAgent: { spec: { name: "slack-mention-agent" } },
}))
vi.mock("../../../services/slack/verify-signature.js", () => ({
  verifySlackRequestSignature: verifySignatureMock,
}))
vi.mock("../../../services/slack/client.js", () => ({
  postSlackThreadMessage: postStatusMock,
  updateSlackMessage: vi.fn(),
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

function mentionRequest(overrides?: {
  channel?: string
  ts?: string
  thread_ts?: string
  text?: string
  user?: string
  channel_type?: string
}) {
  return testApp().request("/api/v1/webhook/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": "1710000000",
      "x-slack-signature": "v0=test",
    },
    body: JSON.stringify({
      type: "event_callback",
      api_app_id: "A_CTXPIPE",
      team_id: "T1",
      event_id: "Ev1",
      event: {
        type: "app_mention",
        channel: overrides?.channel ?? "C1",
        ts: overrides?.ts ?? "1710000000.000001",
        text: overrides?.text ?? "<@U_BOT>",
        user: overrides?.user ?? "U1",
        ...(overrides?.thread_ts ? { thread_ts: overrides.thread_ts } : {}),
        ...(overrides?.channel_type
          ? { channel_type: overrides.channel_type }
          : {}),
      },
    }),
  })
}

describe("Slack webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifySignatureMock.mockReturnValue(true)
    getConnectionMock.mockResolvedValue({ id: "con_1", orgId: "org_1" })
    getTargetMock.mockResolvedValue({
      connectionId: "con_1",
      orgId: "org_1",
      enabled: true,
      setupPhase: "live",
    })
    runWorkflowMock.mockResolvedValue(undefined)
    revokeMock.mockResolvedValue(true)
    postStatusMock.mockResolvedValue({ ts: "1710000000.000900" })
  })

  it("enqueues a mention agent for an app_mention on a live connector", async () => {
    const response = await mentionRequest({
      thread_ts: "1710000000.000001",
    })

    expect(response.status).toBe(200)
    expect(runWorkflowMock).toHaveBeenCalledTimes(1)
    expect(runWorkflowMock).toHaveBeenCalledWith(
      { name: "slack-mention-agent" },
      {
        orgId: "org_1",
        connectionId: "con_1",
        channelId: "C1",
        threadTs: "1710000000.000001",
        mentionText: "<@U_BOT>",
        mentionUserId: "U1",
      },
      {
        idempotencyKey:
          "slack-mention:con_1:C1:1710000000.000001:1710000000.000001",
      },
    )
    expect(postStatusMock).not.toHaveBeenCalled()
    expect(logInfoMock).toHaveBeenCalledWith("slack_webhook_event_received", {
      apiAppId: "A_CTXPIPE",
      teamId: "T1",
      eventType: "app_mention",
      eventId: "Ev1",
    })
  })

  it("posts a terminal failure after 200 when enqueue fails", async () => {
    runWorkflowMock.mockRejectedValue(new Error("queue down"))

    const response = await mentionRequest({
      thread_ts: "1710000000.000001",
    })

    expect(response.status).toBe(200)
    await vi.waitFor(() => {
      expect(postStatusMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: "C1",
          threadTs: "1710000000.000001",
          text: "Engineering context capture failed. Could not start the capture job. Mention the bot again.",
        }),
      )
    })
  })

  it("still returns 200 when enqueue fails and the failure status cannot be posted", async () => {
    runWorkflowMock.mockRejectedValue(new Error("queue down"))
    postStatusMock.mockResolvedValue(null)

    const response = await mentionRequest({
      thread_ts: "1710000000.000001",
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it("uses a new idempotency key when the same thread is mentioned again", async () => {
    await mentionRequest({
      ts: "1710000000.000200",
      thread_ts: "1710000000.000001",
    })

    expect(runWorkflowMock).toHaveBeenCalledWith(
      { name: "slack-mention-agent" },
      expect.objectContaining({ threadTs: "1710000000.000001" }),
      {
        idempotencyKey:
          "slack-mention:con_1:C1:1710000000.000001:1710000000.000200",
      },
    )
  })

  it("uses event.thread_ts as the capture thread when present", async () => {
    const response = await mentionRequest({
      ts: "1710000000.000001",
      thread_ts: "1700000000.000000",
    })

    expect(response.status).toBe(200)
    expect(runWorkflowMock).toHaveBeenCalledWith(
      { name: "slack-mention-agent" },
      expect.objectContaining({ threadTs: "1700000000.000000" }),
      expect.any(Object),
    )
  })

  it("returns 200 before workflow enqueue settles", async () => {
    let released = false
    runWorkflowMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            released = true
            resolve(undefined)
          }, 50)
        }),
    )

    const response = await mentionRequest({
      thread_ts: "1710000000.000001",
    })
    expect(response.status).toBe(200)
    expect(released).toBe(false)
    await vi.waitFor(() => {
      expect(released).toBe(true)
    })
  })

  it("ignores DMs and MPIMs", async () => {
    const dm = await mentionRequest({ channel_type: "im" })
    const mpim = await mentionRequest({ channel_type: "mpim" })

    expect(dm.status).toBe(200)
    expect(mpim.status).toBe(200)
    expect(runWorkflowMock).not.toHaveBeenCalled()
    expect(postStatusMock).not.toHaveBeenCalled()
  })

  it("refuses channel-top-level mentions and does not enqueue capture", async () => {
    const response = await mentionRequest()

    expect(response.status).toBe(200)
    expect(runWorkflowMock).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(postStatusMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: "C1",
          threadTs: "1710000000.000001",
          text: "Capture only works inside an existing thread. Mention me in a thread, not at the top of the channel.",
        }),
      )
    })
  })

  it("still returns 200 when a channel-top-level refusal cannot be posted", async () => {
    postStatusMock.mockResolvedValue(null)

    const response = await mentionRequest()

    expect(response.status).toBe(200)
    expect(runWorkflowMock).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it("revokes the connection on app_uninstalled", async () => {
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
        event: { type: "app_uninstalled" },
      }),
    })

    expect(response.status).toBe(200)
    expect(revokeMock).toHaveBeenCalledWith("T1")
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("revokes the connection on tokens_revoked", async () => {
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
        event: { type: "tokens_revoked", tokens: { bot: ["xoxb"] } },
      }),
    })

    expect(response.status).toBe(200)
    expect(revokeMock).toHaveBeenCalledWith("T1")
  })

  it("ignores non-mention events", async () => {
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
          channel: "C1",
          ts: "1710000000.000001",
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(getConnectionMock).not.toHaveBeenCalled()
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it.each([
    { enabled: false },
    { enabled: false, repositoryId: "repo_1" },
  ])("ignores mentions for disabled or unbound targets %#", async (target) => {
    getTargetMock.mockResolvedValue(
      "repositoryId" in target
        ? {
            connectionId: "con_1",
            orgId: "org_1",
            ...target,
          }
        : { connectionId: "con_1", orgId: "org_1", enabled: false },
    )

    const response = await mentionRequest()

    expect(response.status).toBe(200)
    expect(runWorkflowMock).not.toHaveBeenCalled()
    expect(postStatusMock).not.toHaveBeenCalled()
  })

  it("ignores mentions when no capture binding exists", async () => {
    getTargetMock.mockResolvedValue(undefined)

    const response = await mentionRequest()

    expect(response.status).toBe(200)
    expect(runWorkflowMock).not.toHaveBeenCalled()
    expect(postStatusMock).not.toHaveBeenCalled()
  })

  it("rejects invalid signatures before parsing the payload", async () => {
    verifySignatureMock.mockReturnValue(false)

    const response = await mentionRequest()

    expect(response.status).toBe(401)
    expect(getConnectionMock).not.toHaveBeenCalled()
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
