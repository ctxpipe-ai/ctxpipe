import { beforeEach, describe, expect, it, vi } from "vitest"

const flushMock = vi.hoisted(() => vi.fn())
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
  withOrgDbContext: (_orgId: string, run: () => unknown) => run(),
}))

vi.mock("../../models/slack-connector.js", () => ({
  getSlackConnectionByConnectionId: getConnectionMock,
  getSlackSyncTargetByConnectionId: getTargetMock,
}))

vi.mock("../../services/slack/sync.js", () => ({
  flushSlackDirtyThreads: flushMock,
}))

import { slackSyncFlush } from "./slack-sync-flush.js"

const step = {
  run: vi.fn(async (_options: { name: string }, run: () => Promise<unknown>) =>
    run(),
  ),
  sleep: vi.fn(),
}

async function runWorkflow() {
  return (
    slackSyncFlush as unknown as {
      run: (context: {
        input: { orgId: string; connectionId: string }
        step: typeof step
      }) => Promise<unknown>
    }
  ).run({
    input: { orgId: "org_1", connectionId: "con_slack" },
    step,
  })
}

describe("slack-sync-flush workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getTargetMock.mockResolvedValue({
      orgId: "org_1",
      connectionId: "con_slack",
    })
    getConnectionMock.mockResolvedValue({
      id: "con_slack",
      orgId: "org_1",
    })
  })

  it.each([
    "failed",
    "partial_failed",
  ] as const)("fails its durable step when a dirty-thread flush is %s", async (status) => {
    flushMock.mockResolvedValue({
      status,
      threadsProcessed: status === "partial_failed" ? 1 : 0,
      threadsFailed: 1,
      errors: [{ channelId: "C1", message: "Slack unavailable" }],
    })

    await expect(runWorkflow()).rejects.toThrow(
      `Slack dirty-thread flush ${status.replace("_", " ")}`,
    )
    expect(step.run).toHaveBeenCalledTimes(1)
  })

  it("still sleeps and retries when a successful flush is waiting for quiet", async () => {
    flushMock
      .mockResolvedValueOnce({
        status: "completed",
        threadsProcessed: 0,
        threadsFailed: 0,
        rescheduleAfterMs: 1_000,
        errors: [],
      })
      .mockResolvedValueOnce({
        status: "completed",
        threadsProcessed: 1,
        threadsFailed: 0,
        errors: [],
      })

    await expect(runWorkflow()).resolves.toMatchObject({ status: "completed" })
    expect(step.sleep).toHaveBeenCalledWith("wait-quiet-1", "1s")
    expect(flushMock).toHaveBeenCalledTimes(2)
  })
})
