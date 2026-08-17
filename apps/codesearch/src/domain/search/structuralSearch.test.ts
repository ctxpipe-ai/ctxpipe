import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  buildAstGrepArgv,
  resolveStructuralSearchPaths,
  runStructuralSearch,
} from "./structuralSearch.js"

describe("buildAstGrepArgv", () => {
  it("builds an ast-grep argv without shell interpretation", () => {
    const argv = buildAstGrepArgv({
      pattern: "$CALL($ARG); rm -rf /",
      lang: "typescript",
      globs: ["src/**/*.ts", "!**/*.test.ts"],
      paths: ["/repo/checkout/src", "/repo/checkout/packages/api"],
    })

    expect(argv).toEqual([
      "ast-grep",
      "run",
      "--pattern",
      "$CALL($ARG); rm -rf /",
      "--json=stream",
      "--lang",
      "typescript",
      "--globs",
      "src/**/*.ts",
      "--globs",
      "!**/*.test.ts",
      "--",
      "/repo/checkout/src",
      "/repo/checkout/packages/api",
    ])
    expect(argv[0]).not.toBe("sg")
  })
})

describe("structural search path containment", () => {
  it("rejects a requested path whose symlink target escapes the checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "structural-search-"))
    const checkoutPath = join(root, "checkout")
    const outsidePath = join(root, "outside.ts")
    await mkdir(checkoutPath)
    await writeFile(outsidePath, "outside()")
    await symlink(outsidePath, join(checkoutPath, "escape.ts"))

    try {
      await expect(
        resolveStructuralSearchPaths(checkoutPath, [
          join(checkoutPath, "escape.ts"),
        ]),
      ).rejects.toThrow("Structural search path escapes checkout")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects an ast-grep result whose file resolves outside the checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "structural-search-"))
    const checkoutPath = join(root, "checkout")
    const outsidePath = join(root, "outside.ts")
    const escapePath = join(checkoutPath, "escape.ts")
    await mkdir(checkoutPath)
    await writeFile(outsidePath, "outside()")
    await symlink(outsidePath, escapePath)
    vi.stubGlobal("Bun", {
      spawn: vi.fn(() => ({
        stdout: new Response(`${JSON.stringify({ file: escapePath })}\n`).body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
      })),
    })

    try {
      await expect(
        runStructuralSearch({
          checkoutPath,
          pattern: "$F()",
          paths: [checkoutPath],
          limit: 10,
        }),
      ).rejects.toThrow("Structural search path escapes checkout")
    } finally {
      vi.unstubAllGlobals()
      await rm(root, { recursive: true, force: true })
    }
  })
})
