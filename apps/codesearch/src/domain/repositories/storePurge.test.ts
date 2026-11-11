import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

import { startS3Server } from "../../test/s3Server.js"

// config/paths.js reads these variables when it loads.
const { cacheRoot } = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const root = realpathSync(mkdtempSync(join(tmpdir(), "store-purge-")))
  vi.stubEnv("REPO_CACHE_DIR", join(root, "repo-cache"))
  vi.stubEnv("ZOEKT_INDEX_DIR", join(root, "zoekt-index"))
  return { cacheRoot: root }
})

import { publishArtifact, shardStore } from "../store/shardStore.js"
import { resetPinManagerForTests } from "../zoekt/pinManager.js"
import {
  zoektRepositoryName,
  zoektShardFilePrefix,
} from "../zoekt/shardPrefix.js"
import { deleteCheckoutFromDisk, sweepRepositoryDisk } from "./checkoutGc.js"
import { purgeRepositoryFromDisk } from "./purge.js"

/*
 * Repository purge, checkout GC and the orphan sweep delete the S3 copies
 * too, against a real S3-compatible server. A failed S3 delete fails them.
 */

const ORG = "org_purge"
const zoektDir = join(cacheRoot, "zoekt-index")
const revA = `rev:${"a".repeat(40)}`
const revB = `rev:${"b".repeat(40)}`
let server: Awaited<ReturnType<typeof startS3Server>>
let dir: string

beforeAll(async () => {
  server = await startS3Server()
})

afterAll(async () => {
  await server?.stop()
  await rm(cacheRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  resetPinManagerForTests()
  dir = await mkdtemp(join(tmpdir(), "store-purge-files-"))
  server.stubEnv("prod")
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.stubEnv("REPO_CACHE_DIR", join(cacheRoot, "repo-cache"))
  vi.stubEnv("ZOEKT_INDEX_DIR", zoektDir)
  await rm(dir, { recursive: true, force: true })
})

async function publish(repoId: string, checkoutKey: string) {
  const store = shardStore()
  if (!store) throw new Error("shard store is not set")
  const path = join(dir, `${repoId}-${checkoutKey.length}.zoekt`)
  await writeFile(path, "shard")
  await publishArtifact(
    store,
    { orgId: ORG, repoId, checkoutKey, kind: "zoekt" },
    [path],
  )
}

const keysOf = async (repoId: string) =>
  (await server.keys()).filter((key) =>
    key.startsWith(`prod/v1/${ORG}/${repoId}/`),
  )
const checkoutKeysOf = async (repoId: string) =>
  [
    ...new Set(
      (await keysOf(repoId)).map(
        (key) => key.slice(`prod/v1/${ORG}/${repoId}/`.length).split("/")[0],
      ),
    ),
  ].sort()

async function localShard(repoId: string): Promise<string> {
  await mkdir(zoektDir, { recursive: true })
  const name = `${zoektShardFilePrefix(zoektRepositoryName({ orgId: ORG, repoId }))}v16.00000.zoekt`
  await writeFile(join(zoektDir, name), "shard")
  return name
}

describe("purgeRepositoryFromDisk with a shard store", () => {
  it("deletes every S3 copy of the repository and keeps a repository whose id starts the same", async () => {
    await publish("repo_p", "default")
    await publish("repo_p", revA)
    await publish("repo_px", "default")
    const shard = await localShard("repo_p")

    await purgeRepositoryFromDisk({
      orgId: ORG,
      repoId: "repo_p",
      repoName: "team/app",
      zoektRepoId: 1,
    })

    expect(await keysOf("repo_p")).toEqual([])
    expect(await checkoutKeysOf("repo_px")).toEqual(["default"])
    expect(await readdir(zoektDir)).not.toContain(shard)
  })

  it("fails and keeps the local shards when S3 does not answer", async () => {
    const shard = await localShard("repo_down")
    vi.stubEnv("AWS_ENDPOINT_URL_S3", "http://127.0.0.1:1")
    vi.stubEnv("AWS_MAX_ATTEMPTS", "1")

    await expect(
      purgeRepositoryFromDisk({
        orgId: ORG,
        repoId: "repo_down",
        repoName: "team/app",
        zoektRepoId: 2,
      }),
    ).rejects.toThrow()

    expect(await readdir(zoektDir)).toContain(shard)
  })
})

describe("deleteCheckoutFromDisk with a shard store", () => {
  it("deletes the S3 copies of that checkout key only", async () => {
    await publish("repo_gc", revA)
    await publish("repo_gc", revB)

    await deleteCheckoutFromDisk({
      orgId: ORG,
      repoId: "repo_gc",
      checkoutKey: revA,
      zoektRepoId: 3,
    })

    expect(await checkoutKeysOf("repo_gc")).toEqual([revB])
  })
})

describe("sweepRepositoryDisk with a shard store", () => {
  it("deletes the S3 copies of old keys with no row, and keeps rows, the published key, and new copies", async () => {
    await publish("repo_sweep", "default")
    await publish("repo_sweep", revA)
    await publish("repo_sweep", revB)
    const sweep = (minAgeMs: number) =>
      sweepRepositoryDisk({
        orgId: ORG,
        repoId: "repo_sweep",
        rowKeys: new Set([revA]),
        publishedCheckoutKey: "default",
        minAgeMs,
      })

    await sweep(60 * 60 * 1000)
    expect(await checkoutKeysOf("repo_sweep")).toEqual(
      ["default", revA, revB].sort(),
    )

    const result = await sweep(0)
    expect(await checkoutKeysOf("repo_sweep")).toEqual(["default", revA].sort())
    expect(result.deletedEntries).toBe(1)
  })
})

describe("sweepRepositoryDisk when S3 does not answer", () => {
  it("fails before it deletes a local file", async () => {
    await mkdir(zoektDir, { recursive: true })
    const name = `${zoektShardFilePrefix(zoektRepositoryName({ orgId: ORG, repoId: "repo_sweep_down", checkoutKey: revB }))}v16.00000.zoekt`
    await writeFile(join(zoektDir, name), "shard")
    vi.stubEnv("AWS_ENDPOINT_URL_S3", "http://127.0.0.1:1")
    vi.stubEnv("AWS_MAX_ATTEMPTS", "1")

    await expect(
      sweepRepositoryDisk({
        orgId: ORG,
        repoId: "repo_sweep_down",
        rowKeys: new Set(),
        publishedCheckoutKey: "default",
        minAgeMs: 0,
      }),
    ).rejects.toThrow()

    expect(await readdir(zoektDir)).toContain(name)
  })
})
