import { lstat, mkdir, mkdtemp, readdir, readlink, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../config/paths.js", () => ({
  REPO_CACHE_DIR: "",
  ZOEKT_INDEX_DIR: "",
  ZOEKT_HOT_DIR: "",
}))

import * as paths from "../../config/paths.js"
import { pinRepos, resetPinManagerForTests } from "../zoekt/pinManager.js"
import { zoektShardFilePrefix } from "../zoekt/shardPrefix.js"
import { purgeRepositoryFromDisk } from "./purge.js"

let tmpDir: string
let repoCacheDir: string
let zoektIndexDir: string
let zoektHotDir: string

beforeEach(async () => {
  resetPinManagerForTests()
  tmpDir = await mkdtemp(join(tmpdir(), "purge-test-"))
  repoCacheDir = join(tmpDir, "repo-cache")
  zoektIndexDir = join(tmpDir, "zoekt-index")
  zoektHotDir = join(tmpDir, "zoekt-hot")
  await mkdir(repoCacheDir, { recursive: true })
  await mkdir(zoektIndexDir, { recursive: true })
  await mkdir(zoektHotDir, { recursive: true })
  Object.defineProperty(paths, "REPO_CACHE_DIR", {
    value: repoCacheDir,
    writable: true,
  })
  Object.defineProperty(paths, "ZOEKT_INDEX_DIR", {
    value: zoektIndexDir,
    writable: true,
  })
  Object.defineProperty(paths, "ZOEKT_HOT_DIR", {
    value: zoektHotDir,
    writable: true,
  })
})

afterEach(async () => {
  resetPinManagerForTests()
  await rm(tmpDir, { recursive: true, force: true })
})

describe("purgeRepositoryFromDisk", () => {
  it("removes the repo clone directory", async () => {
    const repoDir = join(repoCacheDir, "org_1", "repo_abc")
    await mkdir(repoDir, { recursive: true })
    await writeFile(join(repoDir, "HEAD"), "ref: refs/heads/main")

    await purgeRepositoryFromDisk({
      orgId: "org_1",
      repoId: "repo_abc",
      repoName: "owner/repo",
      zoektRepoId: 42,
    })

    const entries = await readdir(join(repoCacheDir, "org_1"))
    expect(entries).not.toContain("repo_abc")
  })

  it("deletes shards matching the zoekt QueryEscape repo name prefix", async () => {
    await writeFile(join(zoektIndexDir, "owner%2Frepo_v16.00000.zoekt"), "")
    await writeFile(join(zoektIndexDir, "owner%2Frepo_v16.00001.zoekt"), "")
    await writeFile(join(zoektIndexDir, "other%2Frepo_v16.00000.zoekt"), "")

    await purgeRepositoryFromDisk({
      orgId: "org_1",
      repoId: "repo_abc",
      repoName: "owner/repo",
      zoektRepoId: 42,
    })

    const remaining = await readdir(zoektIndexDir)
    expect(remaining).toEqual(["other%2Frepo_v16.00000.zoekt"])
  })

  it("does not false-match shards with similar prefixes", async () => {
    await writeFile(
      join(zoektIndexDir, "owner%2Frepo-fork_v16.00000.zoekt"),
      "",
    )
    await writeFile(join(zoektIndexDir, "owner%2Frepo_v16.00000.zoekt"), "")

    await purgeRepositoryFromDisk({
      orgId: "org_1",
      repoId: "repo_abc",
      repoName: "owner/repo",
      zoektRepoId: 42,
    })

    const remaining = await readdir(zoektIndexDir)
    expect(remaining).toEqual(["owner%2Frepo-fork_v16.00000.zoekt"])
  })

  it("handles missing zoekt index directory gracefully", async () => {
    await rm(zoektIndexDir, { recursive: true, force: true })

    await expect(
      purgeRepositoryFromDisk({
        orgId: "org_1",
        repoId: "repo_abc",
        repoName: "owner/repo",
        zoektRepoId: 42,
      }),
    ).resolves.toBeUndefined()
  })

  it("removes hot symlinks and pin state for the repo", async () => {
    const repoName = "owner/repo"
    const basename = `${zoektShardFilePrefix(repoName)}v16.00000.zoekt`
    await writeFile(join(zoektIndexDir, basename), "cold")
    await pinRepos([{ zoektRepoId: 42, repoName }], {
      coldDir: zoektIndexDir,
      hotDir: zoektHotDir,
      idleTtlMs: 60_000,
    })
    expect(await readlink(join(zoektHotDir, basename))).toBe(
      join(zoektIndexDir, basename),
    )

    await purgeRepositoryFromDisk({
      orgId: "org_1",
      repoId: "repo_abc",
      repoName,
      zoektRepoId: 42,
    })

    await expect(lstat(join(zoektHotDir, basename))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(lstat(join(zoektIndexDir, basename))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})
