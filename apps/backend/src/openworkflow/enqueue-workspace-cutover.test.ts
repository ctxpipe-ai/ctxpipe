import { beforeEach, describe, expect, it, vi } from "vitest"

const runWorkflowWithWorkerWakeMock = vi.hoisted(() => vi.fn())

vi.mock("./client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowWithWorkerWakeMock,
}))

vi.mock("./workflows/workspace-cutover.js", () => ({
  workspaceCutover: { spec: { name: "workspace-cutover" } },
}))

import { enqueueWorkspaceCutover } from "./enqueue-workspace-cutover.js"

describe("enqueueWorkspaceCutover", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runWorkflowWithWorkerWakeMock.mockResolvedValue({
      workflowRun: { id: "run_cutover" },
    })
  })

  it("enqueues the org cutover workflow", async () => {
    const log = { error: vi.fn() }
    await enqueueWorkspaceCutover("org_1", log)
    expect(runWorkflowWithWorkerWakeMock).toHaveBeenCalledWith(
      { name: "workspace-cutover" },
      { orgId: "org_1" },
    )
  })
})
