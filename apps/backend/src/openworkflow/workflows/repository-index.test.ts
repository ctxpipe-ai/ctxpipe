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
    })
  })

  it("continues SCIP when Zoekt fails and returns searchIndexOk false", async () => {
    zoektMock.mockRejectedValueOnce(new Error("zoekt OOM"))
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
      targetHash: "abc",
      searchIndexOk: false,
      searchIndexError: "zoekt OOM",
    })
  })
})
