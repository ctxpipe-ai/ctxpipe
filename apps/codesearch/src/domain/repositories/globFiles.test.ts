import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  globFilesInCheckout,
  isSkippedGlobPath,
  resolveGlobLimit,
} from "./globFiles.js"

describe("isSkippedGlobPath", () => {
  it("skips vendor and dependency segments", () => {
    expect(isSkippedGlobPath("node_modules/pkg/readme.md")).toBe(true)
    expect(isSkippedGlobPath("vendor/foo/README.md")).toBe(true)
    expect(isSkippedGlobPath(".git/config")).toBe(true)
    expect(isSkippedGlobPath("external/bazel/foo.md")).toBe(true)
  })

  it("keeps first-party paths", () => {
    expect(isSkippedGlobPath("apps/foo/README.md")).toBe(false)
    expect(isSkippedGlobPath("internal/vendor/onboarding/AGENTS.md")).toBe(
      false,
    )
    expect(isSkippedGlobPath(".cursor/rules/x.mdc")).toBe(false)
  })
})

describe("resolveGlobLimit", () => {
  it("defaults and caps", () => {
    expect(resolveGlobLimit(undefined)).toBe(50_000)
    expect(resolveGlobLimit(10)).toBe(10)
    expect(resolveGlobLimit(100_000)).toBe(50_000)
  })
})

describe("globFilesInCheckout", () => {
  let tmpDir: string

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  })

  async function setupCheckout(): Promise<string> {
    tmpDir = await mkdtemp(join(tmpdir(), "glob-files-"))
    await mkdir(join(tmpDir, "src", "nested"), { recursive: true })
    await mkdir(join(tmpDir, ".cursor", "rules"), { recursive: true })
    await mkdir(join(tmpDir, "node_modules", "pkg"), { recursive: true })
    await writeFile(join(tmpDir, "README.md"), "# root\n")
    await writeFile(join(tmpDir, "src", "a.ts"), "export {}\n")
    await writeFile(join(tmpDir, "src", "nested", "b.ts"), "export {}\n")
    await writeFile(join(tmpDir, ".cursor", "rules", "x.mdc"), "rule\n")
    await writeFile(join(tmpDir, "node_modules", "pkg", "index.js"), "1\n")
    return tmpDir
  }

  it("lists a single folder with default onlyFiles false (dirs + files)", async () => {
    const root = await setupCheckout()
    const result = await globFilesInCheckout({
      checkoutRoot: root,
      pattern: "*",
      path: "src",
    })
    const byPath = Object.fromEntries(result.entries.map((e) => [e.path, e]))
    expect(byPath["src/a.ts"]?.type).toBe("file")
    expect(byPath["src/nested"]?.type).toBe("dir")
    expect(result.truncated).toBe(false)
  })

  it("includes dotpaths by default", async () => {
    const root = await setupCheckout()
    const result = await globFilesInCheckout({
      checkoutRoot: root,
      pattern: "**/*.{md,mdc}",
      onlyFiles: true,
    })
    const paths = result.entries.map((e) => e.path).sort()
    expect(paths).toContain("README.md")
    expect(paths).toContain(".cursor/rules/x.mdc")
  })

  it("skips node_modules matches", async () => {
    const root = await setupCheckout()
    const result = await globFilesInCheckout({
      checkoutRoot: root,
      pattern: "**/*",
      onlyFiles: true,
    })
    expect(result.entries.every((e) => !e.path.includes("node_modules"))).toBe(
      true,
    )
  })

  it("sets truncated when over limit", async () => {
    const root = await setupCheckout()
    const result = await globFilesInCheckout({
      checkoutRoot: root,
      pattern: "**/*",
      onlyFiles: true,
      limit: 1,
    })
    expect(result.entries).toHaveLength(1)
    expect(result.truncated).toBe(true)
    expect(result.matched).toBeGreaterThan(1)
  })

  it("rejects path traversal", async () => {
    const root = await setupCheckout()
    await expect(
      globFilesInCheckout({
        checkoutRoot: root,
        pattern: "*",
        path: "../outside",
      }),
    ).rejects.toThrow("Path traversal is not allowed")
  })
})
