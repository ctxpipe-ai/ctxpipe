import { beforeEach, describe, expect, it, vi } from "vitest"

const runWorkflowWithWorkerWakeMock = vi.hoisted(() => vi.fn())
const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn((_orgId: string, fn: () => unknown) => Promise.resolve(fn())),
)
const tryClaimMock = vi.hoisted(() => vi.fn().mockResolvedValue(true))
const markFailedMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const markReadyMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const getRepositoryForOrgMock = vi.hoisted(() => vi.fn())
const resolveRepositoryRefMock = vi.hoisted(() => vi.fn())
const enqueueFollowUpIfTipAheadMock = vi.hoisted(() => vi.fn())

vi.mock("../db/client.js", () => ({
  withOrgDbContext: withOrgDbContextMock,
}))

vi.mock("../models/repositories.js", () => ({
  getRepositoryForOrg: getRepositoryForOrgMock,
  markRepositoryIndexingFailed: markFailedMock,
  markRepositoryIndexingReady: markReadyMock,
  tryClaimRepositoryIndexingEnqueue: tryClaimMock,
}))

vi.mock("../domain/codeIngestion/queue.js", () => ({
  resolveRepositoryRef: resolveRepositoryRefMock,
}))

vi.mock("./enqueue-follow-up-if-tip-ahead.js", () => ({
  enqueueFollowUpIfTipAhead: enqueueFollowUpIfTipAheadMock,
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
  runConnectorRepositoryIngestionWorkflow,
  startClaimedRepositoryIngestionWorkflow,
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
    runWorkflowWithWorkerWakeMock.mockReset()
    tryClaimMock.mockResolvedValue(true)
    markFailedMock.mockResolvedValue(undefined)
    markReadyMock.mockResolvedValue(undefined)
    enqueueFollowUpIfTipAheadMock.mockResolvedValue({
      enqueued: false,
      tipHash: "sha_already_ingested",
    })
    withOrgDbContextMock.mockImplementation(
      (_orgId: string, fn: () => unknown) => Promise.resolve(fn()),
    )
  })

  it("does not await workflow result", async () => {
    const unresolved = new Promise<void>(() => {})
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      workflowRun: { id: "run_pending", status: "pending" },
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

  it("does not return before workflow creation is acknowledged", async () => {
    let acknowledge: (() => void) | undefined
    runWorkflowWithWorkerWakeMock.mockReturnValueOnce(
      new Promise((resolve) => {
        acknowledge = () =>
          resolve({
            workflowRun: { id: "run_pending", status: "pending" },
            result: vi.fn(),
          })
      }),
    )
    let settled = false

    const pending = enqueueRepositoryIngestionWorkflow(
      { repositoryId: "repo_1", orgId: "org_1" },
      { error: vi.fn() },
    ).finally(() => {
      settled = true
    })

    await vi.waitFor(() => {
      expect(runWorkflowWithWorkerWakeMock).toHaveBeenCalled()
    })
    expect(settled).toBe(false)

    acknowledge?.()
    await pending
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
    expect(markFailedMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      error: failure,
    })
    expect(enqueueFollowUpIfTipAheadMock).toHaveBeenCalledWith(
      {
        orgId: "org_1",
        repositoryId: "repo_1",
        githubConnectionId: undefined,
        targetBranch: undefined,
        pendingOnly: true,
      },
      log,
    )
    expect(log.error).toHaveBeenCalledWith(failure)
  })
})

describe("startClaimedRepositoryIngestionWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runWorkflowWithWorkerWakeMock.mockReset()
    tryClaimMock.mockResolvedValue(true)
    markFailedMock.mockResolvedValue(undefined)
    markReadyMock.mockResolvedValue(undefined)
    enqueueFollowUpIfTipAheadMock.mockReset()
    enqueueFollowUpIfTipAheadMock.mockResolvedValue({
      enqueued: false,
      tipHash: "sha_already_ingested",
    })
    withOrgDbContextMock.mockImplementation(
      (_orgId: string, fn: () => unknown) => Promise.resolve(fn()),
    )
  })

  it("uses the source tip as an idempotency key", async () => {
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      workflowRun: { id: "run_pending", status: "pending" },
    })

    await startClaimedRepositoryIngestionWorkflow(
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        idempotencyKey: "connector-tip:repo_1:sha-1",
      },
      { error: vi.fn() },
    )

    expect(runWorkflowWithWorkerWakeMock).toHaveBeenCalledWith(
      { name: "repository-ingestion-orchestrator" },
      {
        repositoryId: "repo_1",
        orgId: "org_1",
      },
      { idempotencyKey: "connector-tip:repo_1:sha-1" },
    )
  })

  it("restores ready status when an idempotent run already completed", async () => {
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      workflowRun: {
        status: "completed",
        output: { targetHash: "sha_already_ingested" },
      },
    })
    const log = { error: vi.fn() }

    await startClaimedRepositoryIngestionWorkflow(
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        githubConnectionId: "con_github",
        idempotencyKey: "connector-commit:sha_already_ingested",
      },
      log,
    )

    expect(markReadyMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      targetHash: "sha_already_ingested",
    })
    expect(enqueueFollowUpIfTipAheadMock).toHaveBeenCalledWith(
      {
        orgId: "org_1",
        repositoryId: "repo_1",
        ingestedHash: "sha_already_ingested",
        githubConnectionId: "con_github",
        targetBranch: "main",
      },
      log,
    )
  })

  it("starts a fresh idempotent attempt after the source-keyed run failed", async () => {
    runWorkflowWithWorkerWakeMock
      .mockResolvedValueOnce({
        workflowRun: {
          id: "run_failed",
          status: "failed",
          output: null,
          error: { message: "existing workflow failed" },
        },
      })
      .mockResolvedValueOnce({
        workflowRun: {
          id: "run_retry_failed",
          status: "failed",
          output: null,
          error: { message: "retry workflow failed" },
        },
      })
      .mockResolvedValueOnce({
        workflowRun: {
          id: "run_retry",
          status: "pending",
          output: null,
          error: null,
        },
      })
    const log = { error: vi.fn() }

    await startClaimedRepositoryIngestionWorkflow(
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        idempotencyKey: "connector-commit:repo_1:sha_failed",
      },
      log,
    )

    expect(runWorkflowWithWorkerWakeMock).toHaveBeenNthCalledWith(
      1,
      { name: "repository-ingestion-orchestrator" },
      { repositoryId: "repo_1", orgId: "org_1" },
      { idempotencyKey: "connector-commit:repo_1:sha_failed" },
    )
    expect(runWorkflowWithWorkerWakeMock).toHaveBeenNthCalledWith(
      2,
      { name: "repository-ingestion-orchestrator" },
      { repositoryId: "repo_1", orgId: "org_1" },
      {
        idempotencyKey: "connector-commit:repo_1:sha_failed:retry:run_failed",
      },
    )
    expect(runWorkflowWithWorkerWakeMock).toHaveBeenNthCalledWith(
      3,
      { name: "repository-ingestion-orchestrator" },
      { repositoryId: "repo_1", orgId: "org_1" },
      {
        idempotencyKey:
          "connector-commit:repo_1:sha_failed:retry:run_retry_failed",
      },
    )
    expect(markFailedMock).not.toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
  })

  it("walks the complete failed-run history before starting a fresh attempt", async () => {
    for (let index = 0; index < 7; index += 1) {
      runWorkflowWithWorkerWakeMock.mockResolvedValueOnce({
        workflowRun: {
          id: `run_failed_${index}`,
          status: "failed",
          output: null,
          error: { message: `attempt ${index} failed` },
        },
      })
    }
    runWorkflowWithWorkerWakeMock.mockResolvedValueOnce({
      workflowRun: {
        id: "run_pending",
        status: "pending",
        output: null,
        error: null,
      },
    })

    await startClaimedRepositoryIngestionWorkflow(
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        idempotencyKey: "connector-tip:repo_1:sha_tip",
      },
      { error: vi.fn() },
    )

    expect(runWorkflowWithWorkerWakeMock).toHaveBeenCalledTimes(8)
    expect(runWorkflowWithWorkerWakeMock).toHaveBeenLastCalledWith(
      { name: "repository-ingestion-orchestrator" },
      { repositoryId: "repo_1", orgId: "org_1" },
      {
        idempotencyKey: "connector-tip:repo_1:sha_tip:retry:run_failed_6",
      },
    )
    expect(markFailedMock).not.toHaveBeenCalled()
  })

  it("fails a cyclic failed-run history without spinning", async () => {
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      workflowRun: {
        id: "run_cycle",
        status: "failed",
        output: null,
        error: { message: "cyclic workflow failure" },
      },
    })

    await expect(
      startClaimedRepositoryIngestionWorkflow(
        {
          repositoryId: "repo_1",
          orgId: "org_1",
          idempotencyKey: "connector-tip:repo_1:sha_tip",
        },
        { error: vi.fn() },
      ),
    ).rejects.toThrow("cyclic workflow failure")

    expect(runWorkflowWithWorkerWakeMock).toHaveBeenCalledTimes(2)
  })
})

describe("claimAndRunRepositoryIngestionChild", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runWorkflowWithWorkerWakeMock.mockReset()
    tryClaimMock.mockResolvedValue(true)
    markFailedMock.mockResolvedValue(undefined)
    markReadyMock.mockResolvedValue(undefined)
    enqueueFollowUpIfTipAheadMock.mockResolvedValue({
      enqueued: false,
      tipHash: "sha_already_ingested",
    })
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
    expect(markFailedMock).not.toHaveBeenCalled()
  })

  it("logs, releases the claim, and rethrows child failures", async () => {
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
    expect(markFailedMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      error: expect.any(Error),
    })
  })
})

describe("runConnectorRepositoryIngestionWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runWorkflowWithWorkerWakeMock.mockReset()
    tryClaimMock.mockResolvedValue(true)
    markFailedMock.mockResolvedValue(undefined)
    markReadyMock.mockResolvedValue(undefined)
    getRepositoryForOrgMock.mockResolvedValue({
      id: "repo_1",
      githubConnectionId: "con_github",
      lastIngestedHash: "sha_ingested",
    })
    resolveRepositoryRefMock.mockResolvedValue({
      hash: "sha_tip",
      branch: "main",
    })
    withOrgDbContextMock.mockImplementation(
      (_orgId: string, fn: () => unknown) => Promise.resolve(fn()),
    )
  })

  it("recovers an uncheckpointed connector commit from the branch tip", async () => {
    const step = mockChildStep()

    await runConnectorRepositoryIngestionWorkflow(
      step,
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Syncing connector content",
      },
      { error: vi.fn() },
    )

    expect(resolveRepositoryRefMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      orgId: "org_1",
      branch: "main",
      githubConnectionId: "con_github",
    })
    expect(step.runWorkflow).toHaveBeenCalledWith(
      { name: "repository-ingestion-orchestrator" },
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Syncing connector content",
        githubConnectionId: "con_github",
      },
      { name: "ingest-repo_1" },
    )
    expect(runWorkflowWithWorkerWakeMock).not.toHaveBeenCalled()
  })

  it("does not regress an already-ingested branch tip", async () => {
    const step = mockChildStep()
    resolveRepositoryRefMock.mockResolvedValueOnce({
      hash: "sha_ingested",
      branch: "main",
    })

    await runConnectorRepositoryIngestionWorkflow(
      step,
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Syncing connector content",
      },
      { error: vi.fn() },
    )

    expect(tryClaimMock).not.toHaveBeenCalled()
    expect(step.runWorkflow).not.toHaveBeenCalled()
    expect(runWorkflowWithWorkerWakeMock).not.toHaveBeenCalled()
  })
})
