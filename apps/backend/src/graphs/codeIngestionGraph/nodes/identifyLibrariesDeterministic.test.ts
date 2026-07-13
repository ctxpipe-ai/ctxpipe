import { beforeEach, describe, expect, it, vi } from "vitest"

const fetchFilesMock = vi.hoisted(() => vi.fn())
const listFilesRecursiveMock = vi.hoisted(() => vi.fn())

vi.mock("../../../domain/codeIngestion/codesearchClient.js", () => ({
  fetchFiles: fetchFilesMock,
  listFilesRecursive: listFilesRecursiveMock,
}))

import {
  detectLibrariesDeterministic,
  normalizeLibraryName,
  scoreLibraryCandidate,
} from "./identifyLibrariesDeterministic.js"

describe("identifyLibrariesDeterministic", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("normalizes alias names to canonical library names", () => {
    expect(normalizeLibraryName("drizzle-orm")).toBe("Drizzle")
    expect(normalizeLibraryName("better-auth")).toBe("Better Auth")
  })

  it("scores accepted and ambiguous boundaries correctly", () => {
    const accepted = scoreLibraryCandidate({
      hasManifestDependency: true,
      hasCorroboration: true,
      hasImportUsage: true,
    })
    expect(accepted.confidence).toBe(1)

    const ambiguous = scoreLibraryCandidate({
      hasManifestDependency: true,
      hasCorroboration: true,
      hasImportUsage: false,
    })
    expect(ambiguous.confidence).toBe(0.75)
  })

  it("accepts deterministic candidates when all signals corroborate", async () => {
    listFilesRecursiveMock.mockResolvedValue([
      "apps/api/package.json",
      "apps/api/pnpm-lock.yaml",
      "apps/api/src/app.ts",
    ])
    fetchFilesMock.mockResolvedValue({
      "apps/api/package.json": JSON.stringify({
        dependencies: { "drizzle-orm": "^0.32.0" },
      }),
      "apps/api/src/app.ts":
        'import { drizzle } from "drizzle-orm"\nconst db = drizzle({})\n',
    })

    const result = await detectLibrariesDeterministic({
      repositoryId: "repo_abc",
      orgId: "org_abc",
      roots: ["apps/api"],
    })

    expect(result.accepted).toHaveLength(1)
    expect(result.accepted[0]).toMatchObject({
      root: "apps/api",
      name: "Drizzle",
      category: "ORM",
      confidence: 1,
    })
    expect(result.accepted[0]?.detectionSignals).toEqual(
      expect.arrayContaining([
        "manifest_dependency",
        "lock_or_config",
        "import_usage",
      ]),
    )
    expect(result.rootsNeedingLlm).toEqual([])
  })

  it("marks dependency-only candidates as ambiguous and keeps LLM fallback", async () => {
    listFilesRecursiveMock.mockResolvedValue([
      "apps/api/package.json",
      "apps/api/pnpm-lock.yaml",
    ])
    fetchFilesMock.mockResolvedValue({
      "apps/api/package.json": JSON.stringify({
        dependencies: { "better-auth": "^1.0.0" },
      }),
    })

    const result = await detectLibrariesDeterministic({
      repositoryId: "repo_abc",
      orgId: "org_abc",
      roots: ["apps/api"],
    })

    expect(result.accepted).toHaveLength(0)
    expect(result.ambiguous).toHaveLength(1)
    expect(result.ambiguous[0]).toMatchObject({
      root: "apps/api",
      name: "Better Auth",
      confidence: 0.75,
    })
    expect(result.rootsNeedingLlm).toEqual(["apps/api"])
  })

  it("respects partial scan filtering for deterministic roots", async () => {
    listFilesRecursiveMock.mockResolvedValue([
      "apps/api/package.json",
      "apps/api/src/app.ts",
    ])
    fetchFilesMock.mockResolvedValue({
      "apps/api/package.json": JSON.stringify({
        dependencies: { zod: "^3.23.0" },
      }),
      "apps/api/src/app.ts": 'import { z } from "zod"\n',
    })

    const result = await detectLibrariesDeterministic({
      repositoryId: "repo_abc",
      orgId: "org_abc",
      roots: ["apps/api"],
      scanPaths: ["apps/api/src"],
    })

    expect(result.accepted).toHaveLength(0)
    expect(result.ambiguous).toHaveLength(0)
    expect(result.unresolvedRoots).toEqual(["apps/api"])
    expect(result.rootsNeedingLlm).toEqual(["apps/api"])
  })
})
