import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { Db } from "../../db/client.js"
import { git } from "../../test/gitHttpServer.js"
import { startS3Server } from "../../test/s3Server.js"

// config/paths.js reads this variable when it loads.
const { zoektDir } = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phase-store-")))
  vi.stubEnv("ZOEKT_INDEX_DIR", join(root, "zoekt-index"))
  return { zoektDir: join(root, "zoekt-index") }
})

import { zoektRepositoryName } from "../zoekt/shardPrefix.js"
import { phaseZoekt } from "./phases.js"

/*
 * The Zoekt phase with the real `zoekt-index` and a real S3-compatible
 * server: the shards move from staging into cold, and the phase uploads them.
 */

const ORG = "org_store"
const sha = "b".repeat(40)
let server: Awaited<ReturnType<typeof startS3Server>>
let checkout: string

beforeAll(async () => {
  server = await startS3Server()
  checkout = await mkdtemp(join(tmpdir(), "phase-store-checkout-"))
  await git(["init", "-q", "-b", "main", checkout])
  await writeFile(join(checkout, "a.txt"), "hello needle\n")
  const who = ["-c", "user.email=t@example.com", "-c", "user.name=t"]
  await git([...who, "add", "."], checkout)
  await git([...who, "commit", "-qm", "c"], checkout)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv("ZOEKT_INDEX_DIR", zoektDir)
})

afterAll(async () => {
  await server?.stop()
  await rm(checkout, { recursive: true, force: true })
  await rm(join(zoektDir, ".."), { recursive: true, force: true })
})

function context(repoId: string) {
  const checkoutKey = `rev:${sha}`
  return {
    // A revision key writes no repository step, so no database is needed.
    db: {} as Db,
    orgId: ORG,
    repoId,
    repoGitUrl: "https://example.com/team/app.git",
    checkoutKey,
    clonePath: checkout,
    sharedClonePath: checkout,
    scipIndexPath: join(checkout, "unused.scip"),
    zoektRepoId: 1,
    zoektName: zoektRepositoryName({ orgId: ORG, repoId, checkoutKey }),
    repoName: "team/app",
    repoUrl: "https://example.com/team/app",
  }
}

const shardsOf = async (zoektName: string) =>
  (await readdir(zoektDir)).filter((name) =>
    name.startsWith(encodeURIComponent(zoektName)),
  )
const localCopy = (zoektName: string) =>
  join(zoektDir, ".store", `${encodeURIComponent(zoektName)}.json`)

describe("phaseZoekt with a shard store", () => {
  it("moves the shards into cold, uploads them, and writes the local manifest copy", async () => {
    server.stubEnv("prod")
    const ctx = context("repo_up")

    await phaseZoekt(ctx)

    const shards = await shardsOf(ctx.zoektName)
    expect(shards.length).toBeGreaterThan(0)
    expect(await readdir(join(zoektDir, ".build"))).toEqual([])
    const manifest = JSON.parse(
      await readFile(localCopy(ctx.zoektName), "utf8"),
    )
    expect(manifest.files.map((file: { name: string }) => file.name)).toEqual(
      shards.sort(),
    )
    const prefix = `prod/v1/${ORG}/repo_up/rev:${sha}/zoekt/`
    expect(await server.keys()).toEqual(
      [
        ...shards.map((name) => `${prefix}${manifest.gen}/${name}`),
        `${prefix}manifest.json`,
      ].sort(),
    )
  })

  it("publishes one at a time when two Zoekt phases of one Name overlap", async () => {
    server.stubEnv("prod")
    const ctx = context("repo_twice")

    await Promise.all([phaseZoekt(ctx), phaseZoekt(ctx)])

    const manifest = JSON.parse(
      await readFile(localCopy(ctx.zoektName), "utf8"),
    )
    const prefix = `prod/v1/${ORG}/repo_twice/rev:${sha}/zoekt/`
    const keys = await server.keys()
    for (const file of manifest.files as { name: string }[])
      expect(keys).toContain(`${prefix}${manifest.gen}/${file.name}`)
    expect(manifest.files.map((file: { name: string }) => file.name)).toEqual(
      (await shardsOf(ctx.zoektName)).sort(),
    )
  })

  it("keeps the new shards without a local manifest copy when the upload fails", async () => {
    server.stubEnv("prod")
    vi.stubEnv("AWS_ENDPOINT_URL_S3", "http://127.0.0.1:1")
    vi.stubEnv("AWS_MAX_ATTEMPTS", "1")
    const ctx = context("repo_down")

    await phaseZoekt(ctx)

    expect((await shardsOf(ctx.zoektName)).length).toBeGreaterThan(0)
    await expect(readFile(localCopy(ctx.zoektName))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("uploads nothing with a read-only shard store, and keeps the shards without a local manifest copy", async () => {
    server.stubEnv("prod")
    vi.stubEnv("CODESEARCH_SHARD_STORE_READ_ONLY", "true")
    const ctx = context("repo_preview")
    const before = await server.keys()

    await phaseZoekt(ctx)

    expect((await shardsOf(ctx.zoektName)).length).toBeGreaterThan(0)
    expect(await server.keys()).toEqual(before)
    await expect(readFile(localCopy(ctx.zoektName))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("uploads nothing when no shard store is set", async () => {
    const ctx = context("repo_local")
    const before = await server.keys()

    await phaseZoekt(ctx)

    expect((await shardsOf(ctx.zoektName)).length).toBeGreaterThan(0)
    expect(await server.keys()).toEqual(before)
    await expect(readFile(localCopy(ctx.zoektName))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})
