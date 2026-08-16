import { beforeEach, describe, expect, it, vi } from "vitest"

const runWorkflowWithWorkerWakeMock = vi.hoisted(() => vi.fn())

vi.mock("./client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowWithWorkerWakeMock,
}))

vi.mock("./workflows/workspace-hydrate.js", () => ({
  workspaceHydrate: { spec: { name: "workspace-hydrate" } },
}))

import { enqueueWorkspaceHydrate } from "./enqueue-workspace-hydrate.js"

describe("enqueueWorkspaceHydrate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      workflowRun: { id: "run_hydrate" },
    })
  })

  it("enqueues hydrate for a Workspace", async () => {
    const log = { error: vi.fn() }
    await enqueueWorkspaceHydrate({ orgId: "org_1", workspaceId: "ws_1" }, log)
    expect(runWorkflowWithWorkerWakeMock).toHaveBeenCalledWith(
      { name: "workspace-hydrate" },
      { orgId: "org_1", workspaceId: "ws_1" },
    )
  })
})
