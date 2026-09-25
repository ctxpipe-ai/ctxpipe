import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../auth/upstreamJwt.js", () => ({
  signUpstreamJwt: vi.fn().mockResolvedValue("token"),
}))

vi.mock("../config/env.js", () => ({
  parseEnv: () => ({ AUTH_TOKEN_AUDIENCE_CODESEARCH: "codesearch" }),
}))

vi.mock("../lib/agentToolRuntime.js", () => ({
  codesearchBaseUrl: () => "http://codesearch.test",
}))

vi.mock("../lib/withTransientHttpRetry.js", () => ({
  withTransientHttpRetry: (fn: () => Promise<unknown>) => fn(),
}))

import {
  isZoektSearchClientFailure,
  zoektSearchRepository,
} from "./codesearchZoekt.js"

const repository = {
  id: "repo_1",
  orgId: "org_1",
  zoektRepoId: 7,
  name: "linguist",
}

describe("zoektSearchRepository", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("reports a Zoekt query rejection as a client error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "Zoekt rejected the query: parse error: unexpected token",
          }),
          { status: 400 },
        ),
      ),
    )

    const result = await zoektSearchRepository(repository, "file:((", {})

    expect(isZoektSearchClientFailure(result)).toBe(true)
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "Zoekt rejected the query: parse error: unexpected token",
    })
  })

  it("throws when codesearch is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })),
    )

    await expect(
      zoektSearchRepository(repository, "needle", {}),
    ).rejects.toThrow("codesearch search failed with status 503")
  })
})
