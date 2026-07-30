import { beforeEach, describe, expect, it, vi } from "vitest"

const signUpstreamJwtMock = vi.hoisted(() => vi.fn())
const parseEnvMock = vi.hoisted(() => vi.fn())
const codesearchBaseUrlMock = vi.hoisted(() => vi.fn())
const withTransientHttpRetryMock = vi.hoisted(() =>
  vi.fn(async (run: () => Promise<Response>) => {
    await run()
    return run()
  }),
)
const getInstallationTokenMock = vi.hoisted(() => vi.fn())
const logger = {
  set: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}

vi.mock("../../../auth/upstreamJwt.js", () => ({
  signUpstreamJwt: signUpstreamJwtMock,
}))
vi.mock("../../../config/env.js", () => ({
  parseEnv: parseEnvMock,
}))
vi.mock("../../../lib/agentToolRuntime.js", () => ({
  codesearchBaseUrl: codesearchBaseUrlMock,
}))
vi.mock("../../../lib/withTransientHttpRetry.js", () => ({
  withTransientHttpRetry: withTransientHttpRetryMock,
}))
vi.mock("../../../models/github-installation.js", () => ({
  getInstallationToken: getInstallationTokenMock,
}))
vi.mock("../../../observability/logger.js", () => ({
  flushWorkflowLog: vi.fn(),
  getLogger: () => logger,
}))

import { reindex } from "./reindex.js"

describe("reindex", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    parseEnvMock.mockReturnValue({
      AUTH_SECRET: "a".repeat(32),
      AUTH_TOKEN_AUDIENCE_CODESEARCH: "codesearch",
    })
    codesearchBaseUrlMock.mockReturnValue("http://codesearch:3001")
    getInstallationTokenMock.mockResolvedValue("github-token")
    signUpstreamJwtMock
      .mockResolvedValueOnce("fresh-token-1")
      .mockResolvedValueOnce("fresh-token-2")
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("warming", { status: 503 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              targetHash: "target-hash",
              ingestMode: "full",
              changedPaths: [],
              deletedPaths: [],
              renames: [],
            }),
            { status: 200 },
          ),
        ),
    )
  })

  it("mints a fresh Codesearch JWT for each retry attempt", async () => {
    const result = await reindex({
      repositoryId: "repo_abc123",
      orgId: "org_abc123",
      targetHash: "target-hash",
    })

    expect(result.targetHash).toBe("target-hash")
    expect(signUpstreamJwtMock).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "http://codesearch:3001/repo_abc123/index",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fresh-token-1",
        }),
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://codesearch:3001/repo_abc123/index",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fresh-token-2",
        }),
      }),
    )
  })
})
