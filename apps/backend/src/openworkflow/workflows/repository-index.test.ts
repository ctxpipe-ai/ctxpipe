import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
const admissionBusy = vi.hoisted(() => {
  class CodesearchAdmissionBusyError extends Error {
    override readonly name = "CodesearchAdmissionBusyError"
    readonly retryAfterSeconds: number
    constructor(message: string, retryAfterSeconds = 30) {
      super(message)
      this.retryAfterSeconds = retryAfterSeconds
    }
  }
  return {
    CodesearchAdmissionBusyError,
    isCodesearchAdmissionBusyError: (error: unknown) =>
      error instanceof CodesearchAdmissionBusyError,
  }
})

vi.mock("../../domain/codeIngestion/codesearchIndexPhases.js", () => ({
  codesearchIndexCloneCheckout: cloneMock,
  codesearchIndexZoekt: zoektMock,
  codesearchIndexDetectLanguages: detectMock,
  codesearchIndexScipLang: scipMock,
  codesearchIndexMergeScip: mergeMock,
  CodesearchAdmissionBusyError: admissionBusy.CodesearchAdmissionBusyError,
  isCodesearchAdmissionBusyError: admissionBusy.isCodesearchAdmissionBusyError,
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

type Step = {
  run: (
    opts: { name: string; retryPolicy?: { maximumAttempts?: number } },
    fn: () => unknown,
  ) => Promise<unknown>
  sleep: (name: string, duration: string) => Promise<void>
}

function passthroughStep(overrides?: Partial<Step>): Step {
  return {
    run: async (_opts, fn) => fn(),
    sleep: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe("repositoryIndex workflow", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

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
    mergeMock.mockResolvedValue(undefined)
  })

  it("runs phases in order and parallelizes SCIP langs", async () => {
    const stepNames: string[] = []
    const step = passthroughStep({
      run: async (opts, fn) => {
        stepNames.push(opts.name)
        return fn()
      },
    })

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
    })
  })

  it("records Zoekt failure as a successful step result so OpenWorkflow does not retry", async () => {
    zoektMock.mockRejectedValue(new Error("zoekt OOM"))
    let zoektAttempts = 0
    const step = passthroughStep({
      run: async (opts, fn) => {
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
    })
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
    })
  })

  it("maps Zoekt exit 137 to the canonical error and still runs SCIP", async () => {
    zoektMock.mockRejectedValue(new Error("Command failed with exit code 137"))
    const step = passthroughStep()
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

    expect(scipMock).toHaveBeenCalled()
    expect(result).toMatchObject({
      searchIndexOk: false,
      searchIndexError: "Codebase didn't fit available memory",
    })
  })

  it("fails closed on clone task death so SCIP never starts", async () => {
    cloneMock.mockRejectedValue(
      new Error("Codebase didn't fit available memory"),
    )
    const step = passthroughStep()
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

  it("fails closed when SCIP dies after a non-fatal Zoekt OOM", async () => {
    zoektMock.mockRejectedValue(new Error("Command failed with exit code 137"))
    scipMock.mockRejectedValue(
      new Error("Codebase didn't fit available memory"),
    )
    const step = passthroughStep()
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

    expect(detectMock).toHaveBeenCalledOnce()
    expect(mergeMock).not.toHaveBeenCalled()
  })

  it("sleeps and retries clone-checkout on 429 with a new step name", async () => {
    cloneMock
      .mockRejectedValueOnce(
        new admissionBusy.CodesearchAdmissionBusyError("busy", 30),
      )
      .mockResolvedValueOnce({
        targetHash: "abc",
        ingestMode: "full",
        changedPaths: [],
        deletedPaths: [],
        renames: [],
      })
    const stepNames: string[] = []
    const sleeps: Array<[string, string]> = []
    const step = passthroughStep({
      run: async (opts, fn) => {
        stepNames.push(opts.name)
        return fn()
      },
      sleep: async (name, duration) => {
        sleeps.push([name, duration])
      },
    })
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

    await wf.fn({
      input: {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetHash: "abc",
      },
      step,
    })

    expect(cloneMock).toHaveBeenCalledTimes(2)
    expect(sleeps).toEqual([["clone-checkout:admit-wait-0", "30s"]])
    expect(stepNames).toContain("clone-checkout")
    expect(stepNames).toContain("clone-checkout:admit-1")
  })

  it("does not record Zoekt 429 as searchIndexOk false", async () => {
    zoektMock
      .mockRejectedValueOnce(
        new admissionBusy.CodesearchAdmissionBusyError("busy", 30),
      )
      .mockResolvedValueOnce(undefined)
    const sleeps: Array<[string, string]> = []
    const step = passthroughStep({
      sleep: async (name, duration) => {
        sleeps.push([name, duration])
      },
    })
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

    expect(sleeps).toEqual([["zoekt:admit-wait-0", "30s"]])
    expect(result).toMatchObject({ searchIndexOk: true })
  })

  it("batches SCIP langs to CODESEARCH_INDEXER_CONCURRENCY", async () => {
    vi.stubEnv("CODESEARCH_INDEXER_CONCURRENCY", "1")
    detectMock.mockResolvedValue({
      detectedLanguages: ["go", "typescript", "python"],
      languagesToIndex: ["go", "typescript", "python"],
    })
    let concurrent = 0
    let maxConcurrent = 0
    scipMock.mockImplementation(async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await Promise.resolve()
      concurrent -= 1
    })
    const step = passthroughStep()
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

    await wf.fn({
      input: {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetHash: "abc",
      },
      step,
    })

    expect(scipMock).toHaveBeenCalledTimes(3)
    expect(maxConcurrent).toBe(1)
  })
})
