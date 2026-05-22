import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../config/paths.js", () => ({
  REPO_CACHE_DIR: "",
  ZOEKT_INDEX_DIR: "",
}))

import * as paths from "../../config/paths.js"
import { purgeRepositoryFromDisk } from "./purge.js"

let tmpDir: string
let repoCacheDir: string
let zoektIndexDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "purge-test-"))
  repoCacheDir = join(tmpDir, "repo-cache")
  zoektIndexDir = join(tmpDir, "zoekt-index")
  await mkdir(repoCacheDir, { recursive: true })
  await mkdir(zoektIndexDir, { recursive: true })
  Object.defineProperty(paths, "REPO_CACHE_DIR", {
    value: repoCacheDir,
    writable: true,
  })
  Object.defineProperty(paths, "ZOEKT_INDEX_DIR", {
    value: zoektIndexDir,
    writable: true,
  })
})

afterEach(async () => {
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

  it("deletes shards matching the repo name prefix", async () => {
    await writeFile(join(zoektIndexDir, "owner_repo_v16.00000.zoekt"), "")
    await writeFile(join(zoektIndexDir, "owner_repo_v16.00001.zoekt"), "")
    await writeFile(join(zoektIndexDir, "other_repo_v16.00000.zoekt"), "")

    await purgeRepositoryFromDisk({
      orgId: "org_1",
      repoId: "repo_abc",
      repoName: "owner/repo",
      zoektRepoId: 42,
    })

    const remaining = await readdir(zoektIndexDir)
    expect(remaining).toEqual(["other_repo_v16.00000.zoekt"])
  })

  it("does not false-match shards with similar prefixes", async () => {
    await writeFile(join(zoektIndexDir, "owner_repo-fork_v16.00000.zoekt"), "")
    await writeFile(join(zoektIndexDir, "owner_repo_v16.00000.zoekt"), "")

    await purgeRepositoryFromDisk({
      orgId: "org_1",
      repoId: "repo_abc",
      repoName: "owner/repo",
      zoektRepoId: 42,
    })

    const remaining = await readdir(zoektIndexDir)
    expect(remaining).toEqual(["owner_repo-fork_v16.00000.zoekt"])
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
})
