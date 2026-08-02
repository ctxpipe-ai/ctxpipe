import { lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  isRepoPinned,
  pinRepos,
  resetPinManagerForTests,
  unpinRepo,
} from "./pinManager.js"
import { zoektShardFilePrefix } from "./shardPrefix.js"

let tmpDir: string
let coldDir: string
let hotDir: string

beforeEach(async () => {
  resetPinManagerForTests()
  tmpDir = await mkdtemp(join(tmpdir(), "pin-manager-"))
  coldDir = join(tmpDir, "zoekt-index")
  hotDir = join(tmpDir, "zoekt-hot")
  await mkdir(coldDir, { recursive: true })
  await mkdir(hotDir, { recursive: true })
})

afterEach(async () => {
  resetPinManagerForTests()
  vi.useRealTimers()
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeColdShard(repoName: string, shardNum = 0): Promise<string> {
  const basename = `${zoektShardFilePrefix(repoName)}v16.${String(shardNum).padStart(5, "0")}.zoekt`
  const path = join(coldDir, basename)
  await writeFile(path, `shard-${shardNum}`)
  return basename
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error("waitFor timed out")
}

describe("pinRepos", () => {
  it("creates hot symlinks to cold shards", async () => {
    const repoName = "owner/repo"
    const basename = await writeColdShard(repoName)
    await writeFile(join(coldDir, `${basename}.meta`), "meta")

    await pinRepos([{ zoektRepoId: 7, repoName }], {
      coldDir,
      hotDir,
      idleTtlMs: 60_000,
    })

    expect(await readlink(join(hotDir, basename))).toBe(join(coldDir, basename))
    expect(await readlink(join(hotDir, `${basename}.meta`))).toBe(
      join(coldDir, `${basename}.meta`),
    )
    expect(isRepoPinned(7)).toBe(true)
  })

  it("resets idle TTL on a second pin so unload is deferred", async () => {
    const repoName = "owner/repo"
    const basename = await writeColdShard(repoName)

    await pinRepos([{ zoektRepoId: 1, repoName }], {
      coldDir,
      hotDir,
      idleTtlMs: 120,
    })

    await new Promise((r) => setTimeout(r, 70))
    await pinRepos([{ zoektRepoId: 1, repoName }], {
      coldDir,
      hotDir,
      idleTtlMs: 120,
    })
    await new Promise((r) => setTimeout(r, 70))

    // Still pinned: second pin deferred unload past the first TTL
    expect((await lstat(join(hotDir, basename))).isSymbolicLink()).toBe(true)
    expect(isRepoPinned(1)).toBe(true)

    await waitFor(async () => {
      try {
        await lstat(join(hotDir, basename))
        return false
      } catch {
        return !isRepoPinned(1)
      }
    })

    await expect(lstat(join(hotDir, basename))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("unloads hot symlinks after idle TTL", async () => {
    const repoName = "owner/repo"
    const basename = await writeColdShard(repoName)

    await pinRepos([{ zoektRepoId: 2, repoName }], {
      coldDir,
      hotDir,
      idleTtlMs: 80,
    })

    await waitFor(async () => {
      try {
        await lstat(join(hotDir, basename))
        return false
      } catch {
        return !isRepoPinned(2)
      }
    })

    await expect(lstat(join(hotDir, basename))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(lstat(join(coldDir, basename))).resolves.toBeTruthy()
  })
})

describe("unpinRepo", () => {
  it("removes hot symlinks immediately", async () => {
    const repoName = "owner/repo"
    const basename = await writeColdShard(repoName)
    await pinRepos([{ zoektRepoId: 3, repoName }], {
      coldDir,
      hotDir,
      idleTtlMs: 60_000,
    })

    await unpinRepo({ zoektRepoId: 3, repoName }, { coldDir, hotDir })

    await expect(lstat(join(hotDir, basename))).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(isRepoPinned(3)).toBe(false)
  })
})
