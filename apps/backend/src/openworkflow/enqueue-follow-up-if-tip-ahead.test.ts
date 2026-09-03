import { beforeEach, describe, expect, it, vi } from "vitest"

const runWorkflowWithWorkerWakeMock = vi.hoisted(() => vi.fn())
const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn((_orgId: string, fn: () => unknown) => Promise.resolve(fn())),
)
const tryClaimMock = vi.hoisted(() => vi.fn().mockResolvedValue(true))
const markFailedMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const markPendingMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const clearPendingMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const hasPendingMock = vi.hoisted(() => vi.fn().mockResolvedValue(true))
const resolveRepositoryRefMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ hash: "sha_tip", branch: "main" }),
)

vi.mock("../db/client.js", () => ({
  withOrgDbContext: withOrgDbContextMock,
}))

vi.mock("../models/repositories.js", () => ({
  clearRepositoryIndexingFollowUpPending: clearPendingMock,
  hasPendingRepositoryIndexingFollowUp: hasPendingMock,
  markRepositoryIndexingFailed: markFailedMock,
  markRepositoryIndexingFollowUpPending: markPendingMock,
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
    markPendingMock.mockResolvedValue(undefined)
    clearPendingMock.mockResolvedValue(undefined)
    hasPendingMock.mockResolvedValue(true)
    resolveRepositoryRefMock.mockResolvedValue({
      hash: "sha_tip",
      branch: "main",
    })
    withOrgDbContextMock.mockImplementation(
      (_orgId: string, fn: () => unknown) => Promise.resolve(fn()),
    )
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      workflowRun: { status: "pending" },
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
        {
          repositoryId: "repo_1",
          orgId: "org_1",
          indexingReason: "follow-up",
          targetBranch: "main",
          githubConnectionId: "con_1",
        },
        { idempotencyKey: "follow-up-tip:repo_1:sha_tip" },
      )
    })
  })

  it("does not report success before workflow creation is acknowledged", async () => {
    let acknowledge: (() => void) | undefined
    runWorkflowWithWorkerWakeMock.mockReturnValueOnce(
      new Promise((resolve) => {
        acknowledge = () =>
          resolve({
            workflowRun: { status: "pending" },
            result: vi.fn(),
          })
      }),
    )
    let settled = false

    const pending = enqueueFollowUpIfTipAhead(
      {
        orgId: "org_1",
        repositoryId: "repo_1",
        ingestedHash: "sha_ingested",
      },
      { error: vi.fn() },
    ).finally(() => {
      settled = true
    })

    await vi.waitFor(() => {
      expect(runWorkflowWithWorkerWakeMock).toHaveBeenCalled()
    })
    expect(settled).toBe(false)

    acknowledge?.()
    await expect(pending).resolves.toEqual({
      enqueued: true,
      tipHash: "sha_tip",
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
    expect(clearPendingMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      ingestedHash: "sha_same",
    })
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

  it("preserves and throws resolve errors for durable workflow retry", async () => {
    resolveRepositoryRefMock.mockRejectedValue(new Error("resolve failed"))
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
    ).rejects.toThrow("resolve failed")
    expect(markPendingMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
    })
    expect(log.error).toHaveBeenCalled()
    expect(runWorkflowWithWorkerWakeMock).not.toHaveBeenCalled()
  })

  it("preserves and throws when follow-up workflow enqueue fails", async () => {
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
    ).rejects.toThrow("enqueue failed")

    expect(markFailedMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      error: failure,
    })
    expect(markPendingMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
    })
    expect(log.error).toHaveBeenCalledWith(failure)
  })

  it("does not resolve a failure follow-up when no request is pending", async () => {
    hasPendingMock.mockResolvedValue(false)

    await expect(
      enqueueFollowUpIfTipAhead(
        {
          orgId: "org_1",
          repositoryId: "repo_1",
          pendingOnly: true,
        },
        { error: vi.fn() },
      ),
    ).resolves.toEqual({ enqueued: false })

    expect(resolveRepositoryRefMock).not.toHaveBeenCalled()
    expect(runWorkflowWithWorkerWakeMock).not.toHaveBeenCalled()
  })
})
