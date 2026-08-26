import { beforeEach, describe, expect, it, vi } from "vitest"

const runWorkflowWithWorkerWakeMock = vi.hoisted(() => vi.fn())
const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn((_orgId: string, fn: () => unknown) => Promise.resolve(fn())),
)
const tryClaimMock = vi.hoisted(() => vi.fn().mockResolvedValue(true))
const markFailedMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const resolveRepositoryRefMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ hash: "sha_tip", branch: "main" }),
)

vi.mock("../db/client.js", () => ({
  withOrgDbContext: withOrgDbContextMock,
}))

vi.mock("../models/repositories.js", () => ({
  markRepositoryIndexingFailed: markFailedMock,
  tryClaimRepositoryIndexingEnqueue: tryClaimMock,
}))

vi.mock("../domain/codeIngestion/queue.js", () => ({
  resolveRepositoryRef: resolveRepositoryRefMock,
}))

vi.mock("./client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowWithWorkerWakeMock,
}))

vi.mock("./workflows/repository-ingestion-orchestrator.js", () => ({
  repositoryIngestionOrchestrator: {
    spec: { name: "repository-ingestion-orchestrator" },
  },
}))

// Dynamic import inside the implementation — keep mock in place before import.
import { enqueueFollowUpIfTipAhead } from "./enqueue-follow-up-if-tip-ahead.js"

describe("enqueueFollowUpIfTipAhead", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tryClaimMock.mockResolvedValue(true)
    markFailedMock.mockResolvedValue(undefined)
    resolveRepositoryRefMock.mockResolvedValue({
      hash: "sha_tip",
      branch: "main",
    })
    withOrgDbContextMock.mockImplementation(
      (_orgId: string, fn: () => unknown) => Promise.resolve(fn()),
    )
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      result: vi.fn().mockResolvedValue(undefined),
    })
  })

  it("enqueues when tip is ahead of ingested hash", async () => {
    const log = { error: vi.fn() }

    const result = await enqueueFollowUpIfTipAhead(
      {
        orgId: "org_1",
        repositoryId: "repo_1",
        ingestedHash: "sha_ingested",
        githubConnectionId: "con_1",
        targetBranch: "main",
      },
      log,
    )

    expect(result).toEqual({ enqueued: true, tipHash: "sha_tip" })
    expect(resolveRepositoryRefMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      orgId: "org_1",
      branch: "main",
      githubConnectionId: "con_1",
    })
    expect(tryClaimMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      reason: "follow-up",
    })
    await vi.waitFor(() => {
      expect(runWorkflowWithWorkerWakeMock).toHaveBeenCalledWith(
        { name: "repository-ingestion-orchestrator" },
        expect.objectContaining({
          repositoryId: "repo_1",
          orgId: "org_1",
          indexingReason: "follow-up",
          targetBranch: "main",
        }),
      )
    })
  })

  it("does not enqueue when tip equals ingested hash", async () => {
    resolveRepositoryRefMock.mockResolvedValue({
      hash: "sha_same",
      branch: "main",
    })
    const log = { error: vi.fn() }

    const result = await enqueueFollowUpIfTipAhead(
      {
        orgId: "org_1",
        repositoryId: "repo_1",
        ingestedHash: "sha_same",
      },
      log,
    )

    expect(result).toEqual({ enqueued: false, tipHash: "sha_same" })
    expect(tryClaimMock).not.toHaveBeenCalled()
    expect(runWorkflowWithWorkerWakeMock).not.toHaveBeenCalled()
  })

  it("does not wake when claim fails after tip moved", async () => {
    tryClaimMock.mockResolvedValue(false)
    const log = { error: vi.fn() }

    const result = await enqueueFollowUpIfTipAhead(
      {
        orgId: "org_1",
        repositoryId: "repo_1",
        ingestedHash: "sha_old",
      },
      log,
    )

    expect(result).toEqual({ enqueued: false, tipHash: "sha_tip" })
    expect(runWorkflowWithWorkerWakeMock).not.toHaveBeenCalled()
  })

  it("swallows resolve errors so successful ingest is not undone", async () => {
    resolveRepositoryRefMock.mockRejectedValue(new Error("resolve failed"))
    const log = { error: vi.fn() }

    const result = await enqueueFollowUpIfTipAhead(
      {
        orgId: "org_1",
        repositoryId: "repo_1",
        ingestedHash: "sha_ingested",
      },
      log,
    )

    expect(result).toEqual({ enqueued: false })
    expect(log.error).toHaveBeenCalled()
    expect(runWorkflowWithWorkerWakeMock).not.toHaveBeenCalled()
  })

  it("releases the claim when follow-up workflow enqueue fails", async () => {
    const failure = new Error("enqueue failed")
    runWorkflowWithWorkerWakeMock.mockRejectedValue(failure)
    const log = { error: vi.fn() }

    await expect(
      enqueueFollowUpIfTipAhead(
        {
          orgId: "org_1",
          repositoryId: "repo_1",
          ingestedHash: "sha_ingested",
        },
        log,
      ),
    ).resolves.toEqual({ enqueued: true, tipHash: "sha_tip" })

    await vi.waitFor(() => {
      expect(markFailedMock).toHaveBeenCalledWith({
        repositoryId: "repo_1",
        error: failure,
      })
    })
    expect(log.error).toHaveBeenCalledWith(failure)
  })
})
