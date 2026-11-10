import {
  lstat,
  mkdir,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

// config/paths.js reads these variables when it loads.
const { root } = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const root = realpathSync(mkdtempSync(join(tmpdir(), "purge-test-")))
  vi.stubEnv("REPO_CACHE_DIR", join(root, "repo-cache"))
  vi.stubEnv("ZOEKT_INDEX_DIR", join(root, "zoekt-index"))
  return { root }
})

import { pinRepos, resetPinManagerForTests } from "../zoekt/pinManager.js"
import {
  zoektRepositoryName,
  zoektShardFilePrefix,
} from "../zoekt/shardPrefix.js"
import { purgeRepositoryFromDisk } from "./purge.js"

const repoCacheDir = join(root, "repo-cache")
const zoektIndexDir = join(root, "zoekt-index")
const zoektHotDir = join(root, "zoekt-hot")

function zoektName(orgId = "org_1", repoId = "repo_abc"): string {
  return zoektRepositoryName({ orgId, repoId })
}

beforeEach(async () => {
  resetPinManagerForTests()
  for (const dir of [repoCacheDir, zoektIndexDir, zoektHotDir]) {
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
  }
})

afterEach(() => {
  resetPinManagerForTests()
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
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

  it("deletes shards matching the stable Zoekt identity", async () => {
    const targetPrefix = zoektShardFilePrefix(zoektName())
    const otherPrefix = zoektShardFilePrefix(zoektName("org_2", "repo_abc"))
    await writeFile(join(zoektIndexDir, `${targetPrefix}v16.00000.zoekt`), "")
    await writeFile(join(zoektIndexDir, `${targetPrefix}v16.00001.zoekt`), "")
    await writeFile(join(zoektIndexDir, `${otherPrefix}v16.00000.zoekt`), "")

    await purgeRepositoryFromDisk({
      orgId: "org_1",
      repoId: "repo_abc",
      repoName: "owner/repo",
      zoektRepoId: 42,
    })

    const remaining = await readdir(zoektIndexDir)
    expect(remaining).toEqual([`${otherPrefix}v16.00000.zoekt`])
  })

  it("does not false-match shards with adjacent repository ids", async () => {
    const targetPrefix = zoektShardFilePrefix(zoektName("org_1", "repo_foo"))
    const adjacentPrefix = zoektShardFilePrefix(
      zoektName("org_1", "repo_foo_bar"),
    )
    await writeFile(join(zoektIndexDir, `${adjacentPrefix}v16.00000.zoekt`), "")
    await writeFile(join(zoektIndexDir, `${targetPrefix}v16.00000.zoekt`), "")

    await purgeRepositoryFromDisk({
      orgId: "org_1",
      repoId: "repo_foo",
      repoName: "owner/repo",
      zoektRepoId: 42,
    })

    const remaining = await readdir(zoektIndexDir)
    expect(remaining).toEqual([`${adjacentPrefix}v16.00000.zoekt`])
  })

  it("leaves legacy display-name shards untouched to fail closed", async () => {
    await writeFile(join(zoektIndexDir, "owner%2Frepo_v16.00000.zoekt"), "")

    await purgeRepositoryFromDisk({
      orgId: "org_1",
      repoId: "repo_abc",
      repoName: "owner/repo",
      zoektRepoId: 42,
    })

    const remaining = await readdir(zoektIndexDir)
    expect(remaining).toEqual(["owner%2Frepo_v16.00000.zoekt"])
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
    const basename = `${zoektShardFilePrefix(zoektName())}v16.00000.zoekt`
    await writeFile(join(zoektIndexDir, basename), "cold")
    await pinRepos([{ zoektRepoId: 42, zoektName: zoektName() }], {
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
