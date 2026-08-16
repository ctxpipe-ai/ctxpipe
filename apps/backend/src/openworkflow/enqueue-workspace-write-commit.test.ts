import { beforeEach, describe, expect, it, vi } from "vitest"

const runWorkflowWithWorkerWakeMock = vi.hoisted(() => vi.fn())

vi.mock("./client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowWithWorkerWakeMock,
}))

vi.mock("./workflows/workspace-write-commit.js", () => ({
  workspaceWriteCommit: { spec: { name: "workspace-write-commit" } },
}))

import { enqueueWorkspaceWriteCommit } from "./enqueue-workspace-write-commit.js"

describe("enqueueWorkspaceWriteCommit", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      workflowRun: { id: "run_write" },
    })
  })

  it("enqueues a migration export write", async () => {
    const log = { error: vi.fn() }
    await enqueueWorkspaceWriteCommit(
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        kind: "migration_export",
      },
      log,
    )
    expect(runWorkflowWithWorkerWakeMock).toHaveBeenCalledWith(
      { name: "workspace-write-commit" },
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        kind: "migration_export",
      },
    )
  })
})
