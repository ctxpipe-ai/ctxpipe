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
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  readContainedFile,
  resolveContainedRealPath,
  resolveSafeReadableFilePath,
  scipIndexPath,
  scipLangShardPath,
} from "./paths.js"

describe("SCIP repository paths", () => {
  it("places the merged index beside the default checkout", () => {
    expect(scipIndexPath("org_1", "repo_1")).toMatch(
      /\/org_1\/repo_1\/checkouts\/default\.scip$/,
    )
  })

  it("places language shards beside a named checkout", () => {
    expect(
      scipLangShardPath("org_1", "repo_1", "typescript", "checkout_1"),
    ).toMatch(/\/org_1\/repo_1\/checkouts\/checkout_1\.typescript\.scip$/)
  })
})

describe("paths inside the checkout", () => {
  let tmpDir: string
  let checkout: string

  beforeEach(async () => {
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "contained-path-")))
    checkout = join(tmpDir, "checkout")
    const outside = join(tmpDir, "outside")
    await mkdir(join(outside, "dir"), { recursive: true })
    await writeFile(join(outside, "data.txt"), "outside\n")
    await writeFile(join(outside, "dir", "inner.txt"), "outside\n")
    await mkdir(join(checkout, "sub"), { recursive: true })
    await writeFile(join(checkout, "inside.txt"), "inside\n")
    await writeFile(join(checkout, "sub", "inner.txt"), "inside\n")
    await symlink(join(outside, "data.txt"), join(checkout, "abs-link"))
    await symlink(
      relative(join(checkout, "sub"), join(outside, "data.txt")),
      join(checkout, "sub", "rel-link"),
    )
    await symlink(join(outside, "dir"), join(checkout, "out-dir"))
    await symlink("chain-b", join(checkout, "chain-a"))
    await symlink(join(outside, "data.txt"), join(checkout, "chain-b"))
    await symlink("inside.txt", join(checkout, "in-link"))
    await symlink("sub", join(checkout, "in-dir"))
    await symlink("missing.txt", join(checkout, "dangling"))
    await mkdir(join(checkout, ".git"))
    await writeFile(
      join(checkout, ".git", "config"),
      'url = "https://x-access-token:secret@example.com/repo.git"\n',
    )
    await mkdir(join(checkout, "sub", ".git"))
    await writeFile(join(checkout, "sub", ".git", "config"), "nested\n")
    await symlink(".git/config", join(checkout, "leak"))
    await symlink(".git", join(checkout, "git-dir"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it.each([
    ["an absolute symlink", "abs-link"],
    ["a relative symlink that climbs out", "sub/rel-link"],
    ["a symlinked parent directory", "out-dir/inner.txt"],
    ["a symlinked directory", "out-dir"],
    ["a chain of symlinks", "chain-a"],
    ["a dangling symlink", "dangling"],
    ["a missing path", "missing.txt"],
  ])("refuses %s that ends outside, like a missing path", async (_, path) => {
    await expect(
      resolveContainedRealPath(checkout, path),
    ).rejects.toMatchObject({ code: "ENOENT" })
    await expect(
      resolveSafeReadableFilePath(checkout, path),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("reads a file inside through a symlink and refuses a directory", async () => {
    expect((await readContainedFile(checkout, "in-link")).toString()).toBe(
      "inside\n",
    )
    expect(
      (await readContainedFile(checkout, "in-dir/inner.txt")).toString(),
    ).toBe("inside\n")
    await expect(readContainedFile(checkout, "sub")).rejects.toThrow()
  })

  // The tree never lists .git, and .git/config can hold a clone token.
  it.each([
    ["a symlink to .git/config", "leak"],
    ["a file under a symlink to .git", "git-dir/config"],
    ["a chain of symlinks that ends outside", "chain-a"],
    ["an absolute symlink to a file outside", "abs-link"],
    ["the .git/config file", ".git/config"],
    ["a file under a nested .git directory", "sub/.git/config"],
  ])("refuses to read %s", async (_, path) => {
    await expect(readContainedFile(checkout, path)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it.each([
    ["the .git directory", ".git"],
    ["the .git/config file", ".git/config"],
    ["a .git segment in upper case", ".GIT/config"],
    ["a symlink to .git", "git-dir"],
    ["a symlink to .git/config", "leak"],
    ["a nested .git directory", "sub/.git"],
    ["a path that climbs back into .git", "sub/../.git/config"],
  ])("does not resolve %s, like a missing path", async (_, path) => {
    await expect(
      resolveContainedRealPath(checkout, path),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("follows a symlink to a file inside", async () => {
    expect(await resolveSafeReadableFilePath(checkout, "in-link")).toBe(
      join(checkout, "inside.txt"),
    )
  })

  it("follows a symlinked directory inside", async () => {
    expect(await resolveContainedRealPath(checkout, "in-dir")).toBe(
      join(checkout, "sub"),
    )
    expect(
      await resolveSafeReadableFilePath(checkout, "in-dir/inner.txt"),
    ).toBe(join(checkout, "sub", "inner.txt"))
  })

  it("resolves the checkout root itself", async () => {
    expect(await resolveContainedRealPath(checkout, ".")).toBe(checkout)
  })

  it("rejects path text that climbs out", async () => {
    await expect(
      resolveContainedRealPath(checkout, "../outside/data.txt"),
    ).rejects.toThrow("Path traversal is not allowed")
  })
})
