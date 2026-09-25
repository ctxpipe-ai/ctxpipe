import { beforeEach, describe, expect, it, vi } from "vitest"

const warnMock = vi.hoisted(() => vi.fn())
const rows = vi.hoisted(() => [
  { id: "repo_1", name: "Hello-World", zoektRepoId: 138 },
])

vi.mock("../../auth/upstreamJwt.js", () => ({
  signUpstreamJwt: vi.fn().mockResolvedValue("token"),
}))

vi.mock("../../config/env.js", () => ({
  parseEnv: () => ({ AUTH_TOKEN_AUDIENCE_CODESEARCH: "codesearch" }),
}))

vi.mock("../../lib/agentToolRuntime.js", () => ({
  codesearchBaseUrl: () => "http://codesearch.test",
}))

vi.mock("../../lib/withTransientHttpRetry.js", () => ({
  withTransientHttpRetry: (fn: () => Promise<unknown>) => fn(),
}))

vi.mock("../../db/client.js", () => ({
  getOrgDb: () => ({
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve(rows),
        }),
      }),
    }),
  }),
  withOrgDbContext: vi.fn(),
}))

vi.mock("../../observability/logger.js", () => ({
  log: { warn: warnMock, error: vi.fn(), info: vi.fn() },
}))

import { retrievalChannelsNode } from "../../graphs/conversationGraph/nodes/retrievalChannels.js"
import { codeSearch, zoektLiteralQuery } from "./codeSearch.js"

function queryOf(init: RequestInit | undefined): string {
  const raw = typeof init?.body === "string" ? init.body : ""
  return (JSON.parse(raw) as { Q: string }).Q
}

describe("codeSearch Zoekt query rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it("quotes a rejected query and returns the literal search", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const q = queryOf(init)
      if (q === "file:((") {
        return new Response(
          JSON.stringify({ error: "Zoekt rejected the query: parse error" }),
          { status: 400 },
        )
      }
      return new Response(JSON.stringify({ Files: [] }), { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const results = await codeSearch("org_1", { query: "file:((" })

    expect(zoektLiteralQuery("file:((")).toBe('"file:(("')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(queryOf(fetchMock.mock.calls[1]?.[1])).toBe('"file:(("')
    expect(results).toEqual([
      expect.objectContaining({
        repositoryId: "repo_1",
        query: '"file:(("',
      }),
    ])
    expect(warnMock).not.toHaveBeenCalled()
  })

  it("continues the advisor without code results when the literal query is also rejected", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const q = queryOf(init)
      const error =
        q === "file:(("
          ? "Zoekt rejected the query: parse error"
          : "Zoekt rejected the query: still invalid"
      return new Response(JSON.stringify({ error }), { status: 400 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const results = await codeSearch("org_1", { query: "file:((" })
    const continued = await retrievalChannelsNode({
      orgId: "org_1",
      orgSlug: "obs-e2e-343",
      query: "file:((",
      codeResults: [],
      plan: {
        steps: [{ type: "code_search", params: { query: "file:((" } }],
        depthLimit: 3,
        resultLimit: 20,
      },
    } as never)

    expect(results).toEqual([])
    expect(continued.codeResults).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(warnMock).toHaveBeenCalledTimes(2)
    expect(warnMock).toHaveBeenLastCalledWith({
      step: "advisor.code_search.rejected",
      "upstream.status_code": 400,
      error: "zoekt_query_rejected",
    })
    expect(JSON.stringify(warnMock.mock.calls)).not.toContain("file:((")
    expect(JSON.stringify(warnMock.mock.calls)).not.toContain("Zoekt rejected")
  })

  it("still throws when codesearch is unavailable", async () => {
    const fetchMock = vi.fn(
      async () => new Response("unavailable", { status: 503 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(codeSearch("org_1", { query: "file:((" })).rejects.toThrow(
      "codesearch failed with status 503",
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(warnMock).not.toHaveBeenCalled()
  })
})
