import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useMswServer } from "../../../test/msw.js"
import { CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY } from "../../lib/memoryFitError.js"
import {
  CodesearchAdmissionBusyError,
  codesearchIndexMergeScip,
  codesearchIndexScipLang,
  codesearchIndexZoekt,
} from "./codesearchIndexPhases.js"
import { RepositoryGoneError } from "./repositoryGone.js"

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()
const base = "http://codesearch.test"

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-with-at-least-32-characters")
  vi.stubEnv("CODESEARCH_URL", base)
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://ctxpipe:ctxpipe@127.0.0.1:5433/ctxpipe",
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/**
 * MSW forwards a thrown error to `fetch` when it has `code` and `errno`.
 * `EIO` is not a transient retry code, so the real retry helper surfaces it
 * on the first attempt and the phase catch can remap it.
 */
function nodeError(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  error.errno = -5
  return error
}

describe("codesearchIndexZoekt", () => {
  it("rewrites a fetch failure to the memory-fit message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    server.use(
      http.post(`${base}/:repositoryId/index/zoekt`, () => {
        throw nodeError("fetch failed", "EIO")
      }),
    )
    await expect(
      codesearchIndexZoekt({ repositoryId: "repo_1", orgId: "org_1" }),
    ).rejects.toThrow(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY)
  })

  it("rewrites an ECONNRESET cause to the memory-fit message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    server.use(
      http.post(`${base}/:repositoryId/index/zoekt`, () => {
        const error = nodeError("upstream closed", "EIO")
        error.cause = nodeError("read ECONNRESET", "ECONNRESET")
        throw error
      }),
    )
    await expect(
      codesearchIndexZoekt({ repositoryId: "repo_1", orgId: "org_1" }),
    ).rejects.toThrow(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY)
  })

  it("rewrites HTTP 500 exit 137 bodies to the memory-fit message", async () => {
    server.use(
      http.post(`${base}/:repositoryId/index/zoekt`, () =>
        HttpResponse.json(
          { error: "Command failed with exit code 137\nstderr: Killed" },
          { status: 500 },
        ),
      ),
    )
    await expect(
      codesearchIndexZoekt({ repositoryId: "repo_1", orgId: "org_1" }),
    ).rejects.toThrow(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY)
  })

  it("throws CodesearchAdmissionBusyError on HTTP 429 without mapping to memory-fit", async () => {
    server.use(
      http.post(`${base}/:repositoryId/index/zoekt`, () =>
        HttpResponse.json(
          { error: "Index pipeline capacity exceeded" },
          { status: 429 },
        ),
      ),
    )
    await expect(
      codesearchIndexZoekt({ repositoryId: "repo_1", orgId: "org_1" }),
    ).rejects.toBeInstanceOf(CodesearchAdmissionBusyError)
  })

  it("throws RepositoryGoneError when codesearch says the repository is gone", async () => {
    server.use(
      http.post(`${base}/:repositoryId/index/zoekt`, () =>
        HttpResponse.json(
          {
            error: "Repository not found or access denied",
            code: "repository_not_found",
          },
          { status: 404 },
        ),
      ),
    )
    await expect(
      codesearchIndexZoekt({ repositoryId: "repo_1", orgId: "org_1" }),
    ).rejects.toBeInstanceOf(RepositoryGoneError)
  })
})

describe("codesearchIndexScipLang", () => {
  it("rewrites a fetch failure to the memory-fit message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    server.use(
      http.post(`${base}/:repositoryId/index/scip/:language`, () => {
        throw nodeError("fetch failed", "EIO")
      }),
    )
    await expect(
      codesearchIndexScipLang(
        { repositoryId: "repo_1", orgId: "org_1" },
        "go",
        ["go"],
      ),
    ).rejects.toThrow(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY)
  })

  it("rewrites an ECONNRESET cause to the memory-fit message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    server.use(
      http.post(`${base}/:repositoryId/index/scip/:language`, () => {
        const error = nodeError("upstream closed", "EIO")
        error.cause = nodeError("read ECONNRESET", "ECONNRESET")
        throw error
      }),
    )
    await expect(
      codesearchIndexScipLang(
        { repositoryId: "repo_1", orgId: "org_1" },
        "go",
        ["go"],
      ),
    ).rejects.toThrow(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY)
  })

  it("rewrites HTTP 500 exit 137 bodies to the memory-fit message", async () => {
    server.use(
      http.post(`${base}/:repositoryId/index/scip/:language`, () =>
        HttpResponse.json(
          { error: "Command failed with exit code 137\nstderr: Killed" },
          { status: 500 },
        ),
      ),
    )
    await expect(
      codesearchIndexScipLang(
        { repositoryId: "repo_1", orgId: "org_1" },
        "go",
        ["go"],
      ),
    ).rejects.toThrow(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY)
  })
})

describe("codesearchIndexScipLang when the phase is accepted", () => {
  it("waits out a headers timeout and returns when the phase succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    let polls = 0
    server.use(
      http.post(`${base}/:repositoryId/index/scip/:language`, () =>
        HttpResponse.json({ ok: true, status: "running" }, { status: 202 }),
      ),
      http.get(`${base}/:repositoryId/index/scip/:language`, () => {
        polls += 1
        if (polls === 1) {
          const error = nodeError("fetch failed", "UND_ERR_HEADERS_TIMEOUT")
          error.cause = nodeError(
            "Headers Timeout Error",
            "UND_ERR_HEADERS_TIMEOUT",
          )
          throw error
        }
        return HttpResponse.json({ status: "succeeded" })
      }),
    )
    await expect(
      codesearchIndexScipLang(
        { repositoryId: "repo_1", orgId: "org_1" },
        "typescript",
        ["typescript"],
      ),
    ).resolves.toEqual({})
    expect(polls).toBe(2)
  })

  it("returns the incomplete-shard note from a settled phase", async () => {
    server.use(
      http.post(`${base}/:repositoryId/index/scip/:language`, () =>
        HttpResponse.json({ ok: true, status: "running" }, { status: 202 }),
      ),
      http.get(`${base}/:repositoryId/index/scip/:language`, () =>
        HttpResponse.json({
          status: "succeeded",
          issue: "1 of 44 projects could not be indexed",
        }),
      ),
    )
    await expect(
      codesearchIndexScipLang(
        { repositoryId: "repo_1", orgId: "org_1" },
        "typescript",
        ["typescript"],
      ),
    ).resolves.toEqual({
      issue: "1 of 44 projects could not be indexed",
    })
  })
})

describe("codesearchIndexScipLang result", () => {
  it("returns the public issue of an incomplete shard", async () => {
    server.use(
      http.post(`${base}/:repositoryId/index/scip/:language`, () =>
        HttpResponse.json({ ok: true, issue: "1 of 3 projects failed" }),
      ),
    )
    await expect(
      codesearchIndexScipLang(
        { repositoryId: "repo_1", orgId: "org_1" },
        "typescript",
        ["typescript"],
      ),
    ).resolves.toEqual({ issue: "1 of 3 projects failed" })
  })
})

describe("codesearchIndexMergeScip", () => {
  it("sends an empty languagesToMerge array so merge omits leftover shards", async () => {
    let body: unknown
    server.use(
      http.post(
        `${base}/:repositoryId/index/merge-scip`,
        async ({ request }) => {
          body = await request.json()
          return HttpResponse.json({ ok: true, shardCount: 0 })
        },
      ),
    )

    await expect(
      codesearchIndexMergeScip(
        { repositoryId: "repo_1", orgId: "org_1" },
        ["go", "typescript"],
        [],
      ),
    ).resolves.toEqual({ ok: true, shardCount: 0 })
    expect(body).toEqual({
      detectedLanguages: ["go", "typescript"],
      languagesToMerge: [],
    })
  })

  it("omits languagesToMerge when the caller does not override shards", async () => {
    let body: unknown
    server.use(
      http.post(
        `${base}/:repositoryId/index/merge-scip`,
        async ({ request }) => {
          body = await request.json()
          return HttpResponse.json({ ok: true, shardCount: 1 })
        },
      ),
    )

    await expect(
      codesearchIndexMergeScip({ repositoryId: "repo_1", orgId: "org_1" }, [
        "go",
      ]),
    ).resolves.toEqual({ ok: true, shardCount: 1 })
    expect(body).toEqual({ detectedLanguages: ["go"] })
  })
})
