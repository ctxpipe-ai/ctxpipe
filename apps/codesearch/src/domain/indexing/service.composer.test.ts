import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Db } from "../../db/client.js"
import { CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY } from "./memoryFitError.js"

const phaseCloneCheckoutMock = vi.hoisted(() => vi.fn())
const phaseZoektMock = vi.hoisted(() => vi.fn())
const phaseDetectLanguagesMock = vi.hoisted(() => vi.fn())
const phaseScipLanguageMock = vi.hoisted(() => vi.fn())
const phaseMergeScipMock = vi.hoisted(() => vi.fn())
const phaseMarkCheckoutIndexedMock = vi.hoisted(() => vi.fn())

vi.mock("./phases.js", async () => {
  const actual =
    await vi.importActual<typeof import("./phases.js")>("./phases.js")
  return {
    ...actual,
    phaseCloneCheckout: phaseCloneCheckoutMock,
    phaseZoekt: phaseZoektMock,
    phaseDetectLanguages: phaseDetectLanguagesMock,
    phaseScipLanguage: phaseScipLanguageMock,
    phaseMergeScip: phaseMergeScipMock,
    phaseMarkCheckoutIndexed: phaseMarkCheckoutIndexedMock,
  }
})

vi.mock("../../observability/logger.js", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

import { cloneAndIndexRepository } from "./service.js"

const input = {
  db: {} as Db,
  orgId: "org_1",
  repoId: "repo_1",
  repoGitUrl: "https://github.com/acme/web.git",
  clonePath: "/tmp/clone",
  scipIndexPath: "/tmp/index.scip",
  zoektRepoId: 1,
  repoName: "acme/web",
  repoUrl: "https://github.com/acme/web.git",
}

describe("cloneAndIndexRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    phaseCloneCheckoutMock.mockResolvedValue({
      targetHash: "abc",
      ingestMode: "full",
      changedPaths: [],
      deletedPaths: [],
      renames: [],
    })
    phaseZoektMock.mockResolvedValue(undefined)
    phaseDetectLanguagesMock.mockResolvedValue({
      detectedLanguages: ["go", "typescript"],
      languagesToIndex: ["go", "typescript"],
    })
    phaseScipLanguageMock.mockResolvedValue(undefined)
    phaseMergeScipMock.mockResolvedValue({ shardCount: 2 })
    phaseMarkCheckoutIndexedMock.mockResolvedValue(undefined)
  })

  it("skips SCIP langs after a Zoekt memory-fit failure and merges []", async () => {
    phaseZoektMock.mockRejectedValue(
      new Error("Command failed with exit code 137"),
    )

    const result = await cloneAndIndexRepository(input)

    expect(phaseDetectLanguagesMock).toHaveBeenCalledOnce()
    expect(phaseScipLanguageMock).not.toHaveBeenCalled()
    expect(phaseMergeScipMock).toHaveBeenCalledOnce()
    expect(phaseMergeScipMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: "repo_1" }),
      {
        detectedLanguages: ["go", "typescript"],
        languagesToMerge: [],
      },
    )
    expect(phaseMarkCheckoutIndexedMock).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ targetHash: "abc", ingestMode: "full" })
  })

  it("skips SCIP langs when Zoekt throws the canonical memory-fit message", async () => {
    phaseZoektMock.mockRejectedValue(
      new Error(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY),
    )

    await cloneAndIndexRepository(input)

    expect(phaseScipLanguageMock).not.toHaveBeenCalled()
    expect(phaseMergeScipMock).toHaveBeenCalledWith(expect.anything(), {
      detectedLanguages: ["go", "typescript"],
      languagesToMerge: [],
    })
  })

  it("still runs SCIP langs after a non-memory-fit Zoekt failure", async () => {
    phaseZoektMock.mockRejectedValue(new Error("zoekt crashed"))

    await cloneAndIndexRepository(input)

    expect(phaseScipLanguageMock).toHaveBeenCalledTimes(2)
    expect(phaseMergeScipMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: "repo_1" }),
      { detectedLanguages: ["go", "typescript"] },
    )
  })
})
