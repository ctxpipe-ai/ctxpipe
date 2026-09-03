import { beforeEach, describe, expect, it, vi } from "vitest"

const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn((_orgId: string, fn: () => unknown) => Promise.resolve(fn())),
)
const markRepositoryIndexingFailedMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
)
const getLoggerErrorMock = vi.hoisted(() => vi.fn())
const flushWorkflowLogMock = vi.hoisted(() => vi.fn())
const enqueueFollowUpIfTipAheadMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ enqueued: false }),
)

vi.mock("../../db/client.js", () => ({
  withOrgDbContext: withOrgDbContextMock,
}))

vi.mock("../../models/repositories.js", () => ({
  markRepositoryIndexingFailed: markRepositoryIndexingFailedMock,
}))

vi.mock("../../observability/logger.js", () => ({
  createLogger: () => ({}),
  withLogger: (_logger: unknown, fn: () => unknown) => fn(),
  getLogger: () => ({ error: getLoggerErrorMock }),
  flushWorkflowLog: flushWorkflowLogMock,
}))

vi.mock("../enqueue-follow-up-if-tip-ahead.js", () => ({
  enqueueFollowUpIfTipAhead: enqueueFollowUpIfTipAheadMock,
}))

vi.mock("./repository-ingestion.js", () => ({
  repositoryIngestion: { spec: { name: "repository-ingestion" } },
}))

import { repositoryIngestionOrchestrator } from "./repository-ingestion-orchestrator.js"

describe("repositoryIngestionOrchestrator workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    withOrgDbContextMock.mockImplementation(
      (_orgId: string, fn: () => unknown) => Promise.resolve(fn()),
    )
    markRepositoryIndexingFailedMock.mockResolvedValue(undefined)
    enqueueFollowUpIfTipAheadMock.mockResolvedValue({ enqueued: false })
  })

  it("returns child result on success", async () => {
    const step = {
      runWorkflow: vi.fn().mockResolvedValue({
        repositoryId: "repo_1",
        targetHash: "abc123",
        sourceBranch: "main",
      }),
      run: vi.fn(),
    }

    const result = await repositoryIngestionOrchestrator.fn({
      input: {
        repositoryId: "repo_1",
        orgId: "org_1",
        indexingReason: "manual",
        targetBranch: "connector-assets",
        githubConnectionId: "con_github",
      },
      step,
    } as never)

    expect(step.runWorkflow).toHaveBeenCalledWith(
      { name: "repository-ingestion" },
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        indexingReason: "manual",
        targetBranch: "connector-assets",
        githubConnectionId: "con_github",
      },
      { name: "repository-ingestion-child" },
    )
    expect(step.run).not.toHaveBeenCalled()
    expect(markRepositoryIndexingFailedMock).not.toHaveBeenCalled()
    expect(result).toEqual({
      repositoryId: "repo_1",
      targetHash: "abc123",
      sourceBranch: "main",
    })
  })

  it("marks failed and rethrows when child fails", async () => {
    const childError = new Error("child failed")
    const step = {
      runWorkflow: vi.fn().mockRejectedValue(childError),
      run: vi.fn(async (_opts: { name: string }, fn: () => Promise<unknown>) =>
        fn(),
      ),
    }

    await expect(
      repositoryIngestionOrchestrator.fn({
        input: {
          repositoryId: "repo_1",
          orgId: "org_1",
          targetBranch: "connector-assets",
          githubConnectionId: "con_github",
        },
        step,
      } as never),
    ).rejects.toThrow("child failed")

    expect(step.run).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "mark-failed",
        retryPolicy: expect.objectContaining({ maximumAttempts: 5 }),
      }),
      expect.any(Function),
    )
    expect(markRepositoryIndexingFailedMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      error: childError,
    })
    expect(step.run).toHaveBeenCalledTimes(2)
    expect(step.run.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ name: "mark-failed" }),
    )
    expect(step.run.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ name: "enqueue-pending-follow-up" }),
    )
    expect(enqueueFollowUpIfTipAheadMock).toHaveBeenCalledWith(
      {
        orgId: "org_1",
        repositoryId: "repo_1",
        pendingOnly: true,
        targetBranch: "connector-assets",
        githubConnectionId: "con_github",
      },
      expect.any(Object),
    )

    // Must log via evlog, not console
    expect(getLoggerErrorMock).toHaveBeenCalledWith(
      childError,
      expect.objectContaining({
        step: "repository-ingestion-orchestrator.child-failed",
        workflow: "repository-ingestion-orchestrator",
        repositoryId: "repo_1",
        orgId: "org_1",
      }),
    )
    expect(flushWorkflowLogMock).toHaveBeenCalled()
  })

  it("rethrows SleepSignal without marking failed", async () => {
    const sleepSignal = new Error("sleep")
    sleepSignal.name = "SleepSignal"
    const step = {
      runWorkflow: vi.fn().mockRejectedValue(sleepSignal),
      run: vi.fn(),
    }

    await expect(
      repositoryIngestionOrchestrator.fn({
        input: { repositoryId: "repo_1", orgId: "org_1" },
        step,
      } as never),
    ).rejects.toMatchObject({ name: "SleepSignal" })

    expect(step.run).not.toHaveBeenCalled()
    expect(markRepositoryIndexingFailedMock).not.toHaveBeenCalled()
  })

  it("marks failed when child throws CancelSignal", async () => {
    const cancelSignal = new Error("canceled")
    cancelSignal.name = "CancelSignal"
    const step = {
      runWorkflow: vi.fn().mockRejectedValue(cancelSignal),
      run: vi.fn(async (_opts: { name: string }, fn: () => Promise<unknown>) =>
        fn(),
      ),
    }

    await expect(
      repositoryIngestionOrchestrator.fn({
        input: { repositoryId: "repo_1", orgId: "org_1" },
        step,
      } as never),
    ).rejects.toMatchObject({ name: "CancelSignal" })

    expect(step.run).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "mark-failed",
        retryPolicy: expect.objectContaining({ maximumAttempts: 5 }),
      }),
      expect.any(Function),
    )
    expect(markRepositoryIndexingFailedMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      error: cancelSignal,
    })
  })

  it("marks failed with the memory-fit message when the child dies mid-index", async () => {
    const childError = new Error("Codebase didn't fit available memory")
    const step = {
      runWorkflow: vi.fn().mockRejectedValue(childError),
      run: vi.fn(async (_opts: { name: string }, fn: () => Promise<unknown>) =>
        fn(),
      ),
    }

    await expect(
      repositoryIngestionOrchestrator.fn({
        input: { repositoryId: "repo_1", orgId: "org_1" },
        step,
      } as never),
    ).rejects.toThrow("Codebase didn't fit available memory")

    expect(markRepositoryIndexingFailedMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      error: childError,
    })
  })
})
