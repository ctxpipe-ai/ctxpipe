/**
 * Contract test for the codesearch re-index call used by `repository-ingestion` after
 * a GitHub push. When codesearch can diff `fromHash` → `targetHash` it should return
 * `ingestMode: "partial"` and changed paths; the ingestion graph then limits LLM work to
 * those paths (this node wires that in).
 *
 * GitHub App + LLM calls are not exercised here: `getInstallationToken` is mocked, and
 * `fetch` is a stub that returns a deterministic partial index response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createLogger, withLogger } from "../../../observability/logger.js"
import { reindex } from "./reindex.js"
import type { CodeIngestionState } from "../schemas.js"

vi.mock("../../../models/github-installation.js", () => ({
  getInstallationToken: vi.fn().mockResolvedValue("ghs_mock_installation_token"),
}))

/** 31 chars total: `repo_` + 26 (matches repositoryIdSchema) */
const REPO = "repo_aaaaaaaaaaaaaaaaaaaaaaaaaa"
const ORG = "org_aaaaaaaaaaaaaaaaaaaaaaaaaa"

const baseState = {
  repositoryId: REPO,
  orgId: ORG,
  targetHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  fromHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
} as CodeIngestionState

describe("reindex → codesearch /:repoId/index (mocked)", () => {
  const fetchMock = vi.fn()
  const envBackup: Record<string, string | undefined> = {}

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock)
    for (const k of [
      "NODE_ENV",
      "DATABASE_URL",
      "AUTH_SECRET",
      "CODESEARCH_URL",
      "GRAPH_DB_URI",
    ] as const) {
      envBackup[k] = process.env[k]
    }
    process.env.NODE_ENV = "test"
    process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:5432/ctxpipe"
    process.env.AUTH_SECRET = "abcdefghijklmnopqrstuvwxyz123456"
    process.env.CODESEARCH_URL = "http://127.0.0.1:9"
    process.env.GRAPH_DB_URI = "redis://127.0.0.1:6379"
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
    for (const k of [
      "NODE_ENV",
      "DATABASE_URL",
      "AUTH_SECRET",
      "CODESEARCH_URL",
      "GRAPH_DB_URI",
    ] as const) {
      if (envBackup[k] === undefined) delete process.env[k]
      else process.env[k] = envBackup[k]
    }
  })

  it("POSTs fromHash+targetHash and applies partial index mode + changedPaths from the response", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          targetHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          ingestMode: "partial",
          changedPaths: ["src/changed.ts"],
          deletedPaths: ["legacy/removed.md"],
          renames: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )

    const log = createLogger({ component: "test", workflow: "reindex-contract" })
    const out = await withLogger(log, () => reindex(baseState))

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe(
      `http://127.0.0.1:9/${REPO}/index`,
    )
    expect((init as { method?: string }).method).toBe("POST")
    const h = init.headers as Headers | Record<string, string>
    if (h instanceof Headers) {
      expect(h.get("Content-Type")).toBe("application/json")
      expect(h.get("Authorization")?.startsWith("Bearer ")).toBe(true)
    } else {
      expect(
        h["Content-Type"] ?? h["content-type"],
      ).toBe("application/json")
      const auth = h.Authorization ?? h.authorization
      expect(String(auth).startsWith("Bearer ")).toBe(true)
    }
    const body = JSON.parse((init as { body?: string }).body as string) as {
      githubToken: string
      targetHash: string
      fromHash: string
    }
    expect(body).toEqual({
      githubToken: "ghs_mock_installation_token",
      targetHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      fromHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })

    expect(out).toEqual(
      expect.objectContaining({
        ingestMode: "partial",
        changedPaths: ["src/changed.ts"],
        deletedPaths: ["legacy/removed.md"],
        renames: [],
        targetHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    )
    expect(typeof out.indexedAt).toBe("string")
  })
})
