import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import {
  type ClickHouseClient,
  ClickHouseLogLevel,
  createClient,
} from "@clickhouse/client"

import { testLabelArgs } from "../../../../scripts/ci/test-containers.mjs"
import {
  KNOWLEDGE_TABLES,
  type KnowledgeScope,
  NO_KNOWLEDGE_ROWS,
  ORG_SETTING,
  type PurgeCounts,
} from "../knowledge-store/knowledge-store.js"
import { migrateKnowledgeStore } from "../knowledge-store/migrate.js"
import { contractImage } from "./contract-images.js"

const exec = promisify(execFile)
const docker = async (...args: string[]) =>
  (await exec("docker", args, { timeout: 180_000 })).stdout.trim()

/** `url` with the user `user` and its password: the URL of that user. */
export function userUrl(url: string, user: string, password: string): string {
  const withUser = new URL(url)
  withUser.username = user
  withUser.password = password
  return withUser.toString()
}

/**
 * The count of rows of `scope` in each knowledge table. With `inParts`, the
 * count also has the rows that a DELETE hid but that the parts still hold.
 */
export async function knowledgeRowCounts(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  { inParts = false } = {},
): Promise<PurgeCounts> {
  const counts = { ...NO_KNOWLEDGE_ROWS }
  for (const table of KNOWLEDGE_TABLES) {
    const result = await client.query({
      query: `SELECT count() AS rows FROM ${table}
              WHERE org_id = {orgId:String} AND workspace_id = {workspaceId:String}`,
      query_params: scope,
      format: "JSONEachRow",
      clickhouse_settings: {
        [ORG_SETTING]: scope.orgId,
        apply_deleted_mask: inParts ? 0 : 1,
      },
    })
    const [row] = await result.json<{ rows: string }>()
    counts[table] = Number(row?.rows)
  }
  return counts
}

/**
 * A ClickHouse server of the pinned image in Docker, for the contract tests of
 * KnowledgeStore. Call `stop` in `afterAll`.
 */
export async function startClickHouse({
  objectStorageCold = false,
}: {
  /**
   * The disk cold is an object storage disk with its objects in a local
   * folder (clickhouse-cold-object-storage.xml), as the S3 disk of the
   * hosted node.
   */
  objectStorageCold?: boolean
} = {}): Promise<{
  serverUrl: string
  /** A new database with the migrated tables. Returns its URL. */
  freshDatabase(): Promise<string>
  /**
   * A client for statements that do not go through KnowledgeStore. It logs
   * nothing, because tests make statements that fail on purpose. `stop`
   * closes it.
   */
  client(url: string): ClickHouseClient
  /**
   * Kills the server and starts it again, as a crash restart. The data, the
   * port and the URLs stay. Returns when the server answers again.
   */
  restart(): Promise<void>
  /** Whether the file `path` is in the container of the server. */
  fileExists(path: string): Promise<boolean>
  /**
   * The server keeps a replaced part for 8 minutes, and its cleanup waits
   * up to 5 minutes when it has nothing to do. A test cannot wait that
   * long: this makes the cleanup of `tables` of the database at `url` run
   * each second, and removes a replaced part after one second.
   */
  shortenPartCleanup(url: string, tables: readonly string[]): Promise<void>
  stop(): Promise<void>
}> {
  const container = `ctxpipe-knowledge-${randomUUID().slice(0, 8)}`
  // A fixed host port: Docker gives a new ephemeral port at each restart.
  const port = await freePort()
  await docker(
    "create",
    ...testLabelArgs(),
    "--name",
    container,
    "-p",
    `127.0.0.1:${port}:8123`,
    "-e",
    "CLICKHOUSE_USER=knowledge",
    "-e",
    "CLICKHOUSE_PASSWORD=knowledge-test",
    // The migrations create row policies (SQL access management).
    "-e",
    "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1",
    contractImage("clickhouse"),
  )
  // The storage policy with the volume cold, which the TTL of the migrations
  // needs. docker cp also works when the Docker daemon is on another host.
  await docker(
    "cp",
    fileURLToPath(
      new URL("../knowledge-store/clickhouse-storage.xml", import.meta.url),
    ),
    `${container}:/etc/clickhouse-server/config.d/storage.xml`,
  )
  if (objectStorageCold)
    await docker(
      "cp",
      fileURLToPath(
        new URL("./clickhouse-cold-object-storage.xml", import.meta.url),
      ),
      // After storage.xml in the order of the names: it replaces the disk.
      `${container}:/etc/clickhouse-server/config.d/zz-cold-object-storage.xml`,
    )
  await docker("start", container)
  const clients: ClickHouseClient[] = []
  const stop = async () => {
    await Promise.all(clients.map((client) => client.close()))
    await docker("rm", "-f", "-v", container).catch(() => "")
  }
  try {
    const serverUrl = `http://knowledge:knowledge-test@127.0.0.1:${port}`
    const waitUntilStarted = async () => {
      // Quiet: the first attempts fail while the server starts.
      const client = createClient({
        url: serverUrl,
        log: { level: ClickHouseLogLevel.OFF },
      })
      try {
        for (let attempt = 0; !(await client.ping()).success; attempt++) {
          if (attempt >= 120) throw new Error("ClickHouse did not start")
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      } finally {
        await client.close()
      }
    }
    await waitUntilStarted()
    return {
      serverUrl,
      async freshDatabase() {
        const name = `knowledge_${randomUUID().replaceAll("-", "")}`
        const admin = createClient({ url: serverUrl })
        try {
          await admin.command({ query: `CREATE DATABASE ${name}` })
        } finally {
          await admin.close()
        }
        const url = `${serverUrl}/${name}`
        await migrateKnowledgeStore(url)
        return url
      },
      client(url) {
        const client = createClient({
          url,
          log: { level: ClickHouseLogLevel.OFF },
        })
        clients.push(client)
        return client
      },
      async restart() {
        await docker("restart", "--time", "0", container)
        await waitUntilStarted()
      },
      async fileExists(path) {
        try {
          await docker("exec", container, "test", "-e", path)
          return true
        } catch (error) {
          // Exit code 1 of `test -e`: no such file. Each other failure (of
          // Docker, or a timeout) is no proof.
          if ((error as { code?: unknown }).code === 1) return false
          throw error
        }
      },
      async shortenPartCleanup(url, tables) {
        const client = createClient({ url })
        try {
          for (const table of tables)
            await client.command({
              query: `ALTER TABLE ${table} MODIFY SETTING old_parts_lifetime = 1,
                cleanup_delay_period = 1, max_cleanup_delay_period = 1,
                cleanup_delay_period_random_add = 0`,
            })
        } finally {
          await client.close()
        }
        // The cleanup of a table read its delay before this change: a
        // restart starts it again with the new settings.
        await docker("restart", "--time", "0", container)
        await waitUntilStarted()
      },
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}

/** A TCP port on 127.0.0.1 that no process listens on now. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address === "string") throw new Error("No port")
  return address.port
}
