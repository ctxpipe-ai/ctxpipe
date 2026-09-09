import { execFile } from "node:child_process"
import { appendFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { setTimeout } from "node:timers/promises"
import { promisify } from "node:util"

const requireBackend = createRequire(
  new URL("../../apps/backend/package.json", import.meta.url),
)
const Docker = requireBackend("dockerode")
const docker = new Docker({ timeout: 15_000, version: "v1.44" })
const exec = promisify(execFile)
const { stdout } = await exec(
  "docker",
  [
    "create",
    "--name",
    `ctxpipe-quota-contract-${process.pid}`,
    "--rm",
    "--privileged",
    "--label",
    "ai.ctxpipe.purpose=native-quota-contract",
    "--env",
    "DOCKER_TLS_CERTDIR=",
    "--env",
    "CTXPIPE_SANDBOX_STORAGE_GIB=12",
    "--publish",
    "127.0.0.1::2375",
    process.env.CTXPIPE_QUOTA_RUNNER_IMAGE ?? "ctxpipe-sandbox-runner:ci",
  ],
  { timeout: 15_000 },
)
const container = docker.getContainer(stdout.trim())

try {
  await container.start()
  const info = await container.inspect()
  const port = info.NetworkSettings.Ports["2375/tcp"]?.[0]?.HostPort
  if (!port) throw new Error("Quota runner has no loopback API port")
  const client = new Docker({ host: "127.0.0.1", port, timeout: 1_000 })
  const deadline = Date.now() + 60_000
  while (true) {
    try {
      const engine = await client.info()
      if (engine.Driver !== "btrfs")
        throw new Error(
          `Quota runner selected unexpected driver ${engine.Driver}`,
        )
      break
    } catch (error) {
      if (Date.now() >= deadline) throw error
      const state = await container.inspect()
      if (!state.State.Running)
        throw new Error("Quota runner exited during startup", { cause: error })
      await setTimeout(500)
    }
  }
  const env = {
    CTXPIPE_TEST_QUOTA_DOCKER_HOST: "127.0.0.1",
    CTXPIPE_TEST_QUOTA_DOCKER_PORT: port,
    CTXPIPE_TEST_QUOTA_RUNNER_ID: container.id,
  }
  if (process.env.GITHUB_ENV) {
    await appendFile(
      process.env.GITHUB_ENV,
      Object.entries(env)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    )
  }
  process.stdout.write(`${JSON.stringify(env)}\n`)
} catch (error) {
  try {
    await container.remove({ force: true, v: true })
  } catch (cleanupError) {
    if (cleanupError?.statusCode !== 404)
      throw new AggregateError(
        [error, cleanupError],
        "Quota runner startup and cleanup failed",
      )
  }
  throw error
}
