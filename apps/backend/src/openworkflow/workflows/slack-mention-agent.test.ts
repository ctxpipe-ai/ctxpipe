import { beforeEach, describe, expect, it, vi } from "vitest"

const getTargetMock = vi.hoisted(() => vi.fn())
const getConnectionMock = vi.hoisted(() => vi.fn())
const runAgentMock = vi.hoisted(() => vi.fn())
const postStatusMock = vi.hoisted(() => vi.fn())
const updateStatusMock = vi.hoisted(() => vi.fn())
const runIngestionMock = vi.hoisted(() => vi.fn())

vi.mock("../../config/env.js", () => ({
  parseEnv: () => ({ MODEL_PROVIDER_API_KEY: "sk" }),
}))
vi.mock("../../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../../models/slack-connector.js", () => ({
  getSlackConnectionByConnectionId: getConnectionMock,
  getSlackSyncTargetByConnectionId: getTargetMock,
}))
vi.mock("../../services/slack/mention-agent.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../services/slack/mention-agent.js")
    >()
  return {
    ...actual,
    runSlackMentionAgent: runAgentMock,
  }
})
vi.mock("../../services/slack/client.js", () => ({
  postSlackThreadMessage: postStatusMock,
  updateSlackMessage: updateStatusMock,
  SLACK_MENTION_STATUS_WORKING: "ctx| agent working…",
  SLACK_CAPTURE_STATUS_CAPTURED: "Engineering context captured.",
  SLACK_CAPTURE_STATUS_FAILED: "Engineering context capture failed.",
  SLACK_MENTION_CAPABILITY_REPLY:
    "I can capture this thread into your context repo. Ask me to capture it, or mention me with no extra text.",
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}))
vi.mock("../enqueue-repository-ingestion.js", () => ({
  runConnectorRepositoryIngestionWorkflow: runIngestionMock,
}))

import { slackMentionAgent } from "./slack-mention-agent.js"

const target = {
  connectionId: "con_1",
  orgId: "org_1",
  repositoryId: "repo_1",
  branch: "main",
  enabled: true,
}

const connection = { id: "con_1", orgId: "org_1", teamId: "T1" }

function workflowContext(input: Record<string, unknown>) {
  return {
    input,
    step: {
      run: async (
        _options: { name: string },
        operation: () => Promise<unknown>,
      ) => operation(),
    },
  } as never
}

describe("slackMentionAgent workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getTargetMock.mockResolvedValue(target)
    getConnectionMock.mockResolvedValue(connection)
    postStatusMock.mockResolvedValue({ ts: "1710000000.000999" })
    updateStatusMock.mockResolvedValue(true)
    runAgentMock.mockResolvedValue({
      kind: "captured",
      capture: {
        status: "completed",
        messageCount: 3,
        commitSha: "sha-slack",
        githubUrl:
          "https://github.com/acme/context/blob/abc123/slack/channels/eng--C1/threads/2026/03/1710000000.000100/thread.md",
      },
    })
    runIngestionMock.mockResolvedValue(undefined)
  })

  it("posts working status, runs the agent, then updates to captured", async () => {
    const stepRun = vi.fn(
      async (_options: { name: string }, operation: () => Promise<unknown>) =>
        operation(),
    )
    const result = await slackMentionAgent.fn({
      input: {
        orgId: "org_1",
        connectionId: "con_1",
        channelId: "C1",
        threadTs: "1710000000.000100",
        mentionText: "<@U_BOT>",
        mentionUserId: "U1",
      },
      step: { run: stepRun },
    } as never)

    expect(stepRun.mock.calls.map(([options]) => options.name)).toEqual([
      "load-slack-capture-target",
      "post-slack-working-status",
      "capture-slack-thread",
      "publish-slack-capture-status",
    ])
    expect(postStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "ctx| agent working…",
        channelId: "C1",
        threadTs: "1710000000.000100",
      }),
    )
    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mentionText: "<@U_BOT>",
        mentionUserId: "U1",
        excludeMessageTs: "1710000000.000999",
      }),
    )
    expect(updateStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageTs: "1710000000.000999",
        text: "Engineering context captured. <https://github.com/acme/context/blob/abc123/slack/channels/eng--C1/threads/2026/03/1710000000.000100/thread.md|View in GitHub>",
      }),
    )
    expect(runIngestionMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Applying Slack capture",
      },
      expect.any(Object),
    )
    expect(result).toMatchObject({ kind: "captured" })
  })

  it("checks the branch tip when replaying a captured thread without a commit result", async () => {
    runAgentMock.mockResolvedValueOnce({
      kind: "captured",
      capture: {
        status: "completed",
        messageCount: 3,
        githubUrl:
          "https://github.com/acme/context/blob/abc123/slack/channels/eng--C1/thread.md",
      },
    })

    await slackMentionAgent.fn(
      workflowContext({
        orgId: "org_1",
        connectionId: "con_1",
        channelId: "C1",
        threadTs: "1710000000.000100",
      }),
    )

    expect(runIngestionMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Applying Slack capture",
      },
      expect.any(Object),
    )
  })

  it("keeps the checkpointed repository target when a binding is rebound during replay", async () => {
    const checkpointedTarget = {
      ...target,
      repositoryId: "repo_original",
      branch: "capture-branch",
    }
    getTargetMock.mockResolvedValueOnce({
      ...target,
      repositoryId: "repo_rebound",
      branch: "main",
    })
    const stepRun = vi.fn(
      async (options: { name: string }, operation: () => Promise<unknown>) => {
        if (options.name === "load-slack-capture-target") {
          return checkpointedTarget
        }
        return operation()
      },
    )

    await slackMentionAgent.fn({
      input: {
        orgId: "org_1",
        connectionId: "con_1",
        channelId: "C1",
        threadTs: "1710000000.000100",
      },
      step: { run: stepRun },
    } as never)

    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: checkpointedTarget }),
    )
    expect(runIngestionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        repositoryId: "repo_original",
        targetBranch: "capture-branch",
      }),
      expect.any(Object),
    )
  })

  it("settles status with a capability reply when the agent does not capture", async () => {
    runAgentMock.mockResolvedValue({ kind: "capability" })

    const result = await slackMentionAgent.fn(
      workflowContext({
        orgId: "org_1",
        connectionId: "con_1",
        channelId: "C1",
        threadTs: "1710000000.000100",
        mentionText: "<@U_BOT> what is this?",
      }),
    )

    expect(updateStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Ask me to capture"),
      }),
    )
    expect(runIngestionMock).not.toHaveBeenCalled()
    expect(result).toEqual({ kind: "capability" })
  })

  it("posts a terminal status when the working message never landed", async () => {
    postStatusMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ts: "1710000000.001000" })

    await slackMentionAgent.fn(
      workflowContext({
        orgId: "org_1",
        connectionId: "con_1",
        channelId: "C1",
        threadTs: "1710000000.000100",
      }),
    )

    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ excludeMessageTs: undefined }),
    )
    expect(updateStatusMock).not.toHaveBeenCalled()
    expect(postStatusMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Engineering context captured."),
        threadTs: "1710000000.000100",
      }),
    )
  })

  it("posts a fallback reply when chat.update of the working message fails", async () => {
    updateStatusMock.mockResolvedValue(false)
    postStatusMock
      .mockResolvedValueOnce({ ts: "1710000000.000999" })
      .mockResolvedValueOnce({ ts: "1710000000.001000" })

    await slackMentionAgent.fn(
      workflowContext({
        orgId: "org_1",
        connectionId: "con_1",
        channelId: "C1",
        threadTs: "1710000000.000100",
      }),
    )

    expect(updateStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ messageTs: "1710000000.000999" }),
    )
    expect(postStatusMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Engineering context captured."),
        threadTs: "1710000000.000100",
      }),
    )
  })

  it("updates status even when the agent throws", async () => {
    runAgentMock.mockRejectedValue(new Error("boom"))

    await expect(
      slackMentionAgent.fn(
        workflowContext({
          orgId: "org_1",
          connectionId: "con_1",
          channelId: "C1",
          threadTs: "1710000000.000100",
        }),
      ),
    ).rejects.toThrow("boom")

    expect(updateStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Engineering context capture failed. boom",
      }),
    )
    expect(runIngestionMock).not.toHaveBeenCalled()
  })

  it("throws when the connector is not live", async () => {
    getTargetMock.mockResolvedValue({ ...target, enabled: false })

    await expect(
      slackMentionAgent.fn(
        workflowContext({
          orgId: "org_1",
          connectionId: "con_1",
          channelId: "C1",
          threadTs: "1710000000.000100",
        }),
      ),
    ).rejects.toThrow("Slack connector is not live")
    expect(runAgentMock).not.toHaveBeenCalled()
  })
})
