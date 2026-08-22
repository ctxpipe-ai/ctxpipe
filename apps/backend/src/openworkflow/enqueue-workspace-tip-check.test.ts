import { beforeEach, describe, expect, it, vi } from "vitest"

const runWorkflowWithWorkerWakeMock = vi.hoisted(() => vi.fn())

vi.mock("./client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowWithWorkerWakeMock,
}))

vi.mock("./workflows/workspace-tip-check.js", () => ({
  workspaceTipCheck: { spec: { name: "workspace-tip-check" } },
}))

import { enqueueWorkspaceTipCheck } from "./enqueue-workspace-tip-check.js"

describe("enqueueWorkspaceTipCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      workflowRun: { id: "run_tip" },
    })
  })

  it("enqueues the org tip-check workflow", async () => {
    const log = { error: vi.fn() }
    await enqueueWorkspaceTipCheck("org_1", log)
    expect(runWorkflowWithWorkerWakeMock).toHaveBeenCalledWith(
      { name: "workspace-tip-check" },
      { orgId: "org_1" },
    )
    expect(log.error).not.toHaveBeenCalled()
  })
})
