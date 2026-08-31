import { beforeEach, describe, expect, it, vi } from "vitest"

const runWorkflowWithWorkerWakeMock = vi.hoisted(() => vi.fn())
const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn((_orgId: string, fn: () => unknown) => Promise.resolve(fn())),
)
const tryClaimMock = vi.hoisted(() => vi.fn().mockResolvedValue(true))

vi.mock("../db/client.js", () => ({
  withOrgDbContext: withOrgDbContextMock,
}))

vi.mock("../models/repositories.js", () => ({
  tryClaimRepositoryIndexingEnqueue: tryClaimMock,
}))

vi.mock("./client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowWithWorkerWakeMock,
}))

vi.mock("./workflows/repository-ingestion-orchestrator.js", () => ({
  repositoryIngestionOrchestrator: {
    spec: { name: "repository-ingestion-orchestrator" },
  },
}))

import {
  claimAndRunRepositoryIngestionChild,
  enqueueRepositoryIngestionWorkflow,
  type RepositoryIngestionChildStep,
} from "./enqueue-repository-ingestion.js"

function mockChildStep(overrides?: {
  runWorkflow?: ReturnType<typeof vi.fn>
}): RepositoryIngestionChildStep {
  return {
    run: vi.fn(async (_opts: { name: string }, fn: () => unknown) => fn()),
    runWorkflow: overrides?.runWorkflow ?? vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn(),
  } as unknown as RepositoryIngestionChildStep
}

describe("enqueueRepositoryIngestionWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tryClaimMock.mockResolvedValue(true)
    withOrgDbContextMock.mockImplementation(
      (_orgId: string, fn: () => unknown) => Promise.resolve(fn()),
    )
  })

  it("does not await workflow result", async () => {
    const unresolved = new Promise<void>(() => {})
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      result: vi.fn().mockReturnValue(unresolved),
    })
    const log = { error: vi.fn() }

    await enqueueRepositoryIngestionWorkflow(
      { repositoryId: "repo_1", orgId: "org_1" },
      log,
    )

    expect(tryClaimMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      reason: null,
    })
    expect(runWorkflowWithWorkerWakeMock).toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
  })

  it("skips orchestrator when indexing is already queued or running", async () => {
    tryClaimMock.mockResolvedValue(false)
    const log = { error: vi.fn() }

    await enqueueRepositoryIngestionWorkflow(
      { repositoryId: "repo_1", orgId: "org_1" },
      log,
    )

    expect(tryClaimMock).toHaveBeenCalled()
    expect(runWorkflowWithWorkerWakeMock).not.toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
  })
})

describe("claimAndRunRepositoryIngestionChild", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tryClaimMock.mockResolvedValue(true)
    withOrgDbContextMock.mockImplementation(
      (_orgId: string, fn: () => unknown) => Promise.resolve(fn()),
    )
  })

  it("claims then runs the orchestrator as a child workflow", async () => {
    const step = mockChildStep()
    const log = { error: vi.fn() }

    await claimAndRunRepositoryIngestionChild(
      step,
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Syncing",
      },
      log,
    )

    expect(step.run).toHaveBeenCalledWith(
      { name: "claim-ingest-repo_1" },
      expect.any(Function),
    )
    expect(tryClaimMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      reason: "Syncing",
    })
    expect(step.runWorkflow).toHaveBeenCalledWith(
      { name: "repository-ingestion-orchestrator" },
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Syncing",
      },
      { name: "ingest-repo_1" },
    )
    expect(runWorkflowWithWorkerWakeMock).not.toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
  })

  it("skips child workflow when indexing is already queued or running", async () => {
    tryClaimMock.mockResolvedValue(false)
    const step = mockChildStep()
    const log = { error: vi.fn() }

    await claimAndRunRepositoryIngestionChild(
      step,
      { repositoryId: "repo_1", orgId: "org_1" },
      log,
    )

    expect(step.runWorkflow).not.toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
  })

  it("rethrows SleepSignal without logging", async () => {
    const sleepSignal = new Error("sleep")
    sleepSignal.name = "SleepSignal"
    const step = mockChildStep({
      runWorkflow: vi.fn().mockRejectedValue(sleepSignal),
    })
    const log = { error: vi.fn() }

    await expect(
      claimAndRunRepositoryIngestionChild(
        step,
        { repositoryId: "repo_1", orgId: "org_1" },
        log,
      ),
    ).rejects.toMatchObject({ name: "SleepSignal" })
    expect(log.error).not.toHaveBeenCalled()
  })

  it("logs and rethrows child failures", async () => {
    const step = mockChildStep({
      runWorkflow: vi.fn().mockRejectedValue(new Error("child failed")),
    })
    const log = { error: vi.fn() }

    await expect(
      claimAndRunRepositoryIngestionChild(
        step,
        { repositoryId: "repo_1", orgId: "org_1" },
        log,
      ),
    ).rejects.toThrow("child failed")
    expect(log.error).toHaveBeenCalledWith(expect.any(Error))
  })
})
