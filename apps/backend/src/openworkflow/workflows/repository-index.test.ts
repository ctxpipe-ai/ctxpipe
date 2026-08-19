import { beforeEach, describe, expect, it, vi } from "vitest"

const cloneMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    targetHash: "abc",
    ingestMode: "full",
    changedPaths: [],
    deletedPaths: [],
    renames: [],
  }),
)
const zoektMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const detectMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    detectedLanguages: ["go", "typescript"],
    languagesToIndex: ["go", "typescript"],
  }),
)
const scipMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mergeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock("../../domain/codeIngestion/codesearchIndexPhases.js", () => ({
  codesearchIndexCloneCheckout: cloneMock,
  codesearchIndexZoekt: zoektMock,
  codesearchIndexDetectLanguages: detectMock,
  codesearchIndexScipLang: scipMock,
  codesearchIndexMergeScip: mergeMock,
}))

vi.mock("../../config/env.js", () => ({
  parseEnv: () => ({}),
}))

vi.mock("../../models/github-installation.js", () => ({
  getInstallationToken: vi.fn().mockResolvedValue("tok"),
}))

vi.mock("../../observability/logger.js", () => ({
  createLogger: () => ({}),
  withLogger: (_l: unknown, fn: () => unknown) => fn(),
  getLogger: () => ({
    set: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
  flushWorkflowLog: vi.fn(),
}))

vi.mock("../withLoggedStepAttempt.js", () => ({
  withLoggedStepAttempt: (_n: string, _ctx: unknown, fn: () => unknown) => fn(),
}))

vi.mock("openworkflow", () => ({
  defineWorkflow: (
    _opts: unknown,
    handler: (args: {
      input: {
        repositoryId: string
        orgId: string
        targetHash: string
      }
      step: {
        run: (opts: { name: string }, fn: () => unknown) => Promise<unknown>
      }
    }) => Promise<unknown>,
  ) => ({
    fn: handler,
    spec: { name: "repository-index" },
  }),
}))

import { repositoryIndex } from "./repository-index.js"

describe("repositoryIndex workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cloneMock.mockResolvedValue({
      targetHash: "abc",
      ingestMode: "full",
      changedPaths: [],
      deletedPaths: [],
      renames: [],
    })
    zoektMock.mockResolvedValue(undefined)
    detectMock.mockResolvedValue({
      detectedLanguages: ["go", "typescript"],
      languagesToIndex: ["go", "typescript"],
    })
    scipMock.mockResolvedValue(undefined)
    mergeMock.mockResolvedValue({ shardCount: 2 })
  })

  it("runs phases in order and parallelizes SCIP langs", async () => {
    const stepNames: string[] = []
    const step = {
      run: async (opts: { name: string }, fn: () => unknown) => {
        stepNames.push(opts.name)
        return fn()
      },
    }

    const wf = repositoryIndex as unknown as {
      fn: (args: {
        input: {
          repositoryId: string
          orgId: string
          targetHash: string
        }
        step: typeof step
      }) => Promise<unknown>
    }

    const result = await wf.fn({
      input: {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetHash: "abc",
      },
      step,
    })

    expect(cloneMock).toHaveBeenCalledOnce()
    expect(zoektMock).toHaveBeenCalledOnce()
    expect(detectMock).toHaveBeenCalledOnce()
    expect(scipMock).toHaveBeenCalledTimes(2)
    expect(mergeMock).toHaveBeenCalledOnce()
    expect(stepNames[0]).toBe("resolve-github-token")
    expect(stepNames).toContain("clone-checkout")
    expect(stepNames).toContain("zoekt")
    expect(stepNames).toContain("scip:go")
    expect(stepNames).toContain("scip:typescript")
    expect(stepNames[stepNames.length - 1]).toBe("merge-scip")
    expect(result).toMatchObject({
      targetHash: "abc",
      ingestMode: "full",
      searchIndexOk: true,
      scipIndexOk: true,
    })
  })

  it("records Zoekt failure as a successful step result so OpenWorkflow does not retry", async () => {
    zoektMock.mockRejectedValue(new Error("zoekt OOM"))
    let zoektAttempts = 0
    const step = {
      run: async (
        opts: { name: string; retryPolicy?: { maximumAttempts?: number } },
        fn: () => unknown,
      ) => {
        if (opts.name !== "zoekt") return fn()
        const max = opts.retryPolicy?.maximumAttempts ?? 1
        let last: unknown
        for (let attempt = 0; attempt < max; attempt += 1) {
          zoektAttempts += 1
          try {
            return await fn()
          } catch (error) {
            last = error
          }
        }
        throw last
      },
    }
    const wf = repositoryIndex as unknown as {
      fn: (args: {
        input: {
          repositoryId: string
          orgId: string
          targetHash: string
        }
        step: typeof step
      }) => Promise<unknown>
    }

    const result = await wf.fn({
      input: {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetHash: "abc",
      },
      step,
    })

    expect(zoektAttempts).toBe(1)
    expect(scipMock).toHaveBeenCalledTimes(2)
    expect(mergeMock).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      targetHash: "abc",
      searchIndexOk: false,
      searchIndexError: "zoekt OOM",
      scipIndexOk: true,
    })
  })

  it("skips SCIP langs after a Zoekt memory-fit failure so extract can still run", async () => {
    zoektMock.mockRejectedValue(new Error("Command failed with exit code 137"))
    const stepNames: string[] = []
    const step = {
      run: async (opts: { name: string }, fn: () => unknown) => {
        stepNames.push(opts.name)
        return fn()
      },
    }
    const wf = repositoryIndex as unknown as {
      fn: (args: {
        input: {
          repositoryId: string
          orgId: string
          targetHash: string
        }
        step: typeof step
      }) => Promise<unknown>
    }

    const result = await wf.fn({
      input: {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetHash: "abc",
      },
      step,
    })

    expect(scipMock).not.toHaveBeenCalled()
    expect(mergeMock).toHaveBeenCalledOnce()
    expect(mergeMock).toHaveBeenCalledWith(
      expect.anything(),
      ["go", "typescript"],
      [],
    )
    expect(stepNames).not.toContain("scip:go")
    expect(stepNames).toContain("merge-scip")
    expect(result).toMatchObject({
      searchIndexOk: false,
      searchIndexError: "Codebase didn't fit available memory",
      scipIndexOk: false,
      scipIndexError: "Codebase didn't fit available memory",
    })
  })

  it("maps SCIP exit 137 to the canonical error, does not retry, and still merges", async () => {
    scipMock.mockRejectedValue(new Error("Command failed with exit code 137"))
    const scipRetryPolicies: Array<{ maximumAttempts?: number } | undefined> =
      []
    const step = {
      run: async (
        opts: { name: string; retryPolicy?: { maximumAttempts?: number } },
        fn: () => unknown,
      ) => {
        if (opts.name.startsWith("scip:")) {
          scipRetryPolicies.push(opts.retryPolicy)
        }
        return fn()
      },
    }
    const wf = repositoryIndex as unknown as {
      fn: (args: {
        input: {
          repositoryId: string
          orgId: string
          targetHash: string
        }
        step: typeof step
      }) => Promise<unknown>
    }

    const result = await wf.fn({
      input: {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetHash: "abc",
      },
      step,
    })

    expect(scipRetryPolicies).toEqual([undefined, undefined])
    expect(mergeMock).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      searchIndexOk: true,
      scipIndexOk: false,
      scipIndexError: "Codebase didn't fit available memory",
    })
  })

  it("merges surviving SCIP langs when one language fails", async () => {
    scipMock.mockImplementation(async (_auth: unknown, lang: string) => {
      if (lang === "go") throw new Error("scip-go failed")
    })
    const step = {
      run: async (_opts: { name: string }, fn: () => unknown) => fn(),
    }
    const wf = repositoryIndex as unknown as {
      fn: (args: {
        input: {
          repositoryId: string
          orgId: string
          targetHash: string
        }
        step: typeof step
      }) => Promise<unknown>
    }

    const result = await wf.fn({
      input: {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetHash: "abc",
      },
      step,
    })

    expect(scipMock).toHaveBeenCalledTimes(2)
    expect(mergeMock).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      searchIndexOk: true,
      scipIndexOk: false,
      scipIndexError: "scip-go failed",
    })
  })

  it("marks scipIndexOk false when merge publishes zero shards for detected languages", async () => {
    mergeMock.mockResolvedValue({ shardCount: 0 })
    const step = {
      run: async (_opts: { name: string }, fn: () => unknown) => fn(),
    }
    const wf = repositoryIndex as unknown as {
      fn: (args: {
        input: {
          repositoryId: string
          orgId: string
          targetHash: string
        }
        step: typeof step
      }) => Promise<unknown>
    }

    const result = await wf.fn({
      input: {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetHash: "abc",
      },
      step,
    })

    expect(mergeMock).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      searchIndexOk: true,
      scipIndexOk: false,
      scipIndexError: "SCIP index unavailable",
    })
  })

  it("records merge-scip failure without failing the workflow", async () => {
    mergeMock.mockRejectedValue(new Error("merge boom"))
    const step = {
      run: async (_opts: { name: string }, fn: () => unknown) => fn(),
    }
    const wf = repositoryIndex as unknown as {
      fn: (args: {
        input: {
          repositoryId: string
          orgId: string
          targetHash: string
        }
        step: typeof step
      }) => Promise<unknown>
    }

    const result = await wf.fn({
      input: {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetHash: "abc",
      },
      step,
    })

    expect(result).toMatchObject({
      searchIndexOk: true,
      scipIndexOk: false,
      scipIndexError: "merge boom",
    })
  })

  it("fails closed on clone task death so SCIP never starts", async () => {
    cloneMock.mockRejectedValue(
      new Error("Codebase didn't fit available memory"),
    )
    const step = {
      run: async (_opts: { name: string }, fn: () => unknown) => fn(),
    }
    const wf = repositoryIndex as unknown as {
      fn: (args: {
        input: {
          repositoryId: string
          orgId: string
          targetHash: string
        }
        step: typeof step
      }) => Promise<unknown>
    }

    await expect(
      wf.fn({
        input: {
          repositoryId: "repo_1",
          orgId: "org_1",
          targetHash: "abc",
        },
        step,
      }),
    ).rejects.toThrow("Codebase didn't fit available memory")

    expect(zoektMock).not.toHaveBeenCalled()
    expect(scipMock).not.toHaveBeenCalled()
  })

  it("still runs SCIP after a non-memory Zoekt failure", async () => {
    zoektMock.mockRejectedValue(new Error("zoekt binary missing"))
    const step = {
      run: async (_opts: { name: string }, fn: () => unknown) => fn(),
    }
    const wf = repositoryIndex as unknown as {
      fn: (args: {
        input: {
          repositoryId: string
          orgId: string
          targetHash: string
        }
        step: typeof step
      }) => Promise<unknown>
    }

    const result = await wf.fn({
      input: {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetHash: "abc",
      },
      step,
    })

    expect(scipMock).toHaveBeenCalledTimes(2)
    expect(mergeMock).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      searchIndexOk: false,
      searchIndexError: "zoekt binary missing",
      scipIndexOk: true,
    })
  })
})
