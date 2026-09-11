import { execFile } from "node:child_process"
import { appendFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { setTimeout } from "node:timers/promises"
import { promisify } from "node:util"

const requireBackend = createRequire(
  new URL("../../apps/backend/package.json", import.meta.url),
)
const Docker = requireBackend("dockerode")
const docker = new Docker({ timeout: 15_000, version: "v1.44" })
const exec = promisify(execFile)

/** Keep the nested Docker API off the host ephemeral range (32768+) used for published OpenCode ports. */
async function reservedQuotaApiPort() {
  for (let port = 23755; port <= 23799; port++) {
    const free = await new Promise((resolve) => {
      const server = createServer()
      server.once("error", () => resolve(false))
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(true))
      })
    })
    if (free) return String(port)
  }
  throw new Error(
    "No reserved loopback port available for the quota Docker API",
  )
}
const chatImage = "ctxpipe-chat-sandbox:opencode-1.18.18"
const proxyImage =
  "node@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d"
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
    `127.0.0.1:${await reservedQuotaApiPort()}:2375`,
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
  const endpoint = `tcp://127.0.0.1:${port}`
  try {
    await exec("docker", ["--host", endpoint, "image", "inspect", proxyImage], {
      timeout: 30_000,
    })
  } catch {
    await exec("docker", ["--host", endpoint, "pull", proxyImage], {
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
    })
  }
  await exec(
    "docker",
    [
      "--host",
      endpoint,
      "build",
      "--pull=false",
      "--quiet",
      "--file",
      "scripts/chat-sandbox/Dockerfile",
      "--tag",
      chatImage,
      "scripts/chat-sandbox",
    ],
    { timeout: 600_000, maxBuffer: 10 * 1024 * 1024 },
  )
  await Promise.all([
    exec("docker", ["--host", endpoint, "image", "inspect", chatImage], {
      timeout: 30_000,
    }),
    exec("docker", ["--host", endpoint, "image", "inspect", proxyImage], {
      timeout: 30_000,
    }),
  ])
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
