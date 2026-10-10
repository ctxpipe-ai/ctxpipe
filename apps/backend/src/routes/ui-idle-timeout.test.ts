import { type ChildProcess, spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { proxyUiRequest, UI_PROXY_TIMEOUT_MS } from "./ui.js"

// The UI image runs the Nitro `bun` preset. That entry passes
// `NITRO_BUN_IDLE_TIMEOUT` to Bun.serve; without it, Bun closes a silent
// request after 10 s (about 12 s in practice), before the 15 s proxy
// timeout.
async function uiImageIdleTimeout(): Promise<string | undefined> {
  const dockerfile = await readFile(
    fileURLToPath(new URL("../../../ui/Dockerfile", import.meta.url)),
    "utf8",
  )
  return /^ENV NITRO_BUN_IDLE_TIMEOUT=(\d+)$/m.exec(dockerfile)?.[1]
}

const children: ChildProcess[] = []
const directories: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGTERM")
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function startSlowUi(
  delayMs: number,
  idleTimeout: string | undefined,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ui-idle-"))
  directories.push(directory)
  const ready = join(directory, "ready.json")
  const env = { ...process.env }
  delete env.NITRO_BUN_IDLE_TIMEOUT
  if (idleTimeout) env.NITRO_BUN_IDLE_TIMEOUT = idleTimeout
  const child = spawn(
    "bun",
    [
      fileURLToPath(new URL("../test/slow-bun-server.ts", import.meta.url)),
      ready,
      String(delayMs),
    ],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  )
  children.push(child)
  let stderr = ""
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4000)
  })
  await expect
    .poll(
      async () => {
        if (child.exitCode !== null)
          throw new Error(stderr || "The slow UI exited before ready")
        return readFile(ready, "utf8").catch(() => "")
      },
      { timeout: 10_000 },
    )
    .not.toBe("")
  const { port } = JSON.parse(await readFile(ready, "utf8")) as {
    port: number
  }
  return `http://127.0.0.1:${port}`
}

const originTrust = { publicOrigin: "https://app.example.test" }
// Bun 1.4 closes a silent request about 12 s after it starts. This page is
// slower than that, but faster than the proxy timeout.
const slowPageMs = 13_500

describe("UI server idle timeout", () => {
  it("drops a page slower than the Bun default when Bun keeps its default idle timeout", async () => {
    const uiUrl = await startSlowUi(slowPageMs, undefined)
    const response = await proxyUiRequest(
      new Request("https://app.example.test/projects"),
      uiUrl,
      UI_PROXY_TIMEOUT_MS,
      originTrust,
    )
    expect(response.status).toBe(502)
  }, 30_000)

  it("serves a page slower than the Bun default with the idle timeout of the UI image", async () => {
    const idleTimeout = await uiImageIdleTimeout()
    expect(Number(idleTimeout) * 1000).toBeGreaterThan(UI_PROXY_TIMEOUT_MS)
    const uiUrl = await startSlowUi(slowPageMs, idleTimeout)
    const response = await proxyUiRequest(
      new Request("https://app.example.test/projects"),
      uiUrl,
      UI_PROXY_TIMEOUT_MS,
      originTrust,
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("<html>slow page</html>")
  }, 30_000)
})
