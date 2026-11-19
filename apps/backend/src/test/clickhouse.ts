import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import {
  type ClickHouseClient,
  ClickHouseLogLevel,
  createClient,
} from "@clickhouse/client"

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
 * A ClickHouse server of the pinned image in Docker, for the contract tests of
 * KnowledgeStore. Call `stop` in `afterAll`.
 */
export async function startClickHouse(): Promise<{
  serverUrl: string
  /** A new database with the migrated tables. Returns its URL. */
  freshDatabase(): Promise<string>
  /**
   * A client for statements that do not go through KnowledgeStore. It logs
   * nothing, because tests make statements that fail on purpose. `stop`
   * closes it.
   */
  client(url: string): ClickHouseClient
  stop(): Promise<void>
}> {
  const container = `ctxpipe-knowledge-${randomUUID().slice(0, 8)}`
  await docker(
    "create",
    "--name",
    container,
    "-p",
    "127.0.0.1::8123",
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
  await docker("start", container)
  const clients: ClickHouseClient[] = []
  const stop = async () => {
    await Promise.all(clients.map((client) => client.close()))
    await docker("rm", "-f", "-v", container).catch(() => "")
  }
  try {
    const address = (await docker("port", container, "8123/tcp")).split("\n")[0]
    const serverUrl = `http://knowledge:knowledge-test@${address}`
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
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}
