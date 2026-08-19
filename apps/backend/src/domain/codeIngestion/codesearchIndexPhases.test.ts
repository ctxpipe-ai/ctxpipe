import { beforeEach, describe, expect, it, vi } from "vitest"

const signUpstreamJwtMock = vi.hoisted(() => vi.fn())
const parseEnvMock = vi.hoisted(() => vi.fn())
const codesearchBaseUrlMock = vi.hoisted(() => vi.fn())

vi.mock("../../auth/upstreamJwt.js", () => ({
  signUpstreamJwt: signUpstreamJwtMock,
}))
vi.mock("../../config/env.js", () => ({
  parseEnv: parseEnvMock,
}))
vi.mock("../../lib/agentToolRuntime.js", () => ({
  codesearchBaseUrl: codesearchBaseUrlMock,
}))
vi.mock("../../lib/withTransientHttpRetry.js", () => ({
  withTransientHttpRetry: async (run: () => Promise<unknown>) => run(),
}))
vi.mock("../../observability/logger.js", () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY } from "../../lib/memoryFitError.js"
import {
  codesearchIndexMergeScip,
  codesearchIndexScipLang,
  codesearchIndexZoekt,
} from "./codesearchIndexPhases.js"

describe("codesearchIndexZoekt", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    signUpstreamJwtMock.mockResolvedValue("token")
    parseEnvMock.mockReturnValue({})
    codesearchBaseUrlMock.mockReturnValue("http://codesearch:3001")
  })

  it("rewrites exhausted fetch failed to the memory-fit message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    )
    await expect(
      codesearchIndexZoekt({ repositoryId: "repo_1", orgId: "org_1" }),
    ).rejects.toThrow(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY)
    vi.unstubAllGlobals()
  })

  it("rewrites exhausted ECONNRESET to the memory-fit message", async () => {
    const cause = new Error("read ECONNRESET") as NodeJS.ErrnoException
    cause.code = "ECONNRESET"
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause })),
    )
    await expect(
      codesearchIndexZoekt({ repositoryId: "repo_1", orgId: "org_1" }),
    ).rejects.toThrow(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY)
    vi.unstubAllGlobals()
  })

  it("rewrites HTTP 500 exit 137 bodies to the memory-fit message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "Command failed with exit code 137\nstderr: Killed",
          }),
          { status: 500 },
        ),
      ),
    )
    await expect(
      codesearchIndexZoekt({ repositoryId: "repo_1", orgId: "org_1" }),
    ).rejects.toThrow(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY)
    vi.unstubAllGlobals()
  })
})

describe("codesearchIndexScipLang", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    signUpstreamJwtMock.mockResolvedValue("token")
    parseEnvMock.mockReturnValue({})
    codesearchBaseUrlMock.mockReturnValue("http://codesearch:3001")
  })

  it("rewrites exhausted fetch failed to the memory-fit message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    )
    await expect(
      codesearchIndexScipLang(
        { repositoryId: "repo_1", orgId: "org_1" },
        "go",
        ["go"],
      ),
    ).rejects.toThrow(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY)
    vi.unstubAllGlobals()
  })

  it("rewrites exhausted ECONNRESET to the memory-fit message", async () => {
    const cause = new Error("read ECONNRESET") as NodeJS.ErrnoException
    cause.code = "ECONNRESET"
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause })),
    )
    await expect(
      codesearchIndexScipLang(
        { repositoryId: "repo_1", orgId: "org_1" },
        "go",
        ["go"],
      ),
    ).rejects.toThrow(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY)
    vi.unstubAllGlobals()
  })

  it("rewrites HTTP 500 exit 137 bodies to the memory-fit message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "Command failed with exit code 137\nstderr: Killed",
          }),
          { status: 500 },
        ),
      ),
    )
    await expect(
      codesearchIndexScipLang(
        { repositoryId: "repo_1", orgId: "org_1" },
        "go",
        ["go"],
      ),
    ).rejects.toThrow(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY)
    vi.unstubAllGlobals()
  })
})

describe("codesearchIndexMergeScip", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    signUpstreamJwtMock.mockResolvedValue("token")
    parseEnvMock.mockReturnValue({})
    codesearchBaseUrlMock.mockReturnValue("http://codesearch:3001")
  })

  it("sends an empty languagesToMerge array so merge omits leftover shards", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, shardCount: 0 }), {
        status: 200,
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      codesearchIndexMergeScip(
        { repositoryId: "repo_1", orgId: "org_1" },
        ["go", "typescript"],
        [],
      ),
    ).resolves.toEqual({ ok: true, shardCount: 0 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      detectedLanguages: ["go", "typescript"],
      languagesToMerge: [],
    })
    vi.unstubAllGlobals()
  })

  it("omits languagesToMerge when the caller does not override shards", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, shardCount: 1 }), {
        status: 200,
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      codesearchIndexMergeScip({ repositoryId: "repo_1", orgId: "org_1" }, [
        "go",
      ]),
    ).resolves.toEqual({ ok: true, shardCount: 1 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      detectedLanguages: ["go"],
    })
    vi.unstubAllGlobals()
  })
})
