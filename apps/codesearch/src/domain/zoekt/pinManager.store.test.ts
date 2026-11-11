import { type ChildProcess, execFile, spawn } from "node:child_process"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { PutObjectCommand } from "@aws-sdk/client-s3"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import {
  zoektStagingDirFromIndexDir,
  zoektStoreDirFromIndexDir,
} from "../../config/paths.js"
import { startS3Server } from "../../test/s3Server.js"
import {
  publishArtifact,
  shardStore,
  type StoreAddress,
} from "../store/shardStore.js"
import {
  evictColdShards,
  installStagedShards,
  localManifestPath,
  markShardsUploaded,
  pinRepos,
  resetPinManagerForTests,
} from "./pinManager.js"
import { zoektRepositoryName, zoektShardFilePrefix } from "./shardPrefix.js"
import { listLoadedZoektRepoIds, waitUntilZoektReposLoaded } from "./warmup.js"

/*
 * Fetch on pin and LRU eviction with the real zoekt-index, the real
 * zoekt-webserver, and a real S3-compatible server.
 */

const exec = promisify(execFile)
const ORG = "org_fetch"
let server: Awaited<ReturnType<typeof startS3Server>>
let root: string
let coldDir: string
let hotDir: string
let srcDir: string

beforeAll(async () => {
  server = await startS3Server()
})

afterAll(async () => {
  await server?.stop()
})

beforeEach(async () => {
  resetPinManagerForTests()
  root = await mkdtemp(join(tmpdir(), "pin-store-"))
  coldDir = join(root, "zoekt-index")
  hotDir = join(root, "zoekt-hot")
  srcDir = join(root, "src")
  await mkdir(coldDir, { recursive: true })
  await mkdir(hotDir, { recursive: true })
  await mkdir(srcDir, { recursive: true })
  await writeFile(join(srcDir, "a.txt"), "hello needle world\n")
  server.stubEnv("prod")
})

afterEach(async () => {
  resetPinManagerForTests()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

function repoOf(repoId: string, zoektRepoId: number) {
  const identity = { orgId: ORG, repoId, checkoutKey: "default" }
  const address: StoreAddress = { ...identity, kind: "zoekt" }
  return {
    address,
    repo: { zoektRepoId, zoektName: zoektRepositoryName(identity) },
  }
}

/** Indexes `srcDir` with the real zoekt-index, installs and uploads it. */
async function indexAndPublish(repoId: string, zoektRepoId: number) {
  const { address, repo } = repoOf(repoId, zoektRepoId)
  const stagingDir = join(zoektStagingDirFromIndexDir(coldDir), repoId)
  const metaPath = join(root, `${repoId}.meta.json`)
  await writeFile(
    metaPath,
    JSON.stringify({
      ID: zoektRepoId,
      Name: repo.zoektName,
      URL: "https://example.com/owner/repo",
      Source: srcDir,
    }),
  )
  await exec("zoekt-index", ["-index", stagingDir, "-meta", metaPath, srcDir])
  const paths = await installStagedShards(repo, stagingDir, {
    coldDir,
    hotDir,
  })
  const store = shardStore()
  if (!store) throw new Error("shard store is not set")
  const manifest = await publishArtifact(store, address, paths)
  expect(await markShardsUploaded(repo, manifest, { coldDir })).toBe(true)
  return { address, repo, manifest }
}

/** Writes an object through the S3 API, as another writer of the bucket would. */
async function putObject(key: string, body: string) {
  const store = shardStore()
  if (!store) throw new Error("shard store is not set")
  await store.client.send(
    new PutObjectCommand({ Bucket: server.bucket, Key: key, Body: body }),
  )
}

const coldShards = async (zoektName: string) =>
  (await readdir(coldDir)).filter((name) =>
    name.startsWith(zoektShardFilePrefix(zoektName)),
  )
const localCopy = (zoektName: string) => localManifestPath(coldDir, zoektName)
const emptyCold = async () => {
  for (const name of await readdir(coldDir))
    await rm(join(coldDir, name), { recursive: true, force: true })
}

describe("fetch on pin", () => {
  it("fetches the shards of an empty disk from S3, and the search finds them", async () => {
    const { repo, manifest } = await indexAndPublish("repo_main", 31)
    await emptyCold()

    const port = 19000 + Math.floor(Math.random() * 1000)
    const baseUrl = `http://127.0.0.1:${port}`
    const webserver: ChildProcess = spawn(
      "zoekt-webserver",
      ["-index", hotDir, "-rpc", "-listen", `:${port}`],
      { stdio: "ignore" },
    )
    try {
      const ready = Date.now() + 10_000
      while (!(await listLoadedZoektRepoIds(baseUrl).catch(() => null))) {
        if (Date.now() > ready) throw new Error("zoekt-webserver is not ready")
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      const [result] = await pinRepos([repo], {
        coldDir,
        hotDir,
        idleTtlMs: 60_000,
      })

      expect(result?.shardCount).toBeGreaterThan(0)
      expect((await coldShards(repo.zoektName)).sort()).toEqual(
        manifest.files.map((file) => file.name).sort(),
      )
      expect(
        JSON.parse(await readFile(localCopy(repo.zoektName), "utf8")),
      ).toEqual(manifest)
      expect(await readdir(zoektStagingDirFromIndexDir(coldDir))).toEqual([])
      await waitUntilZoektReposLoaded({
        repoIds: [repo.zoektRepoId],
        baseUrl,
        timeoutMs: 10_000,
        pollIntervalMs: 50,
      })
      const response = await fetch(`${baseUrl}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Q: "needle", RepoIDs: [repo.zoektRepoId] }),
      })
      const body = (await response.json()) as {
        Result?: { MatchCount?: number }
      }
      expect(body.Result?.MatchCount ?? 0).toBeGreaterThan(0)
    } finally {
      webserver.kill("SIGTERM")
    }
  }, 30_000)

  it("pins a name with no S3 manifest with no shards", async () => {
    const { repo } = repoOf("repo_never", 32)

    const [result] = await pinRepos([repo], { coldDir, hotDir })

    expect(result?.shardCount).toBe(0)
  })

  it("fails the pin and leaves no file in cold when a file does not match its checksum", async () => {
    const { repo, manifest } = await indexAndPublish("repo_bad", 33)
    await emptyCold()
    const object = (await server.keys()).find((key) =>
      key.endsWith(`${manifest.gen}/${manifest.files[0]?.name}`),
    )
    if (!object) throw new Error("no uploaded shard")
    await putObject(object, "tampered")

    await expect(pinRepos([repo], { coldDir, hotDir })).rejects.toThrow(
      /does not match the manifest/,
    )

    expect(await coldShards(repo.zoektName)).toEqual([])
    expect(await readdir(zoektStagingDirFromIndexDir(coldDir))).toEqual([])
  })

  it("refuses a manifest that names a file of another name", async () => {
    const { repo } = repoOf("repo_foreign", 34)
    await putObject(
      `prod/v1/${ORG}/repo_foreign/default/zoekt/manifest.json`,
      JSON.stringify({
        gen: "g1",
        files: [
          {
            // A valid shard name of another repository.
            name: `${zoektShardFilePrefix(zoektRepositoryName({ orgId: ORG, repoId: "repo_victim" }))}v16.00000.zoekt`,
            size: 1,
            sha256: "0".repeat(64),
          },
        ],
      }),
    )

    await expect(pinRepos([repo], { coldDir, hotDir })).rejects.toThrow(
      /foreign file/,
    )
  })

  it("ends with the shards of an index that races a fetch, and no local manifest copy", async () => {
    const { repo } = await indexAndPublish("repo_race", 35)
    await emptyCold()
    const stagingDir = join(zoektStagingDirFromIndexDir(coldDir), "race")
    await mkdir(stagingDir, { recursive: true })
    const staged = `${zoektShardFilePrefix(repo.zoektName)}v16.00000.zoekt`
    await writeFile(join(stagingDir, staged), "from the index")

    await Promise.all([
      pinRepos([repo], { coldDir, hotDir, idleTtlMs: 60_000 }),
      installStagedShards(repo, stagingDir, { coldDir, hotDir }),
    ])

    expect(await coldShards(repo.zoektName)).toEqual([staged])
    expect(await readFile(join(coldDir, staged), "utf8")).toBe("from the index")
    await expect(readFile(localCopy(repo.zoektName))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})

describe("evictColdShards", () => {
  /** A cold shard with an optional local manifest copy and last pin time. */
  async function coldName(repoId: string, lastPin: number | null) {
    const zoektName = zoektRepositoryName({ orgId: ORG, repoId })
    await writeFile(
      join(coldDir, `${zoektShardFilePrefix(zoektName)}v16.00000.zoekt`),
      repoId,
    )
    if (lastPin !== null) {
      await mkdir(zoektStoreDirFromIndexDir(coldDir), { recursive: true })
      await writeFile(localCopy(zoektName), "{}")
      const time = new Date(lastPin)
      await utimes(localCopy(zoektName), time, time)
    }
    return zoektName
  }

  it("evicts the least recently pinned names with an S3 copy until enough is free", async () => {
    const oldest = await coldName("repo_oldest", 1_000)
    const older = await coldName("repo_older", 2_000)
    const newest = await coldName("repo_newest", 3_000)
    const dirty = await coldName("repo_dirty", null)
    // Two evictions free enough space.
    let evictions = 0
    const freeRatio = async () => {
      const left = (await readdir(zoektStoreDirFromIndexDir(coldDir))).length
      evictions = 3 - left
      return evictions >= 2 ? 0.5 : 0.1
    }

    expect(await evictColdShards({ coldDir, freeRatio })).toBe(2)

    expect(await coldShards(oldest)).toEqual([])
    expect(await coldShards(older)).toEqual([])
    expect((await coldShards(newest)).length).toBe(1)
    expect((await coldShards(dirty)).length).toBe(1)
  })

  it("never evicts a pinned name or a name without a local manifest copy", async () => {
    const pinned = await coldName("repo_pinned", 1_000)
    const dirty = await coldName("repo_dirty", null)
    await pinRepos([{ zoektRepoId: 41, zoektName: pinned }], {
      coldDir,
      hotDir,
      idleTtlMs: 60_000,
    })
    // The pin made the copy new; make it old, so only the pin keeps the name.
    await utimes(localCopy(pinned), new Date(1_000), new Date(1_000))

    expect(await evictColdShards({ coldDir, freeRatio: async () => 0 })).toBe(0)

    expect((await coldShards(pinned)).length).toBe(1)
    expect((await coldShards(dirty)).length).toBe(1)
  })

  it("never evicts a name that a pin, fetch or upload touched in the last idle time", async () => {
    const fresh = await coldName("repo_fresh", Date.now())

    expect(await evictColdShards({ coldDir, freeRatio: async () => 0 })).toBe(0)

    expect((await coldShards(fresh)).length).toBe(1)
  })

  it("keeps a name that an upload made new after the eviction listed it", async () => {
    const name = await coldName("repo_raced", 1_000)
    let first = true
    const freeRatio = async () => {
      // The first check lists the names; then an upload writes the copy again.
      if (first) {
        first = false
        return 0
      }
      const now = new Date()
      await utimes(localCopy(name), now, now)
      return 0
    }

    expect(await evictColdShards({ coldDir, freeRatio })).toBe(0)

    expect((await coldShards(name)).length).toBe(1)
  })

  it("runs an eviction for each cold directory, even while another one runs", async () => {
    const otherDir = join(root, "other-zoekt-index")
    await mkdir(otherDir, { recursive: true })
    let releaseFirst!: () => void
    const firstChecked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = evictColdShards({
      coldDir,
      freeRatio: async () => {
        await firstChecked
        return 0.9
      },
    })
    let otherChecked = false

    await evictColdShards({
      coldDir: otherDir,
      freeRatio: async () => {
        otherChecked = true
        return 0.9
      },
    })
    releaseFirst()
    await first

    expect(otherChecked).toBe(true)
  })

  it("does nothing while enough of the volume is free", async () => {
    const name = await coldName("repo_kept", 1_000)

    expect(await evictColdShards({ coldDir, freeRatio: async () => 0.9 })).toBe(
      0,
    )

    expect((await coldShards(name)).length).toBe(1)
  })
})
