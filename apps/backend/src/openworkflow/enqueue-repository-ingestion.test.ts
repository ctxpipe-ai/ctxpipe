import { beforeEach, describe, expect, it, vi } from "vitest"

const runWorkflowWithWorkerWakeMock = vi.hoisted(() => vi.fn())
const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn((_orgId: string, fn: () => unknown) => Promise.resolve(fn())),
)
const markPendingMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock("../db/client.js", () => ({
  withOrgDbContext: withOrgDbContextMock,
}))

vi.mock("../models/repositories.js", () => ({
  markRepositoryIndexingPending: markPendingMock,
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
    markPendingMock.mockResolvedValue(undefined)
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

    expect(markPendingMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      reason: null,
    })
    expect(log.error).not.toHaveBeenCalled()
  })
})

describe("runRepositoryIngestionWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markPendingMock.mockResolvedValue(undefined)
    withOrgDbContextMock.mockImplementation(
      (_orgId: string, fn: () => unknown) => Promise.resolve(fn()),
    )
  })

  it("awaits workflow result and rethrows terminal failures", async () => {
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      result: vi.fn().mockRejectedValue(new Error("terminal failure")),
    })
    const log = { error: vi.fn() }

    await expect(
      runRepositoryIngestionWorkflow(
        { repositoryId: "repo_1", orgId: "org_1" },
        log,
      ),
    ).rejects.toThrow("terminal failure")

    expect(log.error).toHaveBeenCalled()
  })
})
