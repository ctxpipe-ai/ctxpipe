import { beforeEach, describe, expect, it, vi } from "vitest"

const markDeletionQueuedMock = vi.hoisted(() => vi.fn())
const runWorkflowMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ workflowRun: { id: "wr_delete_1" } }),
)

vi.mock("../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, fn: () => Promise<unknown>) => fn(),
}))

vi.mock("../models/repositories.js", () => ({
  markRepositoryDeletionQueued: markDeletionQueuedMock,
}))

vi.mock("./client.js", () => ({
  runWorkflowWithWorkerWake: (...args: unknown[]) => runWorkflowMock(...args),
}))

import {
  enqueueRepositoryDeletionWorkflow,
  repositoryDeletionIdempotencyKey,
} from "./enqueue-repository-deletion.js"
import { repositoryDeletion } from "./workflows/repository-deletion.js"

describe("enqueueRepositoryDeletionWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runWorkflowMock.mockResolvedValue({ workflowRun: { id: "wr_delete_1" } })
  })

  it("returns null when the repository row is missing", async () => {
    markDeletionQueuedMock.mockResolvedValue(false)

    const result = await enqueueRepositoryDeletionWorkflow(
      { repositoryId: "repo_missing", orgId: "org_1" },
      { error: vi.fn() },
    )

    expect(result).toBeNull()
    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it("marks deleting and enqueues workflow with idempotency key", async () => {
    markDeletionQueuedMock.mockResolvedValue(true)

    const result = await enqueueRepositoryDeletionWorkflow(
      { repositoryId: "repo_1", orgId: "org_1" },
      { error: vi.fn() },
    )

    expect(result).toEqual({
      jobId: "wr_delete_1",
      status: "queued",
    })
    expect(markDeletionQueuedMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
    })
    expect(runWorkflowMock).toHaveBeenCalledWith(
      repositoryDeletion.spec,
      { repositoryId: "repo_1", orgId: "org_1" },
      {
        idempotencyKey: repositoryDeletionIdempotencyKey("org_1", "repo_1"),
      },
    )
  })
})
