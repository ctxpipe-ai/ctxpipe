import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { withTestLogger } from "../../../test/with-test-logger.js"

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
const otelMocks = vi.hoisted(() => {
  const spanEnd = vi.fn()
  return {
    spanEnd,
    startActiveSpan: vi.fn(
      (
        _name: string,
        _opts: unknown,
        fn: (span: { end: () => void }) => unknown,
      ) => fn({ end: spanEnd }),
    ),
  }
})

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
vi.mock("@opentelemetry/api", () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: otelMocks.startActiveSpan,
    }),
  },
}))

import { reindex } from "./reindex.js"

const successBody = JSON.stringify({
  ok: true,
  targetHash: "target-hash",
  ingestMode: "full",
  changedPaths: [],
  deletedPaths: [],
  renames: [],
})

function runReindex() {
  return withTestLogger(() =>
    reindex({
      repositoryId: "repo_abc123",
      orgId: "org_abc123",
      targetHash: "target-hash",
    }),
  )
}

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
        .mockResolvedValueOnce(new Response(successBody, { status: 200 })),
    )
  })

  it("mints a fresh Codesearch JWT for each retry attempt", async () => {
    const result = await runReindex()

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

  it("returns path counts from a successful codesearch response", async () => {
    withTransientHttpRetryMock.mockImplementationOnce(
      async (run: () => Promise<Response>) => run(),
    )
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            targetHash: "target-hash",
            ingestMode: "partial",
            changedPaths: ["src/a.ts", "src/b.ts"],
            deletedPaths: ["src/old.ts"],
            renames: [{ from: "src/x.ts", to: "src/y.ts" }],
          }),
          { status: 200 },
        ),
      ),
    )

    const result = await runReindex()
    expect(result).toMatchObject({
      targetHash: "target-hash",
      ingestMode: "partial",
      changedPaths: ["src/a.ts", "src/b.ts"],
      deletedPaths: ["src/old.ts"],
      renames: [{ from: "src/x.ts", to: "src/y.ts" }],
    })
  })

  it("throws on a non-ok codesearch response", async () => {
    withTransientHttpRetryMock.mockImplementationOnce(
      async (run: () => Promise<Response>) => run(),
    )
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "index build failed" }), {
          status: 500,
        }),
      ),
    )

    await expect(runReindex()).rejects.toThrow(
      "codesearch reindex failed with status 500",
    )
  })

  it("rethrows when fetch throws", async () => {
    withTransientHttpRetryMock.mockImplementationOnce(
      async (run: () => Promise<Response>) => run(),
    )
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new Error("network down")),
    )

    await expect(runReindex()).rejects.toThrow("network down")
  })

  it("ends the OTEL span in both success and failure paths", async () => {
    await runReindex()

    expect(otelMocks.startActiveSpan).toHaveBeenCalledWith(
      "repository-ingestion.reindex",
      {
        attributes: {
          repositoryId: "repo_abc123",
          orgId: "org_abc123",
          targetHash: "target-hash",
        },
      },
      expect.any(Function),
    )
    expect(otelMocks.spanEnd).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    withTransientHttpRetryMock.mockImplementationOnce(
      async (run: () => Promise<Response>) => run(),
    )
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("err", { status: 500 })),
    )
    signUpstreamJwtMock.mockResolvedValueOnce("token")

    await expect(runReindex()).rejects.toThrow()

    expect(otelMocks.spanEnd).toHaveBeenCalledTimes(1)
  })

  describe("outstanding fetch", () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it("completes after a delayed codesearch response", async () => {
      vi.useFakeTimers()

      let resolveFetch!: (r: Response) => void
      const pendingFetch = new Promise<Response>((resolve) => {
        resolveFetch = resolve
      })

      withTransientHttpRetryMock.mockImplementationOnce(
        async (run: () => Promise<Response>) => run(),
      )
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(pendingFetch))

      const reindexPromise = runReindex()
      await vi.advanceTimersByTimeAsync(60_000)
      resolveFetch(new Response(successBody, { status: 200 }))

      const result = await reindexPromise
      expect(result.targetHash).toBe("target-hash")
    })

    it("does not throw after fetch completes when timers keep advancing", async () => {
      vi.useFakeTimers()

      withTransientHttpRetryMock.mockImplementationOnce(
        async (run: () => Promise<Response>) => run(),
      )
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(new Response(successBody, { status: 200 })),
      )

      await runReindex()
      await vi.advanceTimersByTimeAsync(60_000)
    })
  })
})
