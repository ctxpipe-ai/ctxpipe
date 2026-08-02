import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
const flushWorkflowLogMock = vi.hoisted(() => vi.fn())
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
  flushWorkflowLog: flushWorkflowLogMock,
  getLogger: () => logger,
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

function httpFailSetCalls() {
  return logger.set.mock.calls.filter(([entry]) => {
    return (
      entry != null &&
      typeof entry === "object" &&
      "step" in entry &&
      entry.step === "codeIngestion.reindex.http.fail"
    )
  })
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
        .mockResolvedValueOnce(
          new Response(successBody, { status: 200 }),
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

  it("logs http.start milestone before fetching", async () => {
    await reindex({
      repositoryId: "repo_abc123",
      orgId: "org_abc123",
      targetHash: "target-hash",
    })

    expect(logger.set).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "codeIngestion.reindex.http.start",
        repositoryId: "repo_abc123",
        orgId: "org_abc123",
        targetHash: "target-hash",
      }),
    )
    expect(logger.info).toHaveBeenCalledWith("reindex HTTP start")
    expect(flushWorkflowLogMock).toHaveBeenCalled()
  })

  it("logs http.done milestone with path counts on success", async () => {
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

    await reindex({
      repositoryId: "repo_abc123",
      orgId: "org_abc123",
      targetHash: "target-hash",
    })

    expect(logger.set).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "codeIngestion.reindex.http.done",
        durationMs: expect.any(Number),
        status: 200,
        ingestMode: "partial",
        changedPathCount: 2,
        deletedPathCount: 1,
        renameCount: 1,
      }),
    )
    expect(logger.info).toHaveBeenCalledWith("reindex HTTP done")
  })

  it("logs http.fail milestone on non-ok response", async () => {
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

    await expect(
      reindex({
        repositoryId: "repo_abc123",
        orgId: "org_abc123",
        targetHash: "target-hash",
      }),
    ).rejects.toThrow("codesearch reindex failed with status 500")

    expect(logger.set).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "codeIngestion.reindex.http.fail",
        durationMs: expect.any(Number),
        status: 500,
        error: "index build failed",
      }),
    )
    expect(httpFailSetCalls()).toHaveLength(1)
    expect(logger.error).toHaveBeenCalledWith(
      "codesearch reindex failed",
      expect.objectContaining({ status: 500 }),
    )
  })

  it("logs http.fail milestone when fetch throws", async () => {
    withTransientHttpRetryMock.mockImplementationOnce(
      async (run: () => Promise<Response>) => run(),
    )
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new Error("network down")),
    )

    await expect(
      reindex({
        repositoryId: "repo_abc123",
        orgId: "org_abc123",
        targetHash: "target-hash",
      }),
    ).rejects.toThrow("network down")

    expect(httpFailSetCalls()).toHaveLength(1)
    expect(logger.set).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "codeIngestion.reindex.http.fail",
        durationMs: expect.any(Number),
        error: "network down",
        errorName: "Error",
      }),
    )
    expect(logger.error).toHaveBeenCalledWith(
      "codesearch reindex HTTP failed",
      expect.objectContaining({
        error: "network down",
        errorName: "Error",
      }),
    )
    expect(flushWorkflowLogMock).toHaveBeenCalled()
  })

  it("ends the OTEL span in both success and failure paths", async () => {
    await reindex({
      repositoryId: "repo_abc123",
      orgId: "org_abc123",
      targetHash: "target-hash",
    })

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

    await expect(
      reindex({
        repositoryId: "repo_abc123",
        orgId: "org_abc123",
        targetHash: "target-hash",
      }),
    ).rejects.toThrow()

    expect(otelMocks.spanEnd).toHaveBeenCalledTimes(1)
  })

  describe("http.waiting heartbeat", () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it("emits http.waiting with elapsedMs every 30s while fetch is outstanding", async () => {
      vi.useFakeTimers()

      let resolveFetch!: (r: Response) => void
      const pendingFetch = new Promise<Response>((resolve) => {
        resolveFetch = resolve
      })

      withTransientHttpRetryMock.mockImplementationOnce(
        async (run: () => Promise<Response>) => run(),
      )
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(pendingFetch))

      const reindexPromise = reindex({
        repositoryId: "repo_abc123",
        orgId: "org_abc123",
        targetHash: "target-hash",
      })

      // Advance 30s — first heartbeat fires
      await vi.advanceTimersByTimeAsync(30_000)

      expect(logger.set).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "codeIngestion.reindex.http.waiting",
          elapsedMs: expect.any(Number),
          repositoryId: "repo_abc123",
          targetHash: "target-hash",
        }),
      )
      expect(logger.info).toHaveBeenCalledWith("reindex HTTP waiting")

      const waitingCallsBefore = logger.set.mock.calls.filter(
        (c) =>
          c[0] != null &&
          typeof c[0] === "object" &&
          "step" in c[0] &&
          c[0].step === "codeIngestion.reindex.http.waiting",
      ).length
      expect(waitingCallsBefore).toBe(1)

      // Advance another 30s — second heartbeat fires
      await vi.advanceTimersByTimeAsync(30_000)

      const waitingCallsAfter = logger.set.mock.calls.filter(
        (c) =>
          c[0] != null &&
          typeof c[0] === "object" &&
          "step" in c[0] &&
          c[0].step === "codeIngestion.reindex.http.waiting",
      ).length
      expect(waitingCallsAfter).toBe(2)

      // Resolve the fetch — reindex should complete
      resolveFetch(
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
      )

      const result = await reindexPromise
      expect(result.targetHash).toBe("target-hash")

      // http.done logged after fetch resolves
      expect(logger.set).toHaveBeenCalledWith(
        expect.objectContaining({ step: "codeIngestion.reindex.http.done" }),
      )
    })

    it("clears the heartbeat interval after fetch completes", async () => {
      vi.useFakeTimers()

      withTransientHttpRetryMock.mockImplementationOnce(
        async (run: () => Promise<Response>) => run(),
      )
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(new Response(successBody, { status: 200 })),
      )

      await reindex({
        repositoryId: "repo_abc123",
        orgId: "org_abc123",
        targetHash: "target-hash",
      })

      // Advance past 30s — no heartbeat should fire since interval was cleared
      const setsBefore = logger.set.mock.calls.length
      await vi.advanceTimersByTimeAsync(60_000)
      const setsAfter = logger.set.mock.calls.length

      expect(setsAfter).toBe(setsBefore)
    })
  })
})
