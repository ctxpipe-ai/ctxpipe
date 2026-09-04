import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const requireCurrentOrgIdMock = vi.hoisted(() => vi.fn())
const signUpstreamJwtMock = vi.hoisted(() => vi.fn())
const parseEnvMock = vi.hoisted(() => vi.fn())
const getRepositoryForOrgMock = vi.hoisted(() => vi.fn())
const withTransientHttpRetryMock = vi.hoisted(() =>
  vi.fn((run: () => Promise<Response>) => run()),
)

vi.mock("../auth/context.js", () => ({
  requireCurrentOrgId: requireCurrentOrgIdMock,
}))
vi.mock("../auth/upstreamJwt.js", () => ({
  signUpstreamJwt: signUpstreamJwtMock,
}))
vi.mock("../config/env.js", () => ({
  parseEnv: parseEnvMock,
}))
vi.mock("../lib/withTransientHttpRetry.js", () => ({
  withTransientHttpRetry: withTransientHttpRetryMock,
  isTransientHttpFailure: (error: unknown) => error instanceof TypeError,
  transientHttpFailureStatus: () => 503,
  CODESEARCH_QUERY_RETRY: {
    retries: 2,
    baseDelayMs: 250,
    maxDelayMs: 1_000,
  },
  CODESEARCH_QUERY_TIMEOUT_MS: 25_000,
}))
vi.mock("../models/repositories.js", () => ({
  getRepositoryForOrg: getRepositoryForOrgMock,
}))

import { structuralSearchTool } from "./structuralSearch.js"

describe("structuralSearchTool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CODESEARCH_URL = "http://codesearch:3001/"
    requireCurrentOrgIdMock.mockReturnValue("org_test")
    parseEnvMock.mockReturnValue({
      AUTH_SECRET: "a".repeat(32),
      AUTH_TOKEN_AUDIENCE_CODESEARCH: "codesearch",
    })
    signUpstreamJwtMock.mockResolvedValue("upstream-token")
    getRepositoryForOrgMock.mockResolvedValue({
      id: "repo_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      orgId: "org_test",
      zoektRepoId: 1,
      name: "example",
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.CODESEARCH_URL
  })

  it("posts an authenticated ast-grep query to codesearch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          matches: [{ file: "src/example.ts", text: "run(value)" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await structuralSearchTool.invoke({
      repositoryId: "repo_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      pattern: "$F($A)",
      lang: "typescript",
      paths: ["src"],
      globs: ["**/*.ts", "!**/*.test.ts"],
      limit: 25,
    })

    expect(requireCurrentOrgIdMock).toHaveBeenCalledOnce()
    expect(getRepositoryForOrgMock).toHaveBeenCalledWith(
      "org_test",
      "repo_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    expect(signUpstreamJwtMock).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: "codesearch",
        claims: {
          sub: "repo:repo_aaaaaaaaaaaaaaaaaaaaaaaaaa",
          orgId: "org_test",
          principal: "service",
        },
      }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      "http://codesearch:3001/repo_aaaaaaaaaaaaaaaaaaaaaaaaaa/structural-search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer upstream-token",
        },
        body: JSON.stringify({
          pattern: "$F($A)",
          lang: "typescript",
          paths: ["src"],
          globs: ["**/*.ts", "!**/*.test.ts"],
          limit: 25,
        }),
        signal: expect.any(AbortSignal),
      },
    )
    expect(result).toContain("src/example.ts")
  })

  it("returns a typed unavailable result after network retry exhaustion", async () => {
    withTransientHttpRetryMock.mockRejectedValueOnce(
      new TypeError("fetch failed"),
    )

    const result = await structuralSearchTool.invoke({
      repositoryId: "repo_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      pattern: "$F($A)",
      limit: 25,
    })

    expect(result).toContain("structural_search_unavailable")
    expect(result).toContain("503")
  })
})
