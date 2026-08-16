import { beforeEach, describe, expect, it, vi } from "vitest"

const runWorkflowWithWorkerWakeMock = vi.hoisted(() => vi.fn())
const generateObjectIdMock = vi.hoisted(() => vi.fn(() => "wjob_stable"))

const getWorkspaceByIdMock = vi.hoisted(() => vi.fn())

vi.mock("./client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowWithWorkerWakeMock,
}))

vi.mock("./workflows/workspace-write-commit.js", () => ({
  workspaceWriteCommit: { spec: { name: "workspace-write-commit" } },
}))

vi.mock("../lib/id.js", () => ({
  generateObjectId: generateObjectIdMock,
}))

vi.mock("../models/workspaces.js", () => ({
  getWorkspaceById: getWorkspaceByIdMock,
}))

import { enqueueWorkspaceWriteCommit } from "./enqueue-workspace-write-commit.js"

describe("enqueueWorkspaceWriteCommit", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    generateObjectIdMock.mockReturnValue("wjob_stable")
    getWorkspaceByIdMock.mockResolvedValue({
      desiredGeneration: 3,
      workspaceRepositoryUrl: "https://github.com/acme/docs",
      desiredSha: "aaa",
    })
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      workflowRun: { id: "run_write" },
    })
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
})
