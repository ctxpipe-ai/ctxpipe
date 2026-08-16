import { beforeEach, describe, expect, it, vi } from "vitest"

const runWorkflowWithWorkerWakeMock = vi.hoisted(() => vi.fn())

vi.mock("./client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowWithWorkerWakeMock,
}))

vi.mock("./workflows/workspace-index.js", () => ({
  workspaceIndex: { spec: { name: "workspace-index" } },
}))

import { enqueueWorkspaceIndex } from "./enqueue-workspace-index.js"

describe("enqueueWorkspaceIndex", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      workflowRun: { id: "run_index" },
    })
  })

  it("enqueues a Workspace-scoped index job", async () => {
    const log = { error: vi.fn() }
    await enqueueWorkspaceIndex(
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        gitUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        role: "workspace",
      },
      log,
    )
    expect(runWorkflowWithWorkerWakeMock).toHaveBeenCalledWith(
      { name: "workspace-index" },
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        gitUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        role: "workspace",
      },
    )
  })
})
