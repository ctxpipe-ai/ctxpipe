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
import { Writable } from "node:stream"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { zoektRepositoryName } from "../domain/zoekt/shardPrefix.js"
import { startS3Server } from "../test/s3Server.js"
import { exportIndexes, exportVolume } from "./exportIndexes.js"
import { importIndexes } from "./importIndexes.js"
import { seedShardStore } from "./seedShardStore.js"
import {
  downloadChecked,
  startTar,
  type TransferManifest,
  transferFromUrl,
  uploadStream,
  writeTransferManifest,
} from "./transfer.js"

/*
 * The codesearch part of the cutover index copy, with real `zoekt-index`
 * shards, GNU tar and a real S3-compatible server: export the volume, import
 * it into empty directories, then seed the shard store from the imported
 * cold directory. The FalkorDB part has real FalkorDB containers in the
 * backend contracts lane (shared/falkordb-transfer.ts). This test gives the
 * export a made-up RDB, so it does not run the RDB fetch and verify-graph.
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

/**
 * The export of the volume, with a made-up RDB in place of the FalkorDB
 * part: the test image has no FalkorDB.
 */
async function writeExport(url: string) {
  const transfer = transferFromUrl(url)
  const volume = await exportVolume(transfer, source, { partSize })
  const rdbBytes = randomBytes(1024)
  const rdb = await uploadStream(
    transfer,
    "falkordb.rdb",
    (async function* () {
      yield rdbBytes
    })(),
  )
  const manifest: TransferManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    falkordb: {
      redisVersion: "8.0.0",
      moduleVersion: 42007,
      graphs: [{ name: "graph_a", nodes: 2, edges: 1 }],
      rdb,
      ms: 1,
    },
    ...volume,
    ms: 1,
  }
  await writeTransferManifest(transfer, manifest)
  return { transfer, manifest, rdbBytes }
}

/** The import targets below `root/name`. */
const targets = (name: string) => ({
  zoektIndexDir: join(root, name, "zoekt-index"),
  repoCacheDir: join(root, name, "repo-cache"),
  falkordbDataFile: join(root, name, "falkordb/dump.rdb"),
})

describe("export-indexes and import-indexes", () => {
  it("copies the volume and the RDB through the transfer prefix", async () => {
    server.stubEnv("prod")
    const url = `s3://${server.bucket}/transfer/run-1`

    const { manifest, rdbBytes } = await writeExport(url)

    expect(await server.keys()).toEqual([
      "transfer/run-1/falkordb.rdb",
      "transfer/run-1/manifest.json",
      "transfer/run-1/repo-cache.tar",
      "transfer/run-1/zoekt-index.tar",
    ])
    expect(manifest.zoektIndex.shards).toBe(2)
    expect(manifest.repoCache.size).toBeGreaterThan(partSize)
    const target = targets("target")

    const report = await importIndexes({ from: url, ...target, force: false })

    expect(report).toMatchObject({ ok: true, problems: [] })
    expect(await tree(target.repoCacheDir)).toEqual(
      await tree(source.repoCacheDir),
    )
    const sourceShards = await tree(source.zoektIndexDir, [".build", ".store"])
    expect(Object.keys(sourceShards)).toHaveLength(manifest.zoektIndex.files)
    expect(await tree(target.zoektIndexDir)).toEqual(sourceShards)
    expect(await readFile(target.falkordbDataFile)).toEqual(rdbBytes)
  })

  it("refuses an export to a run id that has a manifest", async () => {
    server.stubEnv("prod")

    await expect(
      exportIndexes({
        to: `s3://${server.bucket}/transfer/run-1`,
        falkordb: "redis://127.0.0.1:1",
        ...source,
      }),
    ).rejects.toThrow(/has a manifest already/)
  })

  it("refuses a target that is not empty, and replaces it with --force", async () => {
    server.stubEnv("prod")
    const url = `s3://${server.bucket}/transfer/run-1`
    const target = targets("full")
    await mkdir(target.repoCacheDir, { recursive: true })
    await writeFile(join(target.repoCacheDir, "stale.txt"), "stale")

    await expect(
      importIndexes({ from: url, ...target, force: false }),
    ).rejects.toThrow(/is not empty/)
    const report = await importIndexes({ from: url, ...target, force: true })

    expect(report.ok).toBe(true)
    expect(await tree(target.repoCacheDir)).toEqual(
      await tree(source.repoCacheDir),
    )
  })

  it("refuses an RDB with a different sha256, and keeps no data file", async () => {
    server.stubEnv("prod")
    const url = `s3://${server.bucket}/transfer/run-rdb`
    const { transfer, manifest } = await writeExport(url)
    const { rdb } = manifest.falkordb
    await writeTransferManifest(transfer, {
      ...manifest,
      falkordb: {
        ...manifest.falkordb,
        rdb: { ...rdb, sha256: "0".repeat(64) },
      },
    })
    const target = targets("rdb-changed")

    await expect(
      importIndexes({ from: url, ...target, force: false }),
    ).rejects.toThrow(/sha256/)

    await expect(stat(target.falkordbDataFile)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})

describe("downloadChecked", () => {
  it("throws when the target stops before the end of the download", async () => {
    server.stubEnv("prod")
    const transfer = transferFromUrl(`s3://${server.bucket}/transfer/stopped`)
    const object = await uploadStream(
      transfer,
      "data.bin",
      (async function* () {
        yield randomBytes(64 * 1024)
      })(),
    )
    // A target that takes no bytes: its buffer stays full.
    const target = new Writable({ highWaterMark: 1, write: () => undefined })

    await expect(
      downloadChecked(transfer, object, target, Promise.resolve()),
    ).rejects.toThrow(/stopped before the end/)
  })
})

describe("startTar", () => {
  it("gives the exit code and the kind of a tar error, without the member names", async () => {
    const dir = join(root, "tar-error")
    await mkdir(join(dir, "in/a secret-word"), { recursive: true })
    await writeFile(join(dir, "in/a secret-word/x.txt"), "x")
    // With -k, tar refuses to replace a file that is there already.
    await mkdir(join(dir, "out/a secret-word"), { recursive: true })
    await writeFile(join(dir, "out/a secret-word/x.txt"), "old")
    const archive = await exec(
      "tar",
      ["-cf", "-", "-C", join(dir, "in"), "."],
      {
        encoding: "buffer",
      },
    )
    const tar = startTar(["-xkvf", "-", "-C", join(dir, "out")], "stdout")

    tar.child.stdin.end(archive.stdout)

    const error = await tar.done.then(
      () => new Error("tar did not fail"),
      (thrown: Error) => thrown,
    )
    expect(error.message).toMatch(
      /^tar -xkvf exited with 2: Cannot open; other messages: \d+$/,
    )
    expect(error.message).not.toContain("secret-word")
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

  it("publishes again a Name whose shard changed without a change of size", async () => {
    server.stubEnv("store")
    const coldDir = join(root, "target/zoekt-index")
    const shard = (await readdir(coldDir)).find((name) =>
      name.endsWith(".zoekt"),
    )
    if (!shard) throw new Error("The cold directory has no shard")
    const path = join(coldDir, shard)
    const bytes = await readFile(path)
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff
    await writeFile(path, bytes)

    const report = await seedShardStore({ coldDir })

    expect(report).toMatchObject({ ok: true, published: 1, skipped: 1 })
  })
})
