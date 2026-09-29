import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { readlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  linkWorkspacePackages,
  scanTypeScriptWorkspace,
} from "./typeScriptProjects.js"

const temporaryDirectories: string[] = []

function checkout(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "typescript-projects-"))
  temporaryDirectories.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe("scanTypeScriptWorkspace", () => {
  it("indexes a single-package repository from its root config", async () => {
    const root = checkout({
      "tsconfig.json": "{}",
      "package.json": '{"name":"app"}',
      "test/fixtures/tsconfig.json": "{}",
    })

    expect(await scanTypeScriptWorkspace(root)).toEqual({
      projects: ["."],
      packages: [],
    })
  })

  it("indexes outermost nested projects of a monorepo and lists its packages", async () => {
    const root = checkout({
      "package.json": '{"name":"mono","workspaces":["packages/*"]}',
      "tsconfig.json": '{"files":["node_modules/x/index.d.ts"]}',
      "packages/core/package.json": '{"name":"@mono/core"}',
      "packages/core/tsconfig.json": "{}",
      "packages/core/test/tsconfig.json": "{}",
      "packages/ui/jsconfig.json": "{}",
      "node_modules/dep/tsconfig.json": "{}",
    })

    expect(await scanTypeScriptWorkspace(root)).toEqual({
      projects: ["packages/core", "packages/ui"],
      packages: [
        { name: "mono", dir: "" },
        { name: "@mono/core", dir: "packages/core" },
      ],
    })
  })

  it("indexes nested-only configs without linking packages", async () => {
    const root = checkout({
      "web/tsconfig.json": "{}",
      "web/package.json": '{"name":"web"}',
    })

    expect(await scanTypeScriptWorkspace(root)).toEqual({
      projects: ["web"],
      packages: [],
    })
  })
})

describe("linkWorkspacePackages", () => {
  it("links packages into a temporary node_modules and removes it", async () => {
    const root = checkout({ "packages/core/package.json": "{}" })

    const unlink = await linkWorkspacePackages(root, [
      { name: "@mono/core", dir: "packages/core" },
      { name: "../escape", dir: "packages/core" },
    ])

    expect(await readlink(join(root, "node_modules", "@mono", "core"))).toBe(
      join(root, "packages/core"),
    )
    expect(existsSync(join(root, "escape"))).toBe(false)
    await unlink()
    expect(existsSync(join(root, "node_modules"))).toBe(false)
    expect(existsSync(join(root, "packages/core/package.json"))).toBe(true)
  })

  it("leaves an existing node_modules untouched", async () => {
    const root = checkout({ "node_modules/.keep": "" })

    const unlink = await linkWorkspacePackages(root, [
      { name: "core", dir: "" },
    ])
    await unlink()

    expect(existsSync(join(root, "node_modules", ".keep"))).toBe(true)
    expect(existsSync(join(root, "node_modules", "core"))).toBe(false)
  })
})
