import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

import { startS3Server } from "../../test/s3Server.js"
import {
  isShardStoreReadOnly,
  publishArtifact,
  readManifest,
  shardStore,
  type StoreAddress,
} from "./shardStore.js"

let server: Awaited<ReturnType<typeof startS3Server>>
let dir: string

beforeAll(async () => {
  server = await startS3Server()
})

afterAll(async () => {
  await server?.stop()
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "shard-store-"))
  server.stubEnv("prod/codesearch")
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

const address: StoreAddress = {
  orgId: "org_alpha",
  repoId: "repo_main",
  checkoutKey: `rev:${"a".repeat(40)}`,
  kind: "zoekt",
}
const prefix = `prod/codesearch/v1/org_alpha/repo_main/rev:${"a".repeat(40)}/zoekt/`

async function file(name: string, content: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}

async function putObject(key: string, body: string) {
  await store().client.send(
    new PutObjectCommand({ Bucket: server.bucket, Key: key, Body: body }),
  )
}

function store() {
  const value = shardStore()
  if (!value) throw new Error("shard store is not set")
  return value
}

describe("shardStore", () => {
  it("is null when CODESEARCH_SHARD_STORE is unset", () => {
    vi.stubEnv("CODESEARCH_SHARD_STORE", "")
    expect(shardStore()).toBeNull()
  })

  it("refuses a URL that is not s3://bucket/prefix", () => {
    vi.stubEnv("CODESEARCH_SHARD_STORE", "https://example.com/bucket")
    expect(() => shardStore()).toThrow(/s3:\/\/bucket/)
  })

  it("refuses a read-only flag other than true, false or unset", () => {
    vi.stubEnv("CODESEARCH_SHARD_STORE_READ_ONLY", "True")
    expect(() => isShardStoreReadOnly()).toThrow(/true, false or unset/)
    vi.stubEnv("CODESEARCH_SHARD_STORE_READ_ONLY", "")
    expect(isShardStoreReadOnly()).toBe(false)
  })

  it("puts the layout version after the prefix", () => {
    expect(store().root).toBe("prod/codesearch/v1")
    vi.stubEnv("CODESEARCH_SHARD_STORE", `s3://${server.bucket}`)
    expect(store().root).toBe("v1")
  })
})

describe("publishArtifact", () => {
  it("uploads the files, then the manifest, and reads them back", async () => {
    const a = await file("a_v16.00000.zoekt", "alpha")
    const b = await file("a_v16.00001.zoekt", "beta")

    const manifest = await publishArtifact(store(), address, [a, b])

    expect(manifest.files).toEqual([
      {
        name: "a_v16.00000.zoekt",
        size: 5,
        sha256:
          "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8",
      },
      {
        name: "a_v16.00001.zoekt",
        size: 4,
        sha256:
          "f44e64e75f3948e9f73f8dfa94721c4ce8cbb4f265c4790c702b2d41cfbf2753",
      },
    ])
    expect(await readManifest(store(), address)).toEqual(manifest)
    expect(await server.keys()).toEqual([
      `${prefix}${manifest.gen}/a_v16.00000.zoekt`,
      `${prefix}${manifest.gen}/a_v16.00001.zoekt`,
      `${prefix}manifest.json`,
    ])
  })

  it("gives null for an address with no manifest", async () => {
    expect(
      await readManifest(store(), { ...address, repoId: "repo_none" }),
    ).toBeNull()
  })

  it("keeps the generation before the new one and deletes older ones", async () => {
    const other = { ...address, repoId: "repo_gens" }
    const path = await file("g_v16.00000.zoekt", "one")
    const first = await publishArtifact(store(), other, [path])
    const second = await publishArtifact(store(), other, [path])
    const third = await publishArtifact(store(), other, [path])
    const otherPrefix = prefix.replace("repo_main", "repo_gens")

    expect(await server.keys()).toEqual(
      expect.arrayContaining([
        `${otherPrefix}${second.gen}/g_v16.00000.zoekt`,
        `${otherPrefix}${third.gen}/g_v16.00000.zoekt`,
      ]),
    )
    expect(
      (await server.keys()).filter((key) => key.includes(first.gen)),
    ).toEqual([])
  })

  it("keeps the old manifest when an upload fails", async () => {
    const other = { ...address, repoId: "repo_partial" }
    const good = await publishArtifact(store(), other, [
      await file("p_v16.00000.zoekt", "good"),
    ])

    await expect(
      publishArtifact(store(), other, [
        await file("p_v16.00000.zoekt", "next"),
        join(dir, "missing.zoekt"),
      ]),
    ).rejects.toThrow()

    expect(await readManifest(store(), other)).toEqual(good)
  })

  it("publishes over a manifest that does not parse", async () => {
    const other = { ...address, repoId: "repo_corrupt" }
    await putObject(
      `prod/codesearch/v1/org_alpha/repo_corrupt/${address.checkoutKey}/zoekt/manifest.json`,
      "not json",
    )

    const manifest = await publishArtifact(store(), other, [
      await file("c_v16.00000.zoekt", "fixed"),
    ])

    expect(await readManifest(store(), other)).toEqual(manifest)
  })

  it("refuses a manifest whose file name is a path", async () => {
    const other = { ...address, repoId: "repo_path" }
    await putObject(
      `prod/codesearch/v1/org_alpha/repo_path/${address.checkoutKey}/zoekt/manifest.json`,
      JSON.stringify({
        gen: "g1",
        files: [{ name: "../escape", size: 1, sha256: "0".repeat(64) }],
      }),
    )

    await expect(readManifest(store(), other)).rejects.toThrow()
  })

  it("refuses an address segment with a slash", async () => {
    await expect(
      publishArtifact(store(), { ...address, checkoutKey: "../x" }, []),
    ).rejects.toThrow(/safe store key segment/)
  })
})
