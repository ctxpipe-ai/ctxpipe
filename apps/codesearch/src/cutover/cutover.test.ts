import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { zoektRepositoryName } from "../domain/zoekt/shardPrefix.js"
import { startS3Server } from "../test/s3Server.js"
import { exportIndexes } from "./exportIndexes.js"
import { importIndexes } from "./importIndexes.js"
import { seedShardStore } from "./seedShardStore.js"
import {
  readTransferManifest,
  transferFromUrl,
  uploadStream,
  writeTransferManifest,
} from "./transfer.js"

/*
 * The codesearch part of the cutover index copy, with real `zoekt-index`
 * shards, GNU tar and a real S3-compatible server: export the volume, import
 * it into empty directories, then seed the shard store from the imported
 * cold directory. The FalkorDB part has real FalkorDB containers in the
 * backend contracts lane (shared/falkordb-transfer.ts).
 */

const exec = promisify(execFile)
const ORG = "org_cutover"
const names = [
  zoektRepositoryName({ orgId: ORG, repoId: "repo_main" }),
  zoektRepositoryName({
    orgId: ORG,
    repoId: "repo_main",
    checkoutKey: `rev:${"c".repeat(40)}`,
  }),
]
// Small parts, so the 6 MiB file of the repository cache takes two parts.
const partSize = 5 * 1024 * 1024
let server: Awaited<ReturnType<typeof startS3Server>>
let root: string
let source: { zoektIndexDir: string; repoCacheDir: string }

/** Each file and symlink below `dir`, with its content or its target. */
async function tree(dir: string, skip: string[] = []) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const result: Record<string, string> = {}
  for (const entry of entries) {
    const path = relative(dir, join(entry.parentPath, entry.name))
    if (skip.some((prefix) => path.startsWith(prefix))) continue
    if (entry.isSymbolicLink())
      result[path] = `-> ${await readlink(join(dir, path))}`
    else if (entry.isFile())
      result[path] = (await readFile(join(dir, path))).toString("base64")
  }
  return result
}

beforeAll(async () => {
  server = await startS3Server()
  root = await mkdtemp(join(tmpdir(), "cutover-"))
  source = {
    zoektIndexDir: join(root, "source/zoekt-index"),
    repoCacheDir: join(root, "source/repo-cache"),
  }
  const checkout = join(source.repoCacheDir, ORG, "repo_main/checkouts/default")
  await mkdir(checkout, { recursive: true })
  await writeFile(join(checkout, "a.txt"), "hello needle\n")
  await writeFile(join(checkout, "large.bin"), randomBytes(6 * 1024 * 1024))
  await symlink("a.txt", join(checkout, "link.txt"))
  await writeFile(join(source.repoCacheDir, ".codesearch-layout"), "2\n")
  // Real shards of two Names, and the entries that the export leaves out.
  await mkdir(join(source.zoektIndexDir, ".build/stopped"), { recursive: true })
  await writeFile(join(source.zoektIndexDir, ".build/stopped/x.zoekt"), "x")
  await mkdir(join(source.zoektIndexDir, ".store"))
  await writeFile(join(source.zoektIndexDir, ".store/old.json"), "{}")
  for (const [index, name] of names.entries()) {
    const meta = join(root, `meta-${index}.json`)
    await writeFile(
      meta,
      JSON.stringify({
        ID: index + 1,
        Name: name,
        URL: "https://example.com/team/app",
        Source: checkout,
        Branches: [{ Name: "HEAD", Version: "c".repeat(40) }],
      }),
    )
    await exec("zoekt-index", [
      "-index",
      source.zoektIndexDir,
      "-meta",
      meta,
      checkout,
    ])
  }
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await server?.stop()
  await rm(root, { recursive: true, force: true })
})

describe("export-indexes and import-indexes", () => {
  it("copies the volume through the transfer prefix", async () => {
    server.stubEnv("prod")
    const url = `s3://${server.bucket}/transfer/run-1`

    const manifest = await exportIndexes({ to: url, ...source, partSize })

    expect(await server.keys()).toEqual([
      "transfer/run-1/manifest.json",
      "transfer/run-1/repo-cache.tar",
      "transfer/run-1/zoekt-index.tar",
    ])
    expect(manifest.falkordb).toBeNull()
    expect(manifest.zoektIndex.shards).toBe(2)
    expect(manifest.repoCache.size).toBeGreaterThan(partSize)
    const targets = {
      zoektIndexDir: join(root, "target/zoekt-index"),
      repoCacheDir: join(root, "target/repo-cache"),
    }

    const report = await importIndexes({ from: url, ...targets, force: false })

    expect(report).toMatchObject({ ok: true, problems: [] })
    expect(await tree(targets.repoCacheDir)).toEqual(
      await tree(source.repoCacheDir),
    )
    const sourceShards = await tree(source.zoektIndexDir, [".build", ".store"])
    expect(Object.keys(sourceShards)).toHaveLength(manifest.zoektIndex.files)
    expect(await tree(targets.zoektIndexDir)).toEqual(sourceShards)
  })

  it("refuses an export to a run id that has a manifest", async () => {
    server.stubEnv("prod")

    await expect(
      exportIndexes({ to: `s3://${server.bucket}/transfer/run-1`, ...source }),
    ).rejects.toThrow(/has a manifest already/)
  })

  it("refuses a target that is not empty, and replaces it with --force", async () => {
    server.stubEnv("prod")
    const url = `s3://${server.bucket}/transfer/run-1`
    const targets = {
      zoektIndexDir: join(root, "full/zoekt-index"),
      repoCacheDir: join(root, "full/repo-cache"),
    }
    await mkdir(targets.repoCacheDir, { recursive: true })
    await writeFile(join(targets.repoCacheDir, "stale.txt"), "stale")

    await expect(
      importIndexes({ from: url, ...targets, force: false }),
    ).rejects.toThrow(/is not empty/)
    const report = await importIndexes({ from: url, ...targets, force: true })

    expect(report.ok).toBe(true)
    expect(await tree(targets.repoCacheDir)).toEqual(
      await tree(source.repoCacheDir),
    )
  })

  it("writes the RDB as the FalkorDB data file, and refuses a changed one", async () => {
    server.stubEnv("prod")
    const url = `s3://${server.bucket}/transfer/run-rdb`
    const transfer = transferFromUrl(url)
    const exported = await exportIndexes({ to: url, ...source })
    const bytes = randomBytes(1024)
    const rdb = await uploadStream(
      transfer,
      "falkordb.rdb",
      (async function* () {
        yield bytes
      })(),
    )
    const graphs = [{ name: "graph_a", nodes: 2, edges: 1 }]
    const falkordb = {
      redisVersion: "8.0.0",
      moduleVersion: 42007,
      graphs,
      rdb,
      ms: 1,
    }
    await writeTransferManifest(transfer, { ...exported, falkordb })
    const dataFile = join(root, "rdb/data/dump.rdb")
    const targets = (name: string) => ({
      zoektIndexDir: join(root, name, "zoekt-index"),
      repoCacheDir: join(root, name, "repo-cache"),
    })

    await expect(
      importIndexes({ from: url, ...targets("rdb-none"), force: false }),
    ).rejects.toThrow(/--falkordb-data-file/)
    await importIndexes({
      from: url,
      ...targets("rdb"),
      falkordbDataFile: dataFile,
      force: false,
    })
    expect(await readFile(dataFile)).toEqual(bytes)

    await writeTransferManifest(transfer, {
      ...exported,
      falkordb: { ...falkordb, rdb: { ...rdb, sha256: "0".repeat(64) } },
    })
    const changedFile = join(root, "rdb-changed/data/dump.rdb")
    await expect(
      importIndexes({
        from: url,
        ...targets("rdb-changed"),
        falkordbDataFile: changedFile,
        force: false,
      }),
    ).rejects.toThrow(/sha256/)
    await expect(stat(changedFile)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readTransferManifest(transfer)).not.toBeNull()
  })
})

describe("seed-shard-store", () => {
  it("publishes the shards of each Name once and writes the local manifest copies", async () => {
    server.stubEnv("store")
    const coldDir = join(root, "target/zoekt-index")

    const first = await seedShardStore({ coldDir })

    expect(first).toMatchObject({
      ok: true,
      names: 2,
      shards: 2,
      published: 2,
      skipped: 0,
    })
    const keys = await server.keys()
    for (const checkout of ["default", `rev:${"c".repeat(40)}`])
      expect(keys).toContain(
        `store/v1/${ORG}/repo_main/${checkout}/zoekt/manifest.json`,
      )
    for (const name of names)
      await stat(join(coldDir, ".store", `${encodeURIComponent(name)}.json`))

    const second = await seedShardStore({ coldDir })

    expect(second).toMatchObject({ ok: true, published: 0, skipped: 2 })
    expect(await server.keys()).toEqual(keys)
  })
})
