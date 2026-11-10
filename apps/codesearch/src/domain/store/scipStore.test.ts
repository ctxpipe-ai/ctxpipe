import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
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
import { ensureScipIndex, uploadScipIndex } from "./scipStore.js"
import { shardStore } from "./shardStore.js"

/*
 * The merged SCIP index in the shard store, against a real S3-compatible
 * server: the merge uploads it, and a graph read fetches it when it is
 * missing (a preview, or a disk after a host loss).
 */

const key = `rev:${"c".repeat(40)}`
let server: Awaited<ReturnType<typeof startS3Server>>
let dir: string

beforeAll(async () => {
  server = await startS3Server()
})

afterAll(async () => {
  await server?.stop()
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scip-store-"))
  server.stubEnv("prod")
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

const checkout = (repoId: string) => ({
  orgId: "org_scip",
  repoId,
  checkoutKey: key,
})
const scipPathOf = (repoId: string) =>
  join(dir, repoId, "checkouts", `${key}.scip`)

async function writeScip(repoId: string, content: string): Promise<string> {
  const path = scipPathOf(repoId)
  await mkdir(join(dir, repoId, "checkouts"), { recursive: true })
  await writeFile(path, content)
  return path
}

describe("merged SCIP index in the shard store", () => {
  it("uploads the index, and a read of a missing index fetches it", async () => {
    const path = await writeScip("repo_a", "scip-bytes")
    await uploadScipIndex(checkout("repo_a"), path)
    await rm(join(dir, "repo_a"), { recursive: true, force: true })

    await ensureScipIndex(checkout("repo_a"), path)

    expect(await readFile(path, "utf8")).toBe("scip-bytes")
    expect(await readdir(join(dir, "repo_a", "checkouts"))).toEqual([
      `${key}.scip`,
    ])
  })

  it("uploads an empty manifest when the merge wrote no index, so no older index comes back", async () => {
    const path = await writeScip("repo_empty", "old")
    await uploadScipIndex(checkout("repo_empty"), path)
    await rm(path)
    await uploadScipIndex(checkout("repo_empty"), path)

    await ensureScipIndex(checkout("repo_empty"), path)

    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("keeps a local index and does not read S3 for it", async () => {
    const path = await writeScip("repo_local", "local")
    vi.stubEnv("AWS_ENDPOINT_URL_S3", "http://127.0.0.1:1")

    await ensureScipIndex(checkout("repo_local"), path)

    expect(await readFile(path, "utf8")).toBe("local")
  })

  it("leaves the index missing when the manifest names a foreign file", async () => {
    const store = shardStore()
    if (!store) throw new Error("shard store is not set")
    await store.client.send(
      new PutObjectCommand({
        Bucket: server.bucket,
        Key: `prod/v1/org_scip/repo_foreign/${key}/scip/manifest.json`,
        Body: JSON.stringify({
          gen: "g1",
          files: [{ name: "other.scip", size: 1, sha256: "0".repeat(64) }],
        }),
      }),
    )

    await ensureScipIndex(checkout("repo_foreign"), scipPathOf("repo_foreign"))

    await expect(readFile(scipPathOf("repo_foreign"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})
