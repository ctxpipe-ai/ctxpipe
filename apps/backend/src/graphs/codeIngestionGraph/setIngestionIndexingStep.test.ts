import { beforeEach, describe, expect, it, vi } from "vitest"

const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn((_orgId: string, fn: () => unknown) => Promise.resolve(fn())),
)
const tryGetOrgDbMock = vi.hoisted(() => vi.fn(() => undefined))
const setRepositoryIndexingStepMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const getLoggerMock = vi.hoisted(() => {
  const warn = vi.fn()
  return vi.fn(() => ({ warn }))
})

vi.mock("../../db/client.js", () => ({
  withOrgDbContext: withOrgDbContextMock,
  tryGetOrgDb: tryGetOrgDbMock,
}))

vi.mock("../../models/repositories.js", () => ({
  setRepositoryIndexingStep: setRepositoryIndexingStepMock,
}))

vi.mock("../../observability/logger.js", () => ({
  getLogger: getLoggerMock,
}))

import { setIngestionIndexingStep } from "./setIngestionIndexingStep.js"

const state = { repositoryId: "repo_1", orgId: "org_1" }

describe("setIngestionIndexingStep", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tryGetOrgDbMock.mockReturnValue(undefined)
    withOrgDbContextMock.mockImplementation(
      (_orgId: string, fn: () => unknown) => Promise.resolve(fn()),
    )
    setRepositoryIndexingStepMock.mockResolvedValue(undefined)
  })

  it("calls setRepositoryIndexingStep with the key and monotonic: true", async () => {
    await setIngestionIndexingStep(state, "finding_roots")

    expect(withOrgDbContextMock).toHaveBeenCalledWith("org_1", expect.any(Function))
    expect(setRepositoryIndexingStepMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      key: "finding_roots",
      monotonic: true,
    })
  })

  it("reuses the current org DB context without opening a nested transaction", async () => {
    tryGetOrgDbMock.mockReturnValue({} as never)

    await setIngestionIndexingStep(state, "deduplicating")

    expect(withOrgDbContextMock).not.toHaveBeenCalled()
    expect(setRepositoryIndexingStepMock).toHaveBeenCalledWith({
      repositoryId: "repo_1",
      key: "deduplicating",
      monotonic: true,
    })
  })

  it("swallows errors from withOrgDbContext (best-effort)", async () => {
    withOrgDbContextMock.mockRejectedValue(new Error("db connection failed"))
    const warnSpy = vi.fn()
    getLoggerMock.mockReturnValue({ warn: warnSpy })

    await expect(
      setIngestionIndexingStep(state, "embedding"),
    ).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("non-fatal"),
      expect.objectContaining({ repositoryId: "repo_1", key: "embedding" }),
    )
  })

  it("passes the correct key for each known step", async () => {
    const keys = [
      "finding_roots",
      "classifying_packages",
      "identify_api_clients",
      "identify_apis",
      "identify_databases",
      "identify_infrastructure",
      "identify_streams",
      "identify_service_dependencies",
      "identify_libraries",
      "identify_patterns",
      "extract_instruction_units",
      "deduplicating",
      "projecting",
      "embedding",
    ] as const

    for (const key of keys) {
      vi.clearAllMocks()
      setRepositoryIndexingStepMock.mockResolvedValue(undefined)
      withOrgDbContextMock.mockImplementation(
        (_orgId: string, fn: () => unknown) => Promise.resolve(fn()),
      )
      await setIngestionIndexingStep(state, key)
      expect(setRepositoryIndexingStepMock).toHaveBeenCalledWith(
        expect.objectContaining({ key, monotonic: true }),
      )
    }
  })
})
