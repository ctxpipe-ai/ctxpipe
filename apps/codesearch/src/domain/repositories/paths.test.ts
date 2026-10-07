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

  it("reads a file inside through a symlink and refuses one outside", async () => {
    expect((await readContainedFile(checkout, "in-link")).toString()).toBe(
      "inside\n",
    )
    await expect(readContainedFile(checkout, "chain-a")).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(readContainedFile(checkout, "sub")).rejects.toThrow()
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
