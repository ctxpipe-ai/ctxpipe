import { beforeEach, describe, expect, it, vi } from "vitest"

const syncSlackContentMock = vi.hoisted(() => vi.fn())
const finalizeMock = vi.hoisted(() => vi.fn())
const getConnectionMock = vi.hoisted(() => vi.fn())
const getTargetMock = vi.hoisted(() => vi.fn())

vi.mock("openworkflow", () => ({
  defineWorkflow: (
    definition: { name: string },
    run: (context: unknown) => Promise<unknown>,
  ) => ({
    spec: definition,
    run,
  }),
}))
vi.mock("../../config/env.js", () => ({
  parseEnv: () => ({}),
}))
vi.mock("../../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../../models/slack-connector.js", () => ({
  finalizeSlackSyncTargetAfterContentWorkflow: finalizeMock,
  getSlackConnectionByConnectionId: getConnectionMock,
  getSlackSyncTargetByConnectionId: getTargetMock,
}))
vi.mock("../../services/slack/client.js", () => ({
  SlackApiError: class SlackApiError extends Error {},
}))
vi.mock("../../services/slack/sync.js", () => ({
  syncSlackContent: syncSlackContentMock,
}))

import { slackSyncContent } from "./slack-sync-content.js"

const step = {
  run: vi.fn(async (_options: { name: string }, run: () => Promise<unknown>) =>
    run(),
  ),
  sleep: vi.fn(),
}

async function runWorkflow() {
  return (
    slackSyncContent as unknown as {
      run: (context: {
        input: { orgId: string; connectionId: string }
        step: typeof step
      }) => Promise<unknown>
    }
  ).run({
    input: { orgId: "org_1", connectionId: "con_1" },
    step,
  })
}

describe("slack-sync-content workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getTargetMock.mockResolvedValue({
      orgId: "org_1",
      connectionId: "con_1",
    })
    getConnectionMock.mockResolvedValue({
      id: "con_1",
      orgId: "org_1",
    })
    finalizeMock.mockResolvedValue(undefined)
  })

  it("fails the workflow instead of promoting a partial initial mirror", async () => {
    syncSlackContentMock.mockResolvedValue({
      status: "partial_failed",
      threadsProcessed: 2,
      threadsFailed: 1,
      errors: [{ message: "thread unavailable" }],
    })

    await expect(runWorkflow()).rejects.toThrow(
      "Slack initial sync partially failed for 1 thread(s)",
    )
    expect(finalizeMock).not.toHaveBeenCalled()
  })

  it("promotes a completed initial mirror", async () => {
    syncSlackContentMock.mockResolvedValue({
      status: "completed",
      threadsProcessed: 3,
      threadsFailed: 0,
      errors: [],
    })

    await expect(runWorkflow()).resolves.toMatchObject({
      status: "completed",
    })
    expect(finalizeMock).toHaveBeenCalledWith({
      connectionId: "con_1",
      workflowStatus: "completed",
    })
  })
})
