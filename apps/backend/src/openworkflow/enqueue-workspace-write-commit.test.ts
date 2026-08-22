import { beforeEach, describe, expect, it, vi } from "vitest"

const runWorkflowWithWorkerWakeMock = vi.hoisted(() => vi.fn())
const generateObjectIdMock = vi.hoisted(() => vi.fn(() => "wjob_stable"))

const getWorkspaceByIdMock = vi.hoisted(() => vi.fn())
const persistHydrateFailureMock = vi.hoisted(() => vi.fn())
const persistWriteJobIntentMock = vi.hoisted(() => vi.fn())
const persistWriteJobStatusMock = vi.hoisted(() => vi.fn())
const persistWriteStatusMock = vi.hoisted(() => vi.fn())

vi.mock("./client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowWithWorkerWakeMock,
}))

vi.mock("./workflows/workspace-write-commit.js", () => ({
  workspaceWriteCommit: { spec: { name: "workspace-write-commit" } },
}))

vi.mock("../lib/id.js", () => ({
  generateObjectId: generateObjectIdMock,
}))

vi.mock("../db/client.js", () => ({
    tryGetOrgDb: () => ({}),
    tryGetOrgDbOrgId: () => "org_test",
    assertNotInOrgDbContext: () => undefined,

  withOrgDbContext: (_orgId: string, fn: () => unknown) =>
    Promise.resolve(fn()),
}))

vi.mock("../models/workspaces.js", () => ({
  getWorkspaceById: getWorkspaceByIdMock,
  persistHydrateFailure: persistHydrateFailureMock,
  persistWriteJobIntent: persistWriteJobIntentMock,
  persistWriteJobStatus: persistWriteJobStatusMock,
  persistWriteStatus: persistWriteStatusMock,
}))

import { enqueueWorkspaceWriteCommit } from "./enqueue-workspace-write-commit.js"

describe("enqueueWorkspaceWriteCommit", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    generateObjectIdMock.mockReturnValue("wjob_stable")
    getWorkspaceByIdMock.mockResolvedValue({
      id: "ws_1",
      desiredGeneration: 3,
      workspaceRepositoryUrl: "https://github.com/acme/docs",
      desiredSha: "aaa",
      writeStatus: "writable",
    })
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      workflowRun: { id: "run_write" },
    })
    persistHydrateFailureMock.mockResolvedValue(undefined)
    persistWriteJobIntentMock.mockResolvedValue(undefined)
    persistWriteJobStatusMock.mockResolvedValue(undefined)
    persistWriteStatusMock.mockResolvedValue(undefined)
  })

  it("enqueues a migration export write with a stable job id", async () => {
    const log = { error: vi.fn() }
    await enqueueWorkspaceWriteCommit(
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        kind: "migration_export",
      },
      log,
    )
    expect(generateObjectIdMock).toHaveBeenCalledWith("wjob")
    expect(runWorkflowWithWorkerWakeMock).toHaveBeenCalledWith(
      { name: "workspace-write-commit" },
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        kind: "migration_export",
        jobId: "wjob_stable",
        jobGeneration: 3,
        jobWorkspaceUrl: "https://github.com/acme/docs",
        jobDesiredSha: "aaa",
      },
    )
  })

  it("reuses a caller-supplied job id on retry", async () => {
    const log = { error: vi.fn() }
    await enqueueWorkspaceWriteCommit(
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        kind: "extract_ingest",
        jobId: "wjob_existing",
      },
      log,
    )
    expect(generateObjectIdMock).not.toHaveBeenCalled()
    expect(runWorkflowWithWorkerWakeMock).toHaveBeenCalledWith(
      { name: "workspace-write-commit" },
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        kind: "extract_ingest",
        jobId: "wjob_existing",
        jobGeneration: 3,
        jobWorkspaceUrl: "https://github.com/acme/docs",
        jobDesiredSha: "aaa",
      },
    )
  })

  it("parks the job as paused when the workflow queue fails", async () => {
    runWorkflowWithWorkerWakeMock.mockRejectedValue(new Error("queue down"))
    const log = { error: vi.fn() }
    await enqueueWorkspaceWriteCommit(
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        kind: "migration_export",
      },
      log,
    )
    expect(persistHydrateFailureMock).not.toHaveBeenCalled()
    expect(persistWriteJobStatusMock).toHaveBeenCalledWith(
      "wjob_stable",
      "paused",
    )
  })

  it("persists a paused link payload and does not start the workflow", async () => {
    getWorkspaceByIdMock.mockResolvedValue({
      id: "ws_1",
      desiredGeneration: 1,
      workspaceRepositoryUrl: "https://github.com/acme/docs",
      desiredSha: null,
      writeStatus: "unknown",
    })
    const log = { error: vi.fn() }
    await enqueueWorkspaceWriteCommit(
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        kind: "link_unlink",
        linkAction: "link",
        linkGitUrl: "https://github.com/acme/app.git",
      },
      log,
    )
    expect(persistWriteJobIntentMock).toHaveBeenCalledWith({
      id: "wjob_stable",
      workspaceId: "ws_1",
      kind: "link_unlink",
      generation: 1,
      desiredSha: null,
      status: "paused",
      payload: {
        linkAction: "link",
        linkGitUrl: "https://github.com/acme/app.git",
        jobWorkspaceUrl: "https://github.com/acme/docs",
      },
    })
    expect(runWorkflowWithWorkerWakeMock).not.toHaveBeenCalled()
  })

  it("parks an unwritable migration export without failing hydrate", async () => {
    getWorkspaceByIdMock.mockResolvedValue({
      id: "ws_1",
      desiredGeneration: 1,
      workspaceRepositoryUrl: "https://github.com/acme/docs",
      desiredSha: null,
      writeStatus: "read_only",
    })
    const log = { error: vi.fn() }
    const result = await enqueueWorkspaceWriteCommit(
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        kind: "migration_export",
      },
      log,
    )
    expect(result).toEqual({ started: false })
    expect(runWorkflowWithWorkerWakeMock).not.toHaveBeenCalled()
    expect(persistWriteJobIntentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "migration_export",
        status: "paused",
      }),
    )
    expect(persistHydrateFailureMock).not.toHaveBeenCalled()
  })

  it("starts the workflow when the workspace snapshot cannot be loaded", async () => {
    getWorkspaceByIdMock.mockRejectedValue(new Error("db down"))
    const log = { error: vi.fn() }
    await enqueueWorkspaceWriteCommit(
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        kind: "migration_export",
      },
      log,
    )
    expect(persistWriteJobIntentMock).not.toHaveBeenCalled()
    expect(runWorkflowWithWorkerWakeMock).toHaveBeenCalled()
  })
})
