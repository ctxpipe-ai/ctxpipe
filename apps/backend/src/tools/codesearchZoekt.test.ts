import { beforeEach, describe, expect, it, vi } from "vitest"
import { TransientHttpError } from "../lib/withTransientHttpRetry.js"

const {
  signUpstreamJwtMock,
  parseEnvMock,
  withTransientHttpRetryMock,
} = vi.hoisted(() => ({
  signUpstreamJwtMock: vi.fn(),
  parseEnvMock: vi.fn(),
  withTransientHttpRetryMock: vi.fn(),
}))

vi.mock("../auth/upstreamJwt.js", () => ({
  signUpstreamJwt: signUpstreamJwtMock,
}))
vi.mock("../config/env.js", () => ({
  parseEnv: parseEnvMock,
}))
vi.mock("../lib/agentToolRuntime.js", () => ({
  codesearchBaseUrl: () => "http://codesearch:3001",
}))
vi.mock("../lib/withTransientHttpRetry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/withTransientHttpRetry.js")>()
  return {
    ...actual,
    withTransientHttpRetry: withTransientHttpRetryMock,
  }
})

import {
  isZoektSearchClientFailure,
  zoektSearchRepository,
} from "./codesearchZoekt.js"

describe("zoektSearchRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    parseEnvMock.mockReturnValue({
      AUTH_SECRET: "a".repeat(32),
      AUTH_TOKEN_AUDIENCE_CODESEARCH: "codesearch",
    })
    signUpstreamJwtMock.mockResolvedValue("upstream-token")
  })

  it("maps exhausted gateway errors to search_unavailable", async () => {
    withTransientHttpRetryMock.mockRejectedValue(
      new TransientHttpError("transient HTTP 503", 503),
    )

    const result = await zoektSearchRepository(
      {
        id: "repo_1",
        orgId: "org_1",
        zoektRepoId: 7,
        name: "example",
      },
      "auth",
      {},
    )

    expect(isZoektSearchClientFailure(result)).toBe(true)
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: "search_unavailable",
    })
  })
})
