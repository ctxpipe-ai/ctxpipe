import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CodeIngestionState } from "../schemas.js"

const listFilesMock = vi.hoisted(() => vi.fn())
const listFilesRecursiveMock = vi.hoisted(() => vi.fn())
const fetchFilesMock = vi.hoisted(() => vi.fn())

vi.mock("../../../domain/codeIngestion/codesearchClient.js", () => ({
  listFiles: listFilesMock,
  listFilesRecursive: listFilesRecursiveMock,
  fetchFiles: fetchFilesMock,
}))

import { deterministicDetectRoots } from "./identifyRootsDeterministic.js"

function baseState(): CodeIngestionState {
  return {
    repositoryId: "repo_test",
    orgId: "org_test",
    targetHash: "abc123",
    extractedObjects: [],
    extractedClaims: [],
    objectIds: [],
    touchedObjectIds: [],
    claimsForProjection: [],
  }
}

describe("deterministicDetectRoots", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("resolves pnpm workspace roots without LLM fallback", async () => {
    listFilesMock.mockResolvedValue([
      { name: "pnpm-workspace.yaml", path: "pnpm-workspace.yaml", type: "file" },
      { name: "apps", path: "apps", type: "dir" },
      { name: "packages", path: "packages", type: "dir" },
    ])
    fetchFilesMock.mockResolvedValue({
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
    })
    listFilesRecursiveMock.mockResolvedValue([
      "apps/backend/package.json",
      "apps/ui/package.json",
      "packages/sdk/package.json",
      "README.md",
    ])

    const result = await deterministicDetectRoots(baseState())
    expect(result).toEqual({
      decision: "confident",
      roots: ["apps/backend", "apps/ui", "packages/sdk"],
      evidence: ["pnpm-workspace.yaml:packages", "workspace globs resolved from package markers"],
    })
  })

  it("returns ambiguous with partial roots when some workspace globs do not resolve", async () => {
    listFilesMock.mockResolvedValue([
      { name: "package.json", path: "package.json", type: "file" },
      { name: "apps", path: "apps", type: "dir" },
    ])
    fetchFilesMock.mockResolvedValue({
      "package.json": JSON.stringify({
        private: true,
        workspaces: ["apps/*", "packages/*"],
      }),
    })
    listFilesRecursiveMock.mockResolvedValue([
      "apps/api/package.json",
      "README.md",
    ])

    const result = await deterministicDetectRoots(baseState())
    expect(result.decision).toBe("ambiguous")
    expect(result.roots).toEqual(["apps/api"])
    if (result.decision === "ambiguous") {
      expect(result.partialRoots).toEqual(["apps/api"])
      expect(result.reason).toContain("packages/*")
    }
  })

  it("falls back to repo root when no monorepo manifests are present", async () => {
    listFilesMock.mockResolvedValue([
      { name: "package.json", path: "package.json", type: "file" },
      { name: "src", path: "src", type: "dir" },
    ])
    fetchFilesMock.mockResolvedValue({
      "package.json": JSON.stringify({ name: "single-repo-app" }),
    })

    const result = await deterministicDetectRoots(baseState())
    expect(result).toEqual({
      decision: "confident",
      roots: ["./"],
      evidence: ["fallback:repo-root"],
    })
    expect(listFilesRecursiveMock).not.toHaveBeenCalled()
  })

  it("resolves go.work use directives as explicit roots", async () => {
    listFilesMock.mockResolvedValue([
      { name: "go.work", path: "go.work", type: "file" },
      { name: "services", path: "services", type: "dir" },
    ])
    fetchFilesMock.mockResolvedValue({
      "go.work": "go 1.22\n\nuse (\n  ./services/api\n  ./services/worker\n)\n",
    })

    const result = await deterministicDetectRoots(baseState())
    expect(result).toEqual({
      decision: "confident",
      roots: ["services/api", "services/worker"],
      evidence: ["go.work:use"],
    })
    expect(listFilesRecursiveMock).not.toHaveBeenCalled()
  })
})
