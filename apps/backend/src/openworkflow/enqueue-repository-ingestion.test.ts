import { beforeEach, describe, expect, it, vi } from "vitest"

const runWorkflowWithWorkerWakeMock = vi.hoisted(() => vi.fn())
const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn((_orgId: string, fn: () => unknown) => Promise.resolve(fn())),
)
const tryClaimMock = vi.hoisted(() => vi.fn().mockResolvedValue(true))
const markFailedMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock("../db/client.js", () => ({
  withOrgDbContext: withOrgDbContextMock,
}))

vi.mock("../models/repositories.js", () => ({
  markRepositoryIndexingFailed: markFailedMock,
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
  enqueueRepositoryIngestionWorkflow,
  runRepositoryIngestionWorkflow,
} from "./enqueue-repository-ingestion.js"

describe("enqueueRepositoryIngestionWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tryClaimMock.mockResolvedValue(true)
    markFailedMock.mockResolvedValue(undefined)
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

  it("releases the queued claim when workflow enqueue fails", async () => {
    const failure = new Error("enqueue failed")
    runWorkflowWithWorkerWakeMock.mockRejectedValue(failure)
    const log = { error: vi.fn() }

    await enqueueRepositoryIngestionWorkflow(
      { repositoryId: "repo_1", orgId: "org_1" },
      log,
    )
    await vi.waitFor(() => {
      expect(markFailedMock).toHaveBeenCalledWith({
        repositoryId: "repo_1",
        error: failure,
      })
      expect(log.error).toHaveBeenCalledWith(failure)
    })
  })
})

describe("runRepositoryIngestionWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tryClaimMock.mockResolvedValue(true)
    markFailedMock.mockResolvedValue(undefined)
    withOrgDbContextMock.mockImplementation(
      (_orgId: string, fn: () => unknown) => Promise.resolve(fn()),
    )
  })

  it("awaits workflow wake when claim succeeds", async () => {
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      result: vi.fn().mockRejectedValue(new Error("terminal failure")),
    })
    const log = { error: vi.fn() }

    await runRepositoryIngestionWorkflow(
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

  it("skips workflow when indexing is already queued or running", async () => {
    tryClaimMock.mockResolvedValue(false)
    const log = { error: vi.fn() }

    await runRepositoryIngestionWorkflow(
      { repositoryId: "repo_1", orgId: "org_1" },
      log,
    )

    expect(runWorkflowWithWorkerWakeMock).not.toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
  })

  it("releases the queued claim when awaited workflow enqueue fails", async () => {
    const failure = new Error("enqueue failed")
    runWorkflowWithWorkerWakeMock.mockRejectedValue(failure)
    const log = { error: vi.fn() }

    await expect(
      runRepositoryIngestionWorkflow(
        { repositoryId: "repo_1", orgId: "org_1" },
        log,
      ),
    ).rejects.toThrow("enqueue failed")
    expect(markFailedMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      error: failure,
    })
    expect(log.error).toHaveBeenCalledWith(failure)
  })
})
