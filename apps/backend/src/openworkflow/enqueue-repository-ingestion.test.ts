import { beforeEach, describe, expect, it, vi } from "vitest"

const runWorkflowWithWorkerWakeMock = vi.hoisted(() => vi.fn())
const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn((_orgId: string, fn: () => unknown) => Promise.resolve(fn())),
)
const markPendingMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const markFailedMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock("../db/client.js", () => ({
  withOrgDbContext: withOrgDbContextMock,
}))

vi.mock("../models/repositories.js", () => ({
  markRepositoryIndexingPending: markPendingMock,
  markRepositoryIndexingFailed: markFailedMock,
}))

vi.mock("./client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowWithWorkerWakeMock,
}))

vi.mock("./workflows/repository-ingestion.js", () => ({
  repositoryIngestion: { spec: { name: "repository-ingestion" } },
}))

import {
  enqueueRepositoryIngestionWorkflow,
  runRepositoryIngestionWorkflow,
} from "./enqueue-repository-ingestion.js"

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushAsyncWork() {
  await Promise.resolve()
  await Promise.resolve()
}

describe("enqueueRepositoryIngestionWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markPendingMock.mockResolvedValue(undefined)
    markFailedMock.mockResolvedValue(undefined)
    withOrgDbContextMock.mockImplementation(
      (_orgId: string, fn: () => unknown) => Promise.resolve(fn()),
    )
  })

  it("marks failed only after workflow result rejects", async () => {
    const resultDeferred = deferred<void>()
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      result: vi.fn().mockReturnValue(resultDeferred.promise),
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
    expect(markFailedMock).not.toHaveBeenCalled()

    resultDeferred.reject(new Error("ingest failed after retries"))
    await flushAsyncWork()

    expect(markFailedMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      error: expect.any(Error),
    })
    expect(log.error).toHaveBeenCalled()
  })
})

describe("runRepositoryIngestionWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markPendingMock.mockResolvedValue(undefined)
    markFailedMock.mockResolvedValue(undefined)
    withOrgDbContextMock.mockImplementation(
      (_orgId: string, fn: () => unknown) => Promise.resolve(fn()),
    )
  })

  it("awaits workflow result and marks terminal failures", async () => {
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

    expect(markFailedMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      error: expect.any(Error),
    })
    expect(log.error).toHaveBeenCalled()
  })
})
