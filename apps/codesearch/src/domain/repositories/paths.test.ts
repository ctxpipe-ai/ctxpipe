import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  resolveSafePath,
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

describe("paths inside .git", () => {
  let tmpDir: string
  let checkout: string

  beforeEach(async () => {
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "git-dir-path-")))
    checkout = join(tmpDir, "checkout")
    await mkdir(join(checkout, ".git"), { recursive: true })
    await writeFile(join(checkout, ".git", "config"), "[core]\n")
    await mkdir(join(checkout, "sub", ".git"), { recursive: true })
    await writeFile(join(checkout, "sub", ".git", "config"), "[core]\n")
    await mkdir(join(checkout, ".github"), { recursive: true })
    await writeFile(join(checkout, ".github", "ci.yml"), "on: push\n")
    await writeFile(join(checkout, ".gitignore"), "dist\n")
    await symlink(".git", join(checkout, "git-dir"))
    await symlink(".git/config", join(checkout, "config-link"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it.each([
    ".git",
    ".git/config",
    ".GIT/config",
    "sub/.git/config",
    "sub/../.git/config",
  ])("resolveSafePath answers %s like a missing path", (path) => {
    expect(() => resolveSafePath(checkout, path)).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    )
  })

  it.each([
    ".git/config",
    ".GIT/config",
    "sub/.git/config",
    "sub/../.git/config",
    "config-link",
    "git-dir/config",
  ])("resolveSafeReadableFilePath answers %s like a missing path", async (path) => {
    await expect(
      resolveSafeReadableFilePath(checkout, path),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("still reads .github and .gitignore", async () => {
    expect(await resolveSafeReadableFilePath(checkout, ".github/ci.yml")).toBe(
      join(checkout, ".github", "ci.yml"),
    )
    expect(await resolveSafeReadableFilePath(checkout, ".gitignore")).toBe(
      join(checkout, ".gitignore"),
    )
  })
})
