import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"

import { afterAll, expect, it } from "vitest"

import { testLabelArgs } from "../../../../scripts/ci/test-containers.mjs"
import { startClickHouse } from "./clickhouse.js"
import { contractImage } from "./contract-images.js"

const exec = promisify(execFile)
const docker = async (...args: string[]) =>
  (await exec("docker", args, { timeout: 180_000 })).stdout.trim()

const holder = `ctxpipe-port-holder-${randomUUID().slice(0, 8)}`
afterAll(async () => {
  await docker("rm", "-f", "-v", holder).catch(() => "")
})

it("starts on a new port when another container takes the chosen port before docker start", async () => {
  // Docker gives the holder a free port. The helper then gets that port
  // first, as when another container takes it between the choice and the
  // start. The holder binds in the Docker host, as the server does.
  await docker(
    "run",
    "-d",
    ...testLabelArgs(),
    "--name",
    holder,
    "-p",
    "127.0.0.1::8123",
    contractImage("clickhouse"),
  )
  const held = Number((await docker("port", holder, "8123")).split(":").pop())
  const clickhouse = await startClickHouse({ firstPort: held })
  try {
    expect(clickhouse.serverUrl).not.toContain(`:${held}`)
    const url = await clickhouse.freshDatabase()
    // restart keeps the fixed port.
    await clickhouse.restart()
    const result = await clickhouse
      .client(url)
      .query({ query: "SELECT 1", format: "CSV" })
    expect(await result.text()).toBe("1\n")
  } finally {
    await clickhouse.stop()
  }
})
