import { beforeEach, describe, expect, it, vi } from "vitest"

const signUpstreamJwtMock = vi.hoisted(() =>
  vi.fn(async () => "signed-codesearch-jwt"),
)

vi.mock("../../auth/upstreamJwt.js", () => ({
  signUpstreamJwt: signUpstreamJwtMock,
}))

vi.mock("../../config/env.js", () => ({
  parseEnv: () => ({
    AUTH_SECRET: "a".repeat(32),
    AUTH_TOKEN_AUDIENCE_CODESEARCH: "codesearch",
    AUTH_ISSUER: "test",
  }),
}))

vi.mock("../../db/client.js", () => ({
  assertNotInOrgDbContext: () => undefined,
}))

import {
  CodesearchCheckoutError,
  fetchCheckoutFileBytes,
  globCheckoutFiles,
  listCheckoutTree,
} from "./codesearchClient.js"

describe("codesearch checkout reads", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it("lists checkout paths from GET /tree without retrying", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ paths: ["AGENTS.md", "src/a.ts"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      listCheckoutTree({
        repositoryId: "repo_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        orgId: "org_1",
        workspaceId: "ws_1",
      }),
    ).resolves.toEqual(["AGENTS.md", "src/a.ts"])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain("/repo_aaaaaaaaaaaaaaaaaaaaaaaaaa/tree")
    expect(init.method).toBe("GET")
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(signUpstreamJwtMock).toHaveBeenCalledWith(
      expect.objectContaining({
        claims: expect.objectContaining({
          orgId: "org_1",
          workspaceId: "ws_1",
        }),
      }),
    )
  })

  it("does not retry tree listing on 404", async () => {
    const fetchMock = vi.fn(
      async () => new Response("Path not found", { status: 404 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      listCheckoutTree({
        repositoryId: "repo_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        orgId: "org_1",
        workspaceId: "ws_1",
      }),
    ).rejects.toMatchObject({
      name: "CodesearchCheckoutError",
      status: 404,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("signs a workspaceId JWT and does not retry glob on 404", async () => {
    const fetchMock = vi.fn(
      async () => new Response("Path not found", { status: 404 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      globCheckoutFiles({
        repositoryId: "repo_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        orgId: "org_1",
        workspaceId: "ws_1",
      }),
    ).rejects.toMatchObject({
      name: "CodesearchCheckoutError",
      status: 404,
    })

    expect(signUpstreamJwtMock).toHaveBeenCalledTimes(1)
    expect(signUpstreamJwtMock).toHaveBeenCalledWith(
      expect.objectContaining({
        claims: expect.objectContaining({
          orgId: "org_1",
          workspaceId: "ws_1",
        }),
      }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("returns file bytes from files-query without retrying", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            "src/a.ts": Buffer.from("export {}\n", "utf8").toString("base64"),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const bytes = await fetchCheckoutFileBytes({
      repositoryId: "repo_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      orgId: "org_1",
      workspaceId: "ws_1",
      path: "src/a.ts",
    })
    expect(Buffer.from(bytes ?? []).toString("utf8")).toBe("export {}\n")
    expect(signUpstreamJwtMock).toHaveBeenCalledWith(
      expect.objectContaining({
        claims: expect.objectContaining({ workspaceId: "ws_1" }),
      }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("returns null when the checkout file is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    )
    await expect(
      fetchCheckoutFileBytes({
        repositoryId: "repo_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        orgId: "org_1",
        path: "missing.ts",
      }),
    ).resolves.toBeNull()
  })

  it("throws CodesearchCheckoutError when files-query is 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 })),
    )
    await expect(
      fetchCheckoutFileBytes({
        repositoryId: "repo_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        orgId: "org_1",
        workspaceId: "ws_1",
        path: "src/a.ts",
      }),
    ).rejects.toBeInstanceOf(CodesearchCheckoutError)
  })
})
