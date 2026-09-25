import { beforeEach, describe, expect, it, vi } from "vitest"

const executeMock = vi.hoisted(() => vi.fn())
const cancelWorkflowRunMock = vi.hoisted(() => vi.fn())
const logErrorMock = vi.hoisted(() => vi.fn())
const logInfoMock = vi.hoisted(() => vi.fn())

vi.mock("../db/client.js", () => ({
  getSystemDb: () => ({ execute: executeMock }),
}))

vi.mock("./client.js", () => ({
  ow: { cancelWorkflowRun: cancelWorkflowRunMock },
}))

vi.mock("./namespace.js", () => ({
  openWorkflowNamespaceId: () => "preview-pr-343",
}))

vi.mock("../observability/logger.js", () => ({
  log: { error: logErrorMock, info: logInfoMock },
}))

import { cancelActiveRepositoryIngestion } from "./cancel-repository-ingestion.js"

describe("cancelActiveRepositoryIngestion", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cancelWorkflowRunMock.mockResolvedValue(undefined)
  })

  it("cancels active ingestion runs for the repository", async () => {
    executeMock.mockResolvedValue({
      rows: [{ id: "run_ingest" }, { id: "run_index" }],
    })

    await expect(
      cancelActiveRepositoryIngestion({
        orgId: "org_1",
        repositoryId: "repo_1",
      }),
    ).resolves.toEqual(["run_ingest", "run_index"])

    expect(cancelWorkflowRunMock).toHaveBeenCalledTimes(2)
    expect(cancelWorkflowRunMock).toHaveBeenCalledWith("run_ingest")
    expect(cancelWorkflowRunMock).toHaveBeenCalledWith("run_index")
    expect(logInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "repository-deletion.cancel-ingestion",
        repositoryId: "repo_1",
        workflowRunIds: ["run_ingest", "run_index"],
      }),
    )
  })

  it("ignores runs that already finished", async () => {
    executeMock.mockResolvedValue([{ id: "run_done" }])
    cancelWorkflowRunMock.mockRejectedValue(
      new Error("Cannot cancel workflow run run_done with status completed"),
    )

    await expect(
      cancelActiveRepositoryIngestion({
        orgId: "org_1",
        repositoryId: "repo_1",
      }),
    ).resolves.toEqual([])

    expect(logErrorMock).not.toHaveBeenCalled()
    expect(logInfoMock).not.toHaveBeenCalled()
  })
})
