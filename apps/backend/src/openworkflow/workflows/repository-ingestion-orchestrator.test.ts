import { beforeEach, describe, expect, it, vi } from "vitest"

const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn((_orgId: string, fn: () => unknown) => Promise.resolve(fn())),
)
const markRepositoryIndexingFailedMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
)
const getLoggerErrorMock = vi.hoisted(() => vi.fn())

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
      },
      step,
    } as never)

    expect(step.runWorkflow).toHaveBeenCalledWith(
      { name: "repository-ingestion" },
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        indexingReason: "manual",
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
      run: vi.fn(
        async (_opts: { name: string }, fn: () => Promise<unknown>) => fn(),
      ),
    }

    await expect(
      repositoryIngestionOrchestrator.fn({
        input: { repositoryId: "repo_1", orgId: "org_1" },
        step,
      } as never),
    ).rejects.toThrow("child failed")

    expect(step.run).toHaveBeenCalledWith(
      { name: "mark-failed" },
      expect.any(Function),
    )
    expect(markRepositoryIndexingFailedMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      error: childError,
    })
  })
})
