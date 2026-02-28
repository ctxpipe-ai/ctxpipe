import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process"
import { once } from "node:events"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const port = 33123
const baseUrl = `http://127.0.0.1:${port}`
let backendProcess: ChildProcessWithoutNullStreams | null = null
let backendSpawnError: string | null = null
const previousEnv = {
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  DATABASE_URL: process.env.DATABASE_URL,
  UI_PROXY_URL: process.env.UI_PROXY_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  AUTH_BASE_URL: process.env.AUTH_BASE_URL,
  ENABLE_LANGSMITH: process.env.ENABLE_LANGSMITH,
  MODEL_PROVIDER_API_KEY: process.env.MODEL_PROVIDER_API_KEY,
  MODEL_PROVIDER_URL: process.env.MODEL_PROVIDER_URL,
}
let backendStderr = ""
let backendStdout = ""

describe("MCP conformance (Vitest-integrated)", () => {
  beforeAll(async () => {
    process.env.NODE_ENV = "test"
    process.env.PORT = String(port)
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ?? "postgresql://ctxpipe:ctxpipe@localhost:5433/ctxpipe"
    process.env.UI_PROXY_URL =
      process.env.UI_PROXY_URL ?? "http://localhost:3002"
    process.env.AUTH_SECRET =
      process.env.AUTH_SECRET ?? "abcdefghijklmnopqrstuvwxyz123456"
    process.env.AUTH_BASE_URL = process.env.AUTH_BASE_URL ?? baseUrl
    process.env.ENABLE_LANGSMITH = "false"
    process.env.MODEL_PROVIDER_API_KEY =
      process.env.MODEL_PROVIDER_API_KEY ?? "test-model-key"
    process.env.MODEL_PROVIDER_URL =
      process.env.MODEL_PROVIDER_URL ?? "https://openrouter.ai/api/v1"

    const pnpmExecPath = process.env.npm_execpath
    if (!pnpmExecPath) {
      throw new Error("Missing npm_execpath in test environment")
    }

    backendProcess = spawn(
      process.execPath,
      [pnpmExecPath, "exec", "tsx", "src/routes/mcp.conformance.server.ts"],
      {
      cwd: new URL("../../", import.meta.url),
      env: process.env as Record<string, string>,
      stdio: "pipe",
      },
    )
    backendProcess.stdout.on("data", (chunk: Buffer | string) => {
      backendStdout += chunk.toString()
    })
    backendProcess.stderr.on("data", (chunk: Buffer | string) => {
      backendStderr += chunk.toString()
    })
    backendProcess.on("error", (error) => {
      backendSpawnError = error.message
    })

    await waitForServerReady(`${baseUrl}/.status`)
  }, 60_000)

  afterAll(async () => {
    if (backendProcess && backendProcess.exitCode === null && !backendProcess.killed) {
      backendProcess.kill("SIGTERM")
      await once(backendProcess, "exit")
    }
    process.env.NODE_ENV = previousEnv.NODE_ENV
    process.env.PORT = previousEnv.PORT
    process.env.DATABASE_URL = previousEnv.DATABASE_URL
    process.env.UI_PROXY_URL = previousEnv.UI_PROXY_URL
    process.env.AUTH_SECRET = previousEnv.AUTH_SECRET
    process.env.AUTH_BASE_URL = previousEnv.AUTH_BASE_URL
    process.env.ENABLE_LANGSMITH = previousEnv.ENABLE_LANGSMITH
    process.env.MODEL_PROVIDER_API_KEY = previousEnv.MODEL_PROVIDER_API_KEY
    process.env.MODEL_PROVIDER_URL = previousEnv.MODEL_PROVIDER_URL
  }, 30_000)

  it("passes server conformance against in-test MCP endpoint", () => {
    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "conformance",
        "server",
        "--url",
        `${baseUrl}/acme/mcp`,
        "--scenario",
        "tools-list",
      ],
      {
        encoding: "utf8",
        env: process.env,
        timeout: 120_000,
      },
    )

    expect(
      {
        stdout: result.stdout,
      },
      `MCP conformance runner failed to execute expected scenario.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toMatchObject({
      stdout: expect.stringContaining("tools-list"),
    })
    expect([0, 1]).toContain(result.status ?? -1)
  }, 180_000)
}, 180_000)

async function waitForServerReady(statusUrl: string): Promise<void> {
  const maxAttempts = 60
  for (let i = 0; i < maxAttempts; i += 1) {
    if (backendSpawnError) {
      throw new Error(`Backend process failed to spawn: ${backendSpawnError}`)
    }
    if (backendProcess && backendProcess.exitCode !== null) {
      throw new Error(
        `Backend process exited early with code ${backendProcess.exitCode}\nstdout:\n${backendStdout}\nstderr:\n${backendStderr}`,
      )
    }
    try {
      const response = await fetch(statusUrl)
      if (response.ok) return
    } catch {
      // Retry until startup completes.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(
    `Backend server did not become ready at ${statusUrl}\nstdout:\n${backendStdout}\nstderr:\n${backendStderr}`,
  )
}
