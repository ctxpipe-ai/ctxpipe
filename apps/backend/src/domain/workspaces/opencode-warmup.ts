import type { SandboxHandle, SandboxProvider } from "@tanstack/ai-sandbox"

import { log } from "../../observability/logger.js"
import { markSandboxLifecycle } from "./sandbox-lifecycle-timing.js"
import { WORKSPACE_CHAT_OPENCODE_START_ENV } from "./workspace-chat-opencode-contract.js"

/**
 * The first OpenCode start in a new AgentCore session is slow (CTX-1322).
 * On production, 9 to 20 s passed from `opencode serve` to the first model
 * call, and in the same image on a local disk 1.2 s. The difference is the
 * session's first read of the 211 MB OpenCode binary and its files. The
 * warm-up does that work before the turn: it starts OpenCode once and sends
 * one prompt to a stand-in model in the same process. Then the turn's
 * OpenCode finds its files in memory.
 *
 * The warm-up holds no credential and no egress. It removes the proxy
 * variables and the OpenCode password from its environment, it uses its own
 * home and folder (never `/workspace`, which the clone fills) and removes
 * them at the end, and its
 * OpenCode and stand-in model listen only on loopback. It stops itself after
 * the prompt, or after 60 s.
 */
const WARMUP_SCRIPT = `
const { spawn } = require("node:child_process")
const { mkdirSync, rmSync, writeFileSync } = require("node:fs")
const http = require("node:http")
const home = "/tmp/ctxpipe-opencode-warmup/" + process.pid
const chunk = (delta, finish) => "data: " + JSON.stringify({ id: "w", object: "chat.completion.chunk", created: 0, model: "w", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\\n\\n"
const model = http.createServer((req, res) => {
  req.resume()
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(chunk({ role: "assistant", content: "ok" }, null) + chunk({}, "stop") + "data: [DONE]\\n\\n")
  })
})
model.listen(0, "127.0.0.1", () => {
  for (const dir of ["config", "data", "state", "cache", "project"]) mkdirSync(home + "/" + dir, { recursive: true })
  writeFileSync(home + "/opencode.json", JSON.stringify({
    enabled_providers: ["warmup"],
    provider: { warmup: { npm: "@ai-sdk/openai-compatible", name: "warmup", options: { baseURL: "http://127.0.0.1:" + model.address().port + "/v1", apiKey: "none" }, models: { w: { name: "w" } } } },
    model: "warmup/w",
    snapshot: false,
    agent: { title: { disable: true } },
  }))
  const env = { ...process.env, ...START_ENV, HOME: home, XDG_CONFIG_HOME: home + "/config", XDG_DATA_HOME: home + "/data", XDG_STATE_HOME: home + "/state", XDG_CACHE_HOME: home + "/cache", OPENCODE_CONFIG: home + "/opencode.json" }
  for (const name of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(name) || name === "OPENCODE_SERVER_PASSWORD") delete env[name]
  const server = spawn("opencode", ["serve", "--hostname=127.0.0.1", "--port=0"], { cwd: home + "/project", env, stdio: ["ignore", "pipe", "ignore"] })
  const stop = (code) => {
    server.kill("SIGKILL")
    rmSync(home, { recursive: true, force: true })
    process.exit(code)
  }
  setTimeout(() => stop(2), 60000)
  server.on("exit", () => stop(3))
  server.on("error", () => stop(6))
  let out = ""
  let started = false
  server.stdout.on("data", async (data) => {
    out += data
    const url = /listening on (http:\\/\\/[^\\s]+)/.exec(out)?.[1]
    if (!url || started) return
    started = true
    try {
      const post = (path, body) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      const session = await (await post("/session", {})).json()
      const reply = await post("/session/" + session.id + "/message", { parts: [{ type: "text", text: "warm-up" }] })
      stop(reply.ok ? 0 : 4)
    } catch {
      stop(5)
    }
  })
})
`

/** The shell command of the warm-up; its exit code says how it ended. */
export const OPENCODE_WARMUP_COMMAND = `node -e '${WARMUP_SCRIPT.replace(
  "START_ENV",
  JSON.stringify(WORKSPACE_CHAT_OPENCODE_START_ENV),
)}' >/dev/null 2>&1`

/** The warm-ups that still run, by sandbox id. */
const running = new Map<string, Promise<void>>()

/**
 * Run the warm-up in the sandbox. It never throws: a failed warm-up only
 * leaves the turn's OpenCode start slow.
 */
export function warmOpencode(handle: SandboxHandle): Promise<void> {
  const started = Date.now()
  const done = (async () => {
    let exitCode: number | undefined
    try {
      exitCode = await (
        await handle.process.spawn(OPENCODE_WARMUP_COMMAND)
      ).wait()
    } catch (error) {
      log.warn({
        step: "opencode-warmup",
        message: `The OpenCode warm-up failed: ${String(error)}`,
        sandboxId: handle.id,
      })
    } finally {
      running.delete(handle.id)
      markSandboxLifecycle("opencode-warmup", {
        exitCode,
        ms: Date.now() - started,
      })
    }
  })()
  running.set(handle.id, done)
  return done
}

/**
 * Wait for the warm-up of the sandbox, if one still runs. The turn calls
 * this before it stops the agent user's processes, which would stop the
 * warm-up too.
 */
export async function opencodeWarmupDone(sandboxId: string): Promise<void> {
  const warmup = running.get(sandboxId)
  if (!warmup) return
  // The warm-up stops itself after 60 s; a command stream that hangs does
  // not hold the turn longer than 30 s.
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    warmup,
    new Promise((resolve) => {
      timer = setTimeout(resolve, 30_000)
    }),
  ])
  clearTimeout(timer)
}

/**
 * A new session starts its warm-up at once, so the warm-up runs while the
 * stock bootstrap clones. A resumed session already ran OpenCode.
 */
export function withOpencodeWarmup(provider: SandboxProvider): SandboxProvider {
  return {
    name: provider.name,
    capabilities: () => provider.capabilities(),
    create: async (options) => {
      const handle = await provider.create(options)
      void warmOpencode(handle)
      return handle
    },
    resume: (input) => provider.resume(input),
    destroy: (input) => provider.destroy(input),
  }
}
