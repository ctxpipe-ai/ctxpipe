import { execFileSync, spawn } from "node:child_process"
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { Readable } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import {
  buildAstGrepArgv,
  resolveStructuralSearchPaths,
  runStructuralSearch,
} from "./structuralSearch.js"

// Vitest runs in Node, so give runStructuralSearch a Bun.spawn that starts
// the real ast-grep binary.
function stubBunSpawnWithNode(): void {
  vi.stubGlobal("Bun", {
    spawn: (argv: string[], options: { cwd: string }) => {
      const child = spawn(argv[0] as string, argv.slice(1), {
        cwd: options.cwd,
      })
      return {
        stdout: Readable.toWeb(child.stdout),
        stderr: Readable.toWeb(child.stderr),
        exited: new Promise((done) => child.on("close", done)),
      }
    },
  })
}

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
      "--config",
      "/dev/null",
      "--pattern",
      "$CALL($ARG); rm -rf /",
      "--json=stream",
      "--lang",
      "typescript",
      "--globs",
      "src/**/*.ts",
      "--globs",
      "!**/*.test.ts",
      "--globs",
      "!.git",
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
      ).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // A committed sgconfig.yml can map "config" to a language, so ast-grep
  // would print .git/config and its clone token.
  it("refuses a requested path inside .git", async () => {
    const root = await mkdtemp(join(tmpdir(), "structural-search-"))
    const checkoutPath = join(root, "checkout")
    await mkdir(join(checkoutPath, ".git"), { recursive: true })
    await writeFile(join(checkoutPath, ".git", "config"), "token\n")

    try {
      for (const path of [".git/config", ".git", ".Git/config"]) {
        await expect(
          resolveStructuralSearchPaths(checkoutPath, [path]),
        ).rejects.toMatchObject({ code: "ENOENT" })
      }
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

  it("ignores an ast-grep config file from the checkout", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "structural-search-")),
    )
    const checkoutPath = join(root, "checkout")
    await mkdir(checkoutPath)
    await writeFile(
      join(checkoutPath, "sgconfig.yml"),
      'languageGlobs:\n  python: ["notes.cfg"]\n',
    )
    await writeFile(join(checkoutPath, "notes.cfg"), "print(1)\n")
    await writeFile(join(checkoutPath, "main.py"), "print(2)\n")
    stubBunSpawnWithNode()

    try {
      const matches = await runStructuralSearch({
        checkoutPath,
        pattern: "print($A)",
        lang: "python",
        paths: [checkoutPath],
        limit: 100,
      })

      const files = matches.map((match) =>
        relative(checkoutPath, String(match.file)),
      )
      expect(files).toEqual(["main.py"])
    } finally {
      vi.unstubAllGlobals()
      await rm(root, { recursive: true, force: true })
    }
  })

  // A user glob is a whitelist override in ast-grep, so it skips the hidden
  // file check. With a committed sgconfig.yml that maps "config" to bash,
  // the glob "*" would print .git/config and its clone token.
  it("returns no match from .git when a user glob matches every file", async () => {
    const root = await mkdtemp(join(tmpdir(), "structural-search-"))
    const checkoutPath = join(root, "checkout")
    await mkdir(checkoutPath)
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: checkoutPath, stdio: "ignore" })
    git("init", "-q")
    git(
      "remote",
      "add",
      "origin",
      "https://x-access-token:ghs_faketoken@example.com/demo.git",
    )
    await writeFile(
      join(checkoutPath, "sgconfig.yml"),
      'languageGlobs:\n  bash: ["config"]\n',
    )
    await writeFile(join(checkoutPath, "run.sh"), "echo hi\n")
    git("add", "-A")
    git(
      "-c",
      "user.email=a@example.com",
      "-c",
      "user.name=a",
      "commit",
      "-qm",
      "init",
    )
    stubBunSpawnWithNode()

    try {
      const matches = await runStructuralSearch({
        checkoutPath,
        pattern: "$A",
        lang: "bash",
        globs: ["*"],
        paths: [checkoutPath],
        limit: 100,
      })

      const files = matches.map((match) => String(match.file))
      expect(files.some((file) => file.endsWith("run.sh"))).toBe(true)
      expect(files.filter((file) => file.includes(".git"))).toEqual([])
      expect(JSON.stringify(matches)).not.toContain("ghs_faketoken")
    } finally {
      vi.unstubAllGlobals()
      await rm(root, { recursive: true, force: true })
    }
  })
})
