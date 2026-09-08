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

vi.mock("../config/env.js", () => ({
  parseEnv: () => ({}),
}))

vi.mock("../routes/webhooks/github/github-workspace-tip.js", () => ({
  getGithubRepoWriteView: vi.fn(async () => ({
    defaultBranch: "main",
    canPush: true,
  })),
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
      githubConnectionId: "con_1",
    })
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      workflowRun: { id: "run_write" },
    })
    persistHydrateFailureMock.mockResolvedValue(undefined)
    persistWriteJobIntentMock.mockResolvedValue(undefined)
    persistWriteJobStatusMock.mockResolvedValue(undefined)
    persistWriteStatusMock.mockResolvedValue(undefined)
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
})
