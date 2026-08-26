import { beforeEach, describe, expect, it, vi } from "vitest"

const runWorkflowWithWorkerWakeMock = vi.hoisted(() => vi.fn())

vi.mock("./client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowWithWorkerWakeMock,
}))

vi.mock("./workflows/workspace-commit-projection.js", () => ({
  workspaceCommitProjection: { spec: { name: "workspace-commit-projection" } },
}))

import { enqueueWorkspaceCommitProjection } from "./enqueue-workspace-commit-projection.js"

describe("enqueueWorkspaceCommitProjection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      workflowRun: { id: "run_commits" },
    })
  })

  it("enqueues a workspace commit projection job", async () => {
    const log = { error: vi.fn() }
    await enqueueWorkspaceCommitProjection(
      { orgId: "org_1", workspaceId: "ws_1" },
      log,
    )
    expect(runWorkflowWithWorkerWakeMock).toHaveBeenCalledWith(
      { name: "workspace-commit-projection" },
      { orgId: "org_1", workspaceId: "ws_1" },
    )
  })
})
