import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { codesearchNotFound, useMswServer } from "../../../test/msw.js"
import { globFiles } from "./codesearchClient.js"
import { RepositoryGoneError } from "./repositoryGone.js"

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer(codesearchNotFound("http://codesearch.test"))

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-with-at-least-32-characters")
  vi.stubEnv("CODESEARCH_URL", "http://codesearch.test")
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://ctxpipe:ctxpipe@127.0.0.1:5433/ctxpipe",
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("globFiles", () => {
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
