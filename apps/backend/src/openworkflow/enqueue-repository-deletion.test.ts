import { beforeEach, describe, expect, it, vi } from "vitest"

const runWorkflowWithWorkerWakeMock = vi.hoisted(() => vi.fn())
const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn((_orgId: string, fn: () => unknown) => Promise.resolve(fn())),
)
const markUnindexingMock = vi.hoisted(() =>
  vi
    .fn()
    .mockResolvedValue({ updatedAt: new Date("2026-08-03T12:00:00.000Z") }),
)

vi.mock("../db/client.js", () => ({
    tryGetOrgDb: () => ({}),
    tryGetOrgDbOrgId: () => "org_test",
    assertNotInOrgDbContext: () => undefined,

  withOrgDbContext: withOrgDbContextMock,
}))

vi.mock("../models/repositories.js", () => ({
  markRepositoryUnindexing: markUnindexingMock,
}))

vi.mock("./client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowWithWorkerWakeMock,
}))

vi.mock("./workflows/repository-deletion.js", () => ({
  repositoryDeletion: {
    spec: { name: "repository-deletion" },
  },
}))

import {
  enqueueRepositoryDeletionWorkflow,
  repositoryDeletionIdempotencyKey,
} from "./enqueue-repository-deletion.js"

describe("enqueueRepositoryDeletionWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markUnindexingMock.mockResolvedValue({
      updatedAt: new Date("2026-08-03T12:00:00.000Z"),
    })
    withOrgDbContextMock.mockImplementation(
      (_orgId: string, fn: () => unknown) => Promise.resolve(fn()),
    )
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      workflowRun: { id: "run_abc" },
    })
  })

  it("marks unindexing and enqueues with attempt-scoped idempotency key", async () => {
    const log = { error: vi.fn() }
    const result = await enqueueRepositoryDeletionWorkflow(
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        repoName: "ctxpipe",
        zoektRepoId: 42,
      },
      log,
    )

    expect(result).toEqual({ jobId: "run_abc", status: "queued" })
    expect(markUnindexingMock).toHaveBeenCalledWith({ repositoryId: "repo_1" })
    expect(runWorkflowWithWorkerWakeMock).toHaveBeenCalledWith(
      { name: "repository-deletion" },
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        repoName: "ctxpipe",
        zoektRepoId: 42,
      },
      {
        idempotencyKey: repositoryDeletionIdempotencyKey(
          "org_1",
          "repo_1",
          "2026-08-03T12:00:00.000Z",
        ),
      },
    )
    expect(log.error).not.toHaveBeenCalled()
  })

  it("returns null when the repository row is already gone", async () => {
    markUnindexingMock.mockResolvedValue(null)
    const log = { error: vi.fn() }

    await expect(
      enqueueRepositoryDeletionWorkflow(
        { repositoryId: "repo_1", orgId: "org_1" },
        log,
      ),
    ).resolves.toBeNull()

    expect(runWorkflowWithWorkerWakeMock).not.toHaveBeenCalled()
  })
})
