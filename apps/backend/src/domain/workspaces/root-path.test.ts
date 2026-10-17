import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  gitChangesOutsideWorkspaceRoot,
  isInsideWorkspaceRoot,
  pathsOutsideWorkspaceRoot,
  workspaceRelativePath,
  workspaceRepositoryPath,
  workspaceRootPath,
  workspaceRootPathSchema,
} from "./root-path.js"

describe("workspaceRootPathSchema", () => {
  it.each([
    ["", ""],
    ["  ", ""],
    ["/", ""],
    ["docs/context", "docs/context"],
    ["docs/context/", "docs/context"],
    ["docs/context///", "docs/context"],
    [" docs/context ", "docs/context"],
    ["a.b/c_d-e", "a.b/c_d-e"],
    [".ctxpipe-context", ".ctxpipe-context"],
  ])("normalizes %j to %j", (raw, normalized) => {
    expect(workspaceRootPathSchema.parse(raw)).toBe(normalized)
  })

  it.each([
    "/docs",
    "../docs",
    "docs/../..",
    "docs/./context",
    ".",
    "docs//context",
    ".git",
    "docs/.GIT/hooks",
    "docs\\context",
    "docs/con text",
    "docs/ctx\0",
    "docs/ünicode",
    "docs/$(whoami)",
    "a/".repeat(40),
    "x".repeat(201),
  ])("rejects %j", (raw) => {
    expect(workspaceRootPathSchema.safeParse(raw).success).toBe(false)
  })
})

describe("workspace root path mapping", () => {
  it("keeps every path when the root is the repository root", () => {
    expect(isInsideWorkspaceRoot("", "src/a.ts")).toBe(true)
    expect(workspaceRepositoryPath("", "knowledge/a.md")).toBe("knowledge/a.md")
    expect(workspaceRelativePath("", "knowledge/a.md")).toBe("knowledge/a.md")
  })

  it("accepts only paths below the root folder", () => {
    expect(isInsideWorkspaceRoot("docs/context", "docs/context/a.md")).toBe(
      true,
    )
    expect(isInsideWorkspaceRoot("docs/context", "docs/context")).toBe(false)
    expect(isInsideWorkspaceRoot("docs/context", "docs/contextual/a.md")).toBe(
      false,
    )
    expect(isInsideWorkspaceRoot("docs/context", "docs/a.md")).toBe(false)
    expect(isInsideWorkspaceRoot("docs/context", "docs/context/../a.md")).toBe(
      false,
    )
    expect(isInsideWorkspaceRoot("docs/context", "/docs/context/a.md")).toBe(
      false,
    )
  })

  it("lists the paths outside the root folder", () => {
    expect(
      pathsOutsideWorkspaceRoot("docs/context", [
        "docs/context/.ctxpipe/sources.yaml",
        "README.md",
        "docs/context/../../src/a.ts",
      ]),
    ).toEqual(["README.md", "docs/context/../../src/a.ts"])
  })

  it("maps a root-relative path into the repository", () => {
    expect(
      workspaceRepositoryPath("docs/context", ".ctxpipe/sources.yaml"),
    ).toBe("docs/context/.ctxpipe/sources.yaml")
    expect(() =>
      workspaceRepositoryPath("docs/context", "../src/a.ts"),
    ).toThrow()
    expect(() =>
      workspaceRepositoryPath("docs/context", "/etc/passwd"),
    ).toThrow()
    expect(() =>
      workspaceRepositoryPath("docs/context", "a/.git/config"),
    ).toThrow()
  })

  it("maps a repository path to the root-relative path, or null outside", () => {
    expect(workspaceRelativePath("docs/context", "docs/context/a/b.md")).toBe(
      "a/b.md",
    )
    expect(workspaceRelativePath("docs/context", "docs/other.md")).toBeNull()
  })
})

describe("gitChangesOutsideWorkspaceRoot", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true })
  })

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
      },
    }).trim()
  }

  function repository(): { dir: string; base: string } {
    const dir = mkdtempSync(join(tmpdir(), "root-path-"))
    dirs.push(dir)
    git(dir, ["init", "-q", "-b", "main"])
    write(dir, "docs/context/knowledge/a.md", "# A\n")
    write(dir, "src/app.ts", "export {}\n")
    symlinkSync("../../src", join(dir, "docs/context/escape"))
    git(dir, ["add", "-A"])
    git(dir, ["commit", "-q", "-m", "base"])
    return { dir, base: git(dir, ["rev-parse", "HEAD"]) }
  }

  function write(dir: string, path: string, content: string) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }

  function commit(dir: string): string {
    git(dir, ["add", "-A"])
    git(dir, ["commit", "-q", "-m", "change"])
    return git(dir, ["rev-parse", "HEAD"])
  }

  it("accepts changes below the root folder", async () => {
    const { dir, base } = repository()
    write(dir, "docs/context/knowledge/b.md", "# B\n")
    symlinkSync("../knowledge/a.md", join(dir, "docs/context/knowledge/c.md"))
    const head = commit(dir)
    await expect(
      gitChangesOutsideWorkspaceRoot({
        directory: dir,
        base,
        head,
        rootPath: "docs/context",
      }),
    ).resolves.toEqual([])
  })

  it("rejects a file outside the root folder", async () => {
    const { dir, base } = repository()
    write(dir, "src/app.ts", "export const x = 1\n")
    const head = commit(dir)
    await expect(
      gitChangesOutsideWorkspaceRoot({
        directory: dir,
        base,
        head,
        rootPath: "docs/context",
      }),
    ).resolves.toEqual([{ path: "src/app.ts", reason: "outside_root" }])
  })

  it("rejects a write through a symlink that leaves the root folder", async () => {
    const { dir, base } = repository()
    // Git stores the change at the symlink target, not at the link path.
    write(dir, "docs/context/escape/app.ts", "export const y = 2\n")
    const head = commit(dir)
    await expect(
      gitChangesOutsideWorkspaceRoot({
        directory: dir,
        base,
        head,
        rootPath: "docs/context",
      }),
    ).resolves.toEqual([{ path: "src/app.ts", reason: "outside_root" }])
  })

  it.each([
    ["../../src", "parent"],
    ["/etc/passwd", "absolute"],
    ["../../context-other/a.md", "sibling"],
  ])("rejects a new symlink to %j (%s) below the root folder", async (target) => {
    const { dir, base } = repository()
    symlinkSync(target, join(dir, "docs/context/knowledge/link.md"))
    const head = commit(dir)
    await expect(
      gitChangesOutsideWorkspaceRoot({
        directory: dir,
        base,
        head,
        rootPath: "docs/context",
      }),
    ).resolves.toEqual([
      {
        path: "docs/context/knowledge/link.md",
        reason: "symlink_outside_root",
      },
    ])
  })

  it("rejects a symlink that leaves the repository when the root is the repository root", async () => {
    const { dir, base } = repository()
    symlinkSync("../../../etc", join(dir, "docs/link"))
    write(dir, "src/app.ts", "export const z = 3\n")
    const head = commit(dir)
    await expect(
      gitChangesOutsideWorkspaceRoot({
        directory: dir,
        base,
        head,
        rootPath: "",
      }),
    ).resolves.toEqual([{ path: "docs/link", reason: "symlink_outside_root" }])
  })

  it("rejects a file outside the root folder that a later commit removes", async () => {
    const { dir, base } = repository()
    write(dir, "src/leak.ts", "export const secret = 1\n")
    commit(dir)
    git(dir, ["rm", "-q", "src/leak.ts"])
    write(dir, "docs/context/knowledge/b.md", "# B\n")
    const head = commit(dir)
    await expect(
      gitChangesOutsideWorkspaceRoot({
        directory: dir,
        base,
        head,
        rootPath: "docs/context",
      }),
    ).resolves.toEqual([{ path: "src/leak.ts", reason: "outside_root" }])
  })

  it("rejects a commit without a parent that drops the files outside the root folder", async () => {
    const { dir, base } = repository()
    git(dir, ["checkout", "-q", "--orphan", "rooted"])
    git(dir, ["rm", "-q", "-r", "--cached", "."])
    git(dir, ["add", "docs/context/knowledge/a.md"])
    git(dir, ["commit", "-q", "-m", "only the root"])
    const head = git(dir, ["rev-parse", "HEAD"])
    await expect(
      gitChangesOutsideWorkspaceRoot({
        directory: dir,
        base,
        head,
        rootPath: "docs/context",
      }),
    ).resolves.toContainEqual({ path: "src/app.ts", reason: "outside_root" })
  })

  it("rejects a file outside the root folder in a merged commit without a parent", async () => {
    const { dir, base } = repository()
    git(dir, ["checkout", "-q", "--orphan", "other"])
    git(dir, ["rm", "-q", "-r", "--cached", "."])
    write(dir, "src/leak.ts", "export const secret = 1\n")
    git(dir, ["add", "src/leak.ts"])
    git(dir, ["commit", "-q", "-m", "orphan"])
    git(dir, ["checkout", "-q", "-f", "main"])
    git(dir, [
      "merge",
      "-q",
      "-s",
      "ours",
      "--allow-unrelated-histories",
      "-m",
      "merge",
      "other",
    ])
    const head = git(dir, ["rev-parse", "HEAD"])
    await expect(
      gitChangesOutsideWorkspaceRoot({
        directory: dir,
        base,
        head,
        rootPath: "docs/context",
      }),
    ).resolves.toEqual([{ path: "src/leak.ts", reason: "outside_root" }])
  })

  it("rejects a submodule below the root folder that a later commit removes", async () => {
    const { dir, base } = repository()
    git(dir, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${base},docs/context/vendor`,
    ])
    git(dir, ["commit", "-q", "-m", "submodule"])
    git(dir, ["rm", "-q", "--cached", "docs/context/vendor"])
    git(dir, ["commit", "-q", "-m", "remove"])
    const head = git(dir, ["rev-parse", "HEAD"])
    await expect(
      gitChangesOutsideWorkspaceRoot({
        directory: dir,
        base,
        head,
        rootPath: "docs/context",
      }),
    ).resolves.toEqual([{ path: "docs/context/vendor", reason: "submodule" }])
  })

  it("rejects a new submodule below the root folder", async () => {
    const { dir, base } = repository()
    git(dir, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${base},docs/context/vendor`,
    ])
    git(dir, ["commit", "-q", "-m", "submodule"])
    const head = git(dir, ["rev-parse", "HEAD"])
    await expect(
      gitChangesOutsideWorkspaceRoot({
        directory: dir,
        base,
        head,
        rootPath: "docs/context",
      }),
    ).resolves.toEqual([{ path: "docs/context/vendor", reason: "submodule" }])
  })
})

describe("workspaceRootPath", () => {
  it("reads the stored root folder, and the repository root when there is none", () => {
    expect(workspaceRootPath({ rootPath: "docs/context" })).toBe("docs/context")
    expect(workspaceRootPath({ rootPath: "" })).toBe("")
    expect(workspaceRootPath({})).toBe("")
    expect(workspaceRootPath(null)).toBe("")
  })

  it("refuses a stored value that is not valid", () => {
    expect(() => workspaceRootPath({ rootPath: "../src" })).toThrow()
  })
})
