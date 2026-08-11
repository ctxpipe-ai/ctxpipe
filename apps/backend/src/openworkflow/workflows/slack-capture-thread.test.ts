import { beforeEach, describe, expect, it, vi } from "vitest"

const getTargetMock = vi.hoisted(() => vi.fn())
const getConnectionMock = vi.hoisted(() => vi.fn())
const captureSlackThreadMock = vi.hoisted(() => vi.fn())
const postStatusMock = vi.hoisted(() => vi.fn())
const updateStatusMock = vi.hoisted(() => vi.fn())

vi.mock("../../config/env.js", () => ({
  parseEnv: () => ({}),
}))
vi.mock("../../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../../models/slack-connector.js", () => ({
  getSlackConnectionByConnectionId: getConnectionMock,
  getSlackSyncTargetByConnectionId: getTargetMock,
}))
vi.mock("../../services/slack/sync.js", () => ({
  captureSlackThread: captureSlackThreadMock,
}))
vi.mock("../../services/slack/client.js", () => ({
  postSlackThreadMessage: postStatusMock,
  updateSlackMessage: updateStatusMock,
  SLACK_CAPTURE_STATUS_CAPTURING: "ctx| agent capturing engineering context…",
  SLACK_CAPTURE_STATUS_CAPTURED: "Engineering context captured.",
  SLACK_CAPTURE_STATUS_FAILED: "Engineering context capture failed.",
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}))

import { slackCaptureThread } from "./slack-capture-thread.js"

const target = {
  connectionId: "con_1",
  orgId: "org_1",
  repositoryId: "repo_1",
  branch: "main",
  enabled: true,
  setupPhase: "live" as const,
}

const connection = { id: "con_1", orgId: "org_1", teamId: "T1" }

describe("slackCaptureThread workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getTargetMock.mockResolvedValue(target)
    getConnectionMock.mockResolvedValue(connection)
    postStatusMock.mockResolvedValue({ ts: "1710000000.000999" })
    updateStatusMock.mockResolvedValue(true)
    captureSlackThreadMock.mockResolvedValue({
      status: "completed",
      messageCount: 3,
      commitSha: "abc123",
      threadPath: "slack/channels/eng--C1/threads/2026/03/1710000000.000100/index.md",
      channelName: "eng",
    })
  })

  it("posts capturing status, captures, then updates to captured", async () => {
    const result = await slackCaptureThread.fn({
      input: {
        orgId: "org_1",
        connectionId: "con_1",
        channelId: "C1",
        threadTs: "1710000000.000100",
      },
    } as never)

    expect(postStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "ctx| agent capturing engineering context…",
        channelId: "C1",
        threadTs: "1710000000.000100",
      }),
    )
    expect(captureSlackThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        connection,
        target,
        channelId: "C1",
        threadTs: "1710000000.000100",
        excludeMessageTs: "1710000000.000999",
      }),
    )
    expect(updateStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageTs: "1710000000.000999",
        text: expect.stringContaining("Engineering context captured."),
      }),
    )
    expect(result).toMatchObject({ status: "completed", messageCount: 3 })
  })

  it("still captures when the status post fails", async () => {
    postStatusMock.mockResolvedValue(null)

    await slackCaptureThread.fn({
      input: {
        orgId: "org_1",
        connectionId: "con_1",
        channelId: "C1",
        threadTs: "1710000000.000100",
      },
    } as never)

    expect(captureSlackThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({ excludeMessageTs: undefined }),
    )
    expect(updateStatusMock).not.toHaveBeenCalled()
  })

  it("throws when the sync target is not configured", async () => {
    getTargetMock.mockResolvedValue(undefined)

    await expect(
      slackCaptureThread.fn({
        input: {
          orgId: "org_1",
          connectionId: "con_1",
          channelId: "C1",
          threadTs: "1710000000.000100",
        },
      } as never),
    ).rejects.toThrow("Slack sync target is not configured")
    expect(captureSlackThreadMock).not.toHaveBeenCalled()
  })

  it("throws when the connector is not live", async () => {
    getTargetMock.mockResolvedValue({ ...target, setupPhase: "draft" })

    await expect(
      slackCaptureThread.fn({
        input: {
          orgId: "org_1",
          connectionId: "con_1",
          channelId: "C1",
          threadTs: "1710000000.000100",
        },
      } as never),
    ).rejects.toThrow("Slack connector is not live")
    expect(captureSlackThreadMock).not.toHaveBeenCalled()
  })

  it("updates status to failed then surfaces the capture error", async () => {
    captureSlackThreadMock.mockResolvedValue({
      status: "failed",
      messageCount: 0,
      error: "Slack thread has no messages to capture",
    })

    await expect(
      slackCaptureThread.fn({
        input: {
          orgId: "org_1",
          connectionId: "con_1",
          channelId: "C1",
          threadTs: "1710000000.000100",
        },
      } as never),
    ).rejects.toThrow("Slack thread has no messages to capture")

    expect(updateStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Engineering context capture failed.",
      }),
    )
  })
})
