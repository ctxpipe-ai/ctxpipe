import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import pins from "../../../../../scripts/ci/service-pins.json" with { type: "json" }
import {
  compareGraphSnapshots,
  fetchRdb,
  type GraphSnapshot,
  readGraphSnapshot,
} from "../../../../../shared/falkordb-transfer.js"

/*
 * The FalkorDB part of the cutover index copy (shared/falkordb-transfer.ts),
 * with real FalkorDB containers of the pinned image: an RDB of a source
 * server, loaded as the data file of a second server, has the graph counts
 * of the source. The codesearch test image has no FalkorDB, so this test is
 * in the backend contracts lane.
 */

const exec = promisify(execFile)
const docker = async (...args: string[]) =>
  (await exec("docker", args, { timeout: 180_000 })).stdout.trim()
const image = `${pins.falkordb.image}@${pins.falkordb.digest}`
const password = "transfer-test-password"
const containers: string[] = []
let directory: string
let source: { name: string; url: string }

/**
 * Starts the pinned FalkorDB with a password, on a free host port. With
 * `dataDir`, the server loads the files of that directory at start.
 */
async function startFalkorDb(dataDir?: string) {
  const name = `ctxpipe-rdb-${randomUUID().slice(0, 8)}`
  containers.push(name)
  await docker(
    "create",
    "--name",
    name,
    "-p",
    "127.0.0.1::6379",
    // CMD_INFO no: see .github/actions/falkordb.
    "-e",
    "FALKORDB_ARGS=CMD_INFO no",
    "-e",
    `REDIS_ARGS=--requirepass ${password}`,
    image,
  )
  if (dataDir)
    await docker("cp", `${dataDir}/.`, `${name}:/var/lib/falkordb/data`)
  await docker("start", name)
  const address = (await docker("port", name, "6379/tcp")).split("\n")[0]
  const url = `redis://default:${password}@${address}`
  // A server that loads an RDB answers each command with LOADING first.
  for (let attempt = 0; ; attempt++) {
    try {
      await readGraphSnapshot(url)
      return { name, url }
    } catch (error) {
      if (attempt >= 60) throw error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

const cli = (...args: string[]) =>
  docker(
    "exec",
    source.name,
    "redis-cli",
    "-a",
    password,
    "--no-auth-warning",
    ...args,
  )

/** Writes the RDB of the source into a new data directory. */
async function exportRdb(): Promise<string> {
  const dataDir = join(directory, randomUUID())
  await mkdir(dataDir)
  await pipeline(
    Readable.from(fetchRdb(source.url)),
    createWriteStream(join(dataDir, "dump.rdb")),
  )
  return dataDir
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "falkordb-transfer-"))
  source = await startFalkorDb()
  await cli(
    "GRAPH.QUERY",
    "org_alpha",
    "CREATE (:Repo {id: 1})-[:HAS]->(:File {id: 2}), (:Repo {id: 3})-[:HAS]->(:File {id: 4})-[:CALLS]->(:File {id: 5})",
  )
  await cli("GRAPH.QUERY", "org_beta", "CREATE (:Repo {id: 1})")
}, 300_000)

afterAll(async () => {
  for (const name of containers)
    await docker("rm", "-f", "-v", name).catch(() => "")
  await rm(directory, { recursive: true, force: true })
})

describe("FalkorDB RDB transfer", () => {
  it("reads the versions and the counts of each graph", async () => {
    const snapshot = await readGraphSnapshot(source.url)

    expect(snapshot.moduleVersion).toBe(pins.falkordb.moduleVersion)
    expect(snapshot.redisVersion).toMatch(/^\d+\.\d+/)
    expect(snapshot.graphs).toEqual([
      { name: "org_alpha", nodes: 5, edges: 3 },
      { name: "org_beta", nodes: 1, edges: 0 },
    ])
  })

  it.each([
    ["without a disk copy (end mark)", "yes"],
    ["from a disk copy (length)", "no"],
  ])(
    "copies the graphs %s into a server that loads the RDB",
    async (_mode, diskless) => {
      await cli("CONFIG", "SET", "repl-diskless-sync", diskless)
      const expected = await readGraphSnapshot(source.url)

      const target = await startFalkorDb(await exportRdb())

      expect(
        compareGraphSnapshots(expected, await readGraphSnapshot(target.url)),
      ).toEqual([])
    },
    300_000,
  )

  it("names each difference to the snapshot of the export", async () => {
    const actual = await readGraphSnapshot(source.url)
    const expected: GraphSnapshot = {
      ...actual,
      moduleVersion: actual.moduleVersion + 1,
      graphs: [
        { name: "org_alpha", nodes: 5, edges: 4 },
        { name: "org_gamma", nodes: 1, edges: 0 },
      ],
    }

    expect(compareGraphSnapshots(expected, actual)).toEqual([
      `module version ${actual.moduleVersion} is below the source version ${actual.moduleVersion + 1}`,
      "graph org_alpha has 5 nodes and 3 edges, expected 5 and 4",
      "graph org_gamma is missing",
      "graph org_beta is not expected",
    ])
  })

  it("refuses a wrong password", async () => {
    const url = new URL(source.url)
    url.password = "wrong-password"

    await expect(readGraphSnapshot(url.toString())).rejects.toThrow(
      /refused the password/,
    )
  })
})
