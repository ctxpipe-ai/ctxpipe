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

function asRootEntries(filePaths: string[]) {
  return filePaths.map((path) => {
    const segments = path.split("/")
    return {
      name: segments[segments.length - 1],
      path,
      type: "file" as const,
    }
  })
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

  it("resolves package.json workspaces deterministically", async () => {
    listFilesMock.mockResolvedValue(asRootEntries(["package.json"]))
    fetchFilesMock.mockResolvedValue({
      "package.json": JSON.stringify({
        private: true,
        workspaces: ["apps/*", "packages/*"],
      }),
    })
    listFilesRecursiveMock.mockResolvedValue([
      "apps/web/package.json",
      "packages/core/package.json",
      "README.md",
    ])

    const result = await deterministicDetectRoots(baseState())
    expect(result).toEqual({
      decision: "confident",
      roots: ["apps/web", "packages/core"],
      evidence: ["package.json:workspaces", "workspace globs resolved from package markers"],
    })
  })

  it("resolves lerna packages deterministically", async () => {
    listFilesMock.mockResolvedValue(asRootEntries(["lerna.json"]))
    fetchFilesMock.mockResolvedValue({
      "lerna.json": JSON.stringify({
        packages: ["services/*", "libs/*"],
      }),
    })
    listFilesRecursiveMock.mockResolvedValue([
      "services/api/package.json",
      "libs/utils/package.json",
      "README.md",
    ])

    const result = await deterministicDetectRoots(baseState())
    expect(result).toEqual({
      decision: "confident",
      roots: ["libs/utils", "services/api"],
      evidence: ["lerna.json:packages", "workspace globs resolved from package markers"],
    })
  })

  it("resolves rush project folders deterministically", async () => {
    listFilesMock.mockResolvedValue(asRootEntries(["rush.json"]))
    fetchFilesMock.mockResolvedValue({
      "rush.json": JSON.stringify({
        projects: [
          { projectFolder: "apps/frontend" },
          { projectFolder: "packages/api" },
        ],
      }),
    })

    const result = await deterministicDetectRoots(baseState())
    expect(result).toEqual({
      decision: "confident",
      roots: ["apps/frontend", "packages/api"],
      evidence: ["rush.json:projects"],
    })
    expect(listFilesRecursiveMock).not.toHaveBeenCalled()
  })

  it("resolves deno workspace members deterministically", async () => {
    listFilesMock.mockResolvedValue(asRootEntries(["deno.json"]))
    fetchFilesMock.mockResolvedValue({
      "deno.json": JSON.stringify({
        workspace: ["apps/docs", "packages/runtime"],
      }),
    })

    const result = await deterministicDetectRoots(baseState())
    expect(result).toEqual({
      decision: "confident",
      roots: ["apps/docs", "packages/runtime"],
      evidence: ["deno.json:workspace"],
    })
    expect(listFilesRecursiveMock).not.toHaveBeenCalled()
  })

  it("handles Cargo workspace manifest without crashing", async () => {
    listFilesMock.mockResolvedValue(asRootEntries(["Cargo.toml"]))
    fetchFilesMock.mockResolvedValue({
      "Cargo.toml": `[workspace]
members = ["crates/*", "tools/*"]
`,
    })
    listFilesRecursiveMock.mockResolvedValue([
      "crates/engine/Cargo.toml",
      "tools/codegen/Cargo.toml",
      "README.md",
    ])

    const result = await deterministicDetectRoots(baseState())
    expect(result).toEqual({
      decision: "confident",
      roots: ["./"],
      evidence: ["fallback:repo-root"],
    })
    expect(listFilesRecursiveMock).not.toHaveBeenCalled()
  })

  it("handles uv workspace manifest in pyproject.toml without crashing", async () => {
    listFilesMock.mockResolvedValue(asRootEntries(["pyproject.toml"]))
    fetchFilesMock.mockResolvedValue({
      "pyproject.toml": `[tool.uv.workspace]
members = ["services/*", "packages/*"]
`,
    })
    listFilesRecursiveMock.mockResolvedValue([
      "services/api/pyproject.toml",
      "packages/cli/pyproject.toml",
      "README.md",
    ])

    const result = await deterministicDetectRoots(baseState())
    expect(result).toEqual({
      decision: "confident",
      roots: ["./"],
      evidence: ["fallback:repo-root"],
    })
    expect(listFilesRecursiveMock).not.toHaveBeenCalled()
  })

  it("resolves maven modules deterministically", async () => {
    listFilesMock.mockResolvedValue(asRootEntries(["pom.xml"]))
    fetchFilesMock.mockResolvedValue({
      "pom.xml": `<project>
  <modules>
    <module>backend</module>
    <module>services/api</module>
  </modules>
</project>`,
    })

    const result = await deterministicDetectRoots(baseState())
    expect(result).toEqual({
      decision: "confident",
      roots: ["backend", "services/api"],
      evidence: ["pom.xml:modules"],
    })
    expect(listFilesRecursiveMock).not.toHaveBeenCalled()
  })

  it("resolves gradle includes deterministically", async () => {
    listFilesMock.mockResolvedValue(asRootEntries(["settings.gradle.kts"]))
    fetchFilesMock.mockResolvedValue({
      "settings.gradle.kts": `include(":apps:web", ":libs:core")
`,
    })

    const result = await deterministicDetectRoots(baseState())
    expect(result).toEqual({
      decision: "confident",
      roots: ["apps/web", "libs/core"],
      evidence: ["settings.gradle.kts:include"],
    })
    expect(listFilesRecursiveMock).not.toHaveBeenCalled()
  })

  it("resolves workspace.json projects deterministically", async () => {
    listFilesMock.mockResolvedValue(asRootEntries(["workspace.json"]))
    fetchFilesMock.mockResolvedValue({
      "workspace.json": JSON.stringify({
        projects: {
          frontend: "apps/frontend",
          api: { root: "services/api" },
        },
      }),
    })

    const result = await deterministicDetectRoots(baseState())
    expect(result).toEqual({
      decision: "confident",
      roots: ["apps/frontend", "services/api"],
      evidence: ["workspace.json:projects"],
    })
    expect(listFilesRecursiveMock).not.toHaveBeenCalled()
  })
})
