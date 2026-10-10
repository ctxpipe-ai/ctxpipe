import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { codesearchNotFound, useMswServer } from "../../../test/msw.js"
import {
  CodesearchCheckoutError,
  fetchCheckoutFileBytes,
  globCheckoutFiles,
  globFiles,
  listCheckoutTree,
} from "./codesearchClient.js"
import { RepositoryGoneError } from "./repositoryGone.js"

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

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer(codesearchNotFound("http://codesearch.test"))

describe("codesearch checkout reads", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
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
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/repo_aaaaaaaaaaaaaaaaaaaaaaaaaa/tree"),
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    )
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

describe("globFiles", () => {
  beforeEach(() => {
    vi.stubEnv(
      "AUTH_SECRET",
      "test-only-auth-secret-with-at-least-32-characters",
    )
    vi.stubEnv("CODESEARCH_URL", "http://codesearch.test")
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://ctxpipe:ctxpipe@127.0.0.1:5433/ctxpipe",
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("throws RepositoryGoneError when codesearch says the repository is gone", async () => {
    await expect(
      globFiles("repo_1", "org_1", { pattern: "**/*.md", onlyFiles: true }),
    ).rejects.toBeInstanceOf(RepositoryGoneError)
  })

  it("keeps a 404 without repository_not_found as an ordinary failure", async () => {
    server.use(
      http.post("http://codesearch.test/:repositoryId/glob", () =>
        HttpResponse.json(
          { error: "Repository not found or access denied" },
          { status: 404 },
        ),
      ),
    )

    await expect(
      globFiles("repo_1", "org_1", { pattern: "**/*.md", onlyFiles: true }),
    ).rejects.toThrow(
      "globFiles failed: 404: Repository not found or access denied",
    )
  })

  it("keeps other 404s as ordinary failures", async () => {
    server.use(
      http.post("http://codesearch.test/:repositoryId/glob", () =>
        HttpResponse.json({ error: "Path not found" }, { status: 404 }),
      ),
    )

    await expect(
      globFiles("repo_1", "org_1", { pattern: "**/*.md", onlyFiles: true }),
    ).rejects.toThrow("globFiles failed: 404: Path not found")
  })
})
