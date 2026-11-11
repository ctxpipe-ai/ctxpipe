import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  installStagedShards,
  isRepoPinned,
  markShardsUploaded,
  pinRepos,
  resetPinManagerForTests,
  unpinRepo,
} from "./pinManager.js"
import { zoektRepositoryName, zoektShardFilePrefix } from "./shardPrefix.js"

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

function testZoektName(repoId = "repo_main", orgId = "org_alpha"): string {
  return zoektRepositoryName({ orgId, repoId })
}

async function writeColdShard(
  zoektName: string,
  shardNum = 0,
): Promise<string> {
  const basename = `${zoektShardFilePrefix(zoektName)}v16.${String(shardNum).padStart(5, "0")}.zoekt`
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
    const zoektName = testZoektName()
    const basename = await writeColdShard(zoektName)
    await writeFile(join(coldDir, `${basename}.meta`), "meta")

    await pinRepos([{ zoektRepoId: 7, zoektName }], {
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
    const zoektName = testZoektName()
    const basename = await writeColdShard(zoektName)

    await pinRepos([{ zoektRepoId: 1, zoektName }], {
      coldDir,
      hotDir,
      idleTtlMs: 120,
    })

    await new Promise((r) => setTimeout(r, 70))
    await pinRepos([{ zoektRepoId: 1, zoektName }], {
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
    const zoektName = testZoektName()
    const basename = await writeColdShard(zoektName)

    await pinRepos([{ zoektRepoId: 2, zoektName }], {
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
    const zoektName = testZoektName()
    const basename = await writeColdShard(zoektName)
    await pinRepos([{ zoektRepoId: 3, zoektName }], {
      coldDir,
      hotDir,
      idleTtlMs: 60_000,
    })

    await unpinRepo({ zoektRepoId: 3, zoektName }, { coldDir, hotDir })

    await expect(lstat(join(hotDir, basename))).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(isRepoPinned(3)).toBe(false)
  })
})

describe("pinRepos safety", () => {
  it("pins same-name repositories independently across orgs", async () => {
    const orgAlphaName = testZoektName("repo_same", "org_alpha")
    const orgBetaName = testZoektName("repo_same", "org_beta")
    const alphaShard = await writeColdShard(orgAlphaName)
    const betaShard = await writeColdShard(orgBetaName)

    await pinRepos([{ zoektRepoId: 11, zoektName: orgAlphaName }], {
      coldDir,
      hotDir,
      idleTtlMs: 60_000,
    })

    expect(await readlink(join(hotDir, alphaShard))).toBe(
      join(coldDir, alphaShard),
    )
    await expect(lstat(join(hotDir, betaShard))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("does not pin adjacent repo ids that share a prefix", async () => {
    const fooName = testZoektName("repo_foo")
    const fooBarName = testZoektName("repo_foo_bar")
    const fooShard = await writeColdShard(fooName)
    const fooBarShard = await writeColdShard(fooBarName)

    await pinRepos([{ zoektRepoId: 12, zoektName: fooName }], {
      coldDir,
      hotDir,
      idleTtlMs: 60_000,
    })

    expect(await readlink(join(hotDir, fooShard))).toBe(join(coldDir, fooShard))
    await expect(lstat(join(hotDir, fooBarShard))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("refuses to replace a regular file in the hot dir", async () => {
    const zoektName = testZoektName()
    const basename = await writeColdShard(zoektName)
    await writeFile(join(hotDir, basename), "not-a-symlink")

    await expect(
      pinRepos([{ zoektRepoId: 4, zoektName }], {
        coldDir,
        hotDir,
        idleTtlMs: 60_000,
      }),
    ).rejects.toThrow(/not a symlink/)
  })

  it("keeps shards when concurrent pins race on the same repo", async () => {
    const zoektName = testZoektName()
    const basename = await writeColdShard(zoektName)

    await Promise.all([
      pinRepos([{ zoektRepoId: 5, zoektName }], {
        coldDir,
        hotDir,
        idleTtlMs: 60_000,
      }),
      pinRepos([{ zoektRepoId: 5, zoektName }], {
        coldDir,
        hotDir,
        idleTtlMs: 60_000,
      }),
      pinRepos([{ zoektRepoId: 5, zoektName }], {
        coldDir,
        hotDir,
        idleTtlMs: 60_000,
      }),
    ])

    expect(await readlink(join(hotDir, basename))).toBe(join(coldDir, basename))
    expect(isRepoPinned(5)).toBe(true)
  })

  it("does not unload after a re-pin that races an expiring TTL", async () => {
    const zoektName = testZoektName()
    const basename = await writeColdShard(zoektName)

    await pinRepos([{ zoektRepoId: 6, zoektName }], {
      coldDir,
      hotDir,
      idleTtlMs: 80,
    })

    await new Promise((r) => setTimeout(r, 60))
    await pinRepos([{ zoektRepoId: 6, zoektName }], {
      coldDir,
      hotDir,
      idleTtlMs: 200,
    })

    await new Promise((r) => setTimeout(r, 80))
    expect((await lstat(join(hotDir, basename))).isSymbolicLink()).toBe(true)
    expect(isRepoPinned(6)).toBe(true)
  })
})

async function writeStagedShard(
  stagingDir: string,
  zoektName: string,
  shardNum: number,
  content: string,
): Promise<string> {
  const basename = `${zoektShardFilePrefix(zoektName)}v16.${String(shardNum).padStart(5, "0")}.zoekt`
  await mkdir(stagingDir, { recursive: true })
  await writeFile(join(stagingDir, basename), content)
  return basename
}

describe("installStagedShards", () => {
  it("moves staged shards into cold, deletes older shards of the name, and refreshes a pin", async () => {
    const zoektName = testZoektName()
    const other = await writeColdShard(testZoektName("repo_other"), 0)
    const first = await writeColdShard(zoektName, 0)
    const stale = await writeColdShard(zoektName, 1)
    await pinRepos([{ zoektRepoId: 8, zoektName }], {
      coldDir,
      hotDir,
      idleTtlMs: 60_000,
    })
    const stagingDir = join(coldDir, ".build", "a")
    await writeStagedShard(stagingDir, zoektName, 0, "new-0")

    const paths = await installStagedShards(
      { zoektRepoId: 8, zoektName },
      stagingDir,
      { coldDir, hotDir, idleTtlMs: 60_000 },
    )

    expect(paths).toEqual([join(coldDir, first)])
    expect(await readFile(join(coldDir, first), "utf8")).toBe("new-0")
    await expect(lstat(join(coldDir, stale))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(lstat(join(hotDir, stale))).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(await readlink(join(hotDir, first))).toBe(join(coldDir, first))
    expect(await readFile(join(coldDir, other), "utf8")).toBe("shard-0")
  })

  it("does not pin a repo that is not pinned", async () => {
    const zoektName = testZoektName()
    const stagingDir = join(coldDir, ".build", "b")
    const basename = await writeStagedShard(stagingDir, zoektName, 0, "x")

    await installStagedShards({ zoektRepoId: 9, zoektName }, stagingDir, {
      coldDir,
      hotDir,
    })

    expect(isRepoPinned(9)).toBe(false)
    await expect(lstat(join(hotDir, basename))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("deletes the local manifest copy that markShardsUploaded wrote", async () => {
    const zoektName = testZoektName()
    const repo = { zoektRepoId: 11, zoektName }
    const basename = await writeColdShard(zoektName, 0)
    const manifest = {
      gen: "g1",
      files: [{ name: basename, size: 7, sha256: "0".repeat(64) }],
    }
    const copy = join(
      coldDir,
      ".store",
      `${encodeURIComponent(zoektName)}.json`,
    )

    expect(await markShardsUploaded(repo, manifest, { coldDir })).toBe(true)
    expect(JSON.parse(await readFile(copy, "utf8"))).toEqual(manifest)

    const stagingDir = join(coldDir, ".build", "c")
    await writeStagedShard(stagingDir, zoektName, 0, "next")
    await installStagedShards(repo, stagingDir, { coldDir, hotDir })
    await expect(lstat(copy)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("markShardsUploaded writes no copy when the cold shards differ from the manifest", async () => {
    const zoektName = testZoektName()
    await writeColdShard(zoektName, 0)
    await writeColdShard(zoektName, 1)

    const marked = await markShardsUploaded(
      { zoektName },
      { gen: "g1", files: [] },
      { coldDir },
    )

    expect(marked).toBe(false)
    await expect(lstat(join(coldDir, ".store"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})
