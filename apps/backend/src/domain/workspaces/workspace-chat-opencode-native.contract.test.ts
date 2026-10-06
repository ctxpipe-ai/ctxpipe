import { execFileSync, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chat } from "@tanstack/ai"
import {
  opencodeText,
  type SandboxOpencodeServer,
  startOpencodeServerInSandbox,
  startOpencodeSession,
} from "@tanstack/ai-opencode"
import {
  defineSandbox,
  type SandboxProvider,
  withSandbox,
} from "@tanstack/ai-sandbox"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { expect, it, vi } from "vitest"
import { timedSandboxProvider } from "./sandbox-lifecycle-timing.js"
import { conversationSandboxProvider } from "./tanstack-workspace-chat.js"

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

it(
  "escalates a TERM-resistant OpenCode wrapper during server disposal",
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctxpipe-opencode-kill-"))
    const bin = join(directory, "bin")
    await mkdir(bin)
    const portProbe = createServer()
    await new Promise<void>((resolve, reject) => {
      portProbe.once("error", reject)
      portProbe.listen(0, "127.0.0.1", () => resolve())
    })
    const address = portProbe.address()
    if (!address || typeof address === "string")
      throw new Error("Could not reserve a local OpenCode port")
    const port = address.port
    await new Promise<void>((resolve, reject) =>
      portProbe.close((error) => (error ? reject(error) : resolve())),
    )
    const realOpenCode = execFileSync("sh", ["-c", "command -v opencode"], {
      encoding: "utf8",
    }).trim()
    const shellQuote = (value: string): string =>
      `'${value.replaceAll("'", "'\\''")}'`
    await writeFile(
      join(bin, "opencode"),
      `#!/bin/sh
set -eu
trap ':' TERM INT
${shellQuote(realOpenCode)} "$@" & server=$!
${shellQuote(process.execPath)} -e 'process.on("SIGTERM",()=>{}); process.on("SIGINT",()=>{}); setInterval(()=>{},1000)' & keeper=$!
while kill -0 "$server" 2>/dev/null; do sleep 0.05; done
wait "$keeper"
`,
      { mode: 0o755 },
    )
    const sandbox = await localProcessSandbox({
      dir: directory,
      removeOnDestroy: true,
    }).create({
      id: directory,
      workspace: { source: { type: "none" } },
    })
    let server: SandboxOpencodeServer | undefined
    let primaryError: unknown
    const cleanupErrors: unknown[] = []
    try {
      await sandbox.env.set({
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        XDG_DATA_HOME: join(directory, "data"),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["synthetic"],
          provider: {
            synthetic: {
              npm: "@ai-sdk/openai-compatible",
              name: "synthetic",
              options: {
                baseURL: "http://127.0.0.1:9",
                apiKey: "synthetic-test-key",
              },
              models: { probe: { name: "probe" } },
            },
          },
        }),
      })
      server = await startOpencodeServerInSandbox(sandbox, {
        port,
        hostname: "127.0.0.1",
        cwd: ".",
      })
      const healthUrl = `${server.baseUrl}/global/health`
      const health = await fetch(healthUrl)
      expect(health.status).toBe(200)
      const startedAt = Date.now()
      await server.dispose()
      expect(Date.now() - startedAt).toBeLessThan(9_000)
      await expect(fetch(healthUrl)).rejects.toThrow()
      server = undefined
    } catch (error) {
      primaryError = error
    }
    if (server) {
      try {
        await server.dispose()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      await sandbox.destroy()
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      await rm(directory, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (primaryError && cleanupErrors.length)
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "OpenCode TERM escalation and cleanup failed",
      )
    if (primaryError) throw primaryError
    if (cleanupErrors.length)
      throw new AggregateError(
        cleanupErrors,
        "OpenCode TERM escalation cleanup failed",
      )
  },
)

it.each(["startup", "completion"] as const)(
  "waits for OpenCode SSE at %s",
  { timeout: 60_000 },
  async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "ctxpipe-opencode-sse-"))
    const sandbox = await localProcessSandbox({
      dir: directory,
      removeOnDestroy: true,
    }).create({
      id: directory,
      workspace: { source: { type: "none" } },
    })
    let server: SandboxOpencodeServer | undefined
    let session: Awaited<ReturnType<typeof startOpencodeSession>> | undefined
    let proxy: ReturnType<typeof createServer> | undefined
    const modelCompleted = deferred<void>()
    const promptResponseCompleted = deferred<void>()
    const model = createServer((request, response) => {
      if (request.url !== "/model/v1/chat/completions") {
        response.writeHead(404)
        response.end()
        return
      }
      const body: Buffer[] = []
      request.on("data", (chunk: Buffer) => body.push(chunk))
      request.on("end", () => {
        void body
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end(
          [
            {
              id: "native-sse-proof",
              object: "chat.completion.chunk",
              created: 1,
              model: "probe",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: "Native reply completed.",
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "native-sse-proof",
              object: "chat.completion.chunk",
              created: 1,
              model: "probe",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
          ]
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
            .concat("data: [DONE]\n\n")
            .join(""),
        )
        modelCompleted.resolve()
      })
    })
    const handshakeObserved = deferred<void>()
    const handshakeRelease = deferred<void>()
    const eventsRelease = deferred<void>()
    const assistantEventObserved = deferred<void>()
    const connectedEventObserved = deferred<void>()
    let eventResponse: import("node:http").ServerResponse | undefined
    let eventHeadersSent = false
    let eventsReleased = false
    let eventEnded = false
    const initialEventChunks: Buffer[] = []
    const heldEventChunks: Buffer[] = []
    const flushEventChunks = (): void => {
      if (!eventResponse || !eventHeadersSent) return
      for (const chunk of initialEventChunks) eventResponse.write(chunk)
      initialEventChunks.length = 0
      if (!eventsReleased) return
      for (const chunk of heldEventChunks) eventResponse.write(chunk)
      heldEventChunks.length = 0
      if (eventEnded) eventResponse.end()
    }
    void eventsRelease.promise.then(() => {
      eventsReleased = true
      flushEventChunks()
    })
    const failures: unknown[] = []
    let primaryError: unknown
    try {
      await new Promise<void>((resolve, reject) => {
        model.once("error", reject)
        model.listen(0, "127.0.0.1", () => resolve())
      })
      const modelAddress = model.address()
      if (!modelAddress || typeof modelAddress === "string")
        throw new Error("model fixture did not bind")
      await sandbox.env.set({
        XDG_DATA_HOME: join(directory, "data"),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["synthetic"],
          provider: {
            synthetic: {
              npm: "@ai-sdk/openai-compatible",
              name: "synthetic",
              options: {
                baseURL: `http://127.0.0.1:${modelAddress.port}/model/v1`,
                apiKey: "synthetic-test-key",
              },
              models: { probe: { name: "probe" } },
            },
          },
        }),
      })
      // Production picks a free loopback port for unsandboxed OpenCode.
      server = await startOpencodeServerInSandbox(sandbox, {
        port: await freeLoopbackPort(),
        hostname: "127.0.0.1",
        cwd: ".",
      })
      const upstream = new URL(server.baseUrl)
      proxy = createServer((request, response) => {
        const upstreamRequest = httpRequest(
          {
            hostname: upstream.hostname,
            port: Number(upstream.port),
            path: request.url,
            method: request.method,
            headers: request.headers,
          },
          (upstreamResponse) => {
            if (!request.url?.startsWith("/event")) {
              const isPrompt =
                request.method === "POST" && request.url?.endsWith("/message")
              if (isPrompt)
                upstreamResponse.once("end", () =>
                  promptResponseCompleted.resolve(),
                )
              response.writeHead(
                upstreamResponse.statusCode ?? 502,
                upstreamResponse.headers,
              )
              upstreamResponse.pipe(response)
              return
            }
            eventResponse = response
            let firstEvent = Buffer.alloc(0)
            let firstEventSent = false
            upstreamResponse.on("data", (chunk: Buffer) => {
              if (!firstEventSent) {
                firstEvent = Buffer.concat([firstEvent, chunk])
                const boundary = firstEvent.indexOf("\n\n")
                if (boundary < 0) return
                initialEventChunks.push(firstEvent.subarray(0, boundary + 2))
                firstEvent = firstEvent.subarray(boundary + 2)
                if (firstEvent.length > 0) heldEventChunks.push(firstEvent)
                firstEventSent = true
                handshakeObserved.resolve()
                flushEventChunks()
                return
              }
              heldEventChunks.push(chunk)
              flushEventChunks()
            })
            upstreamResponse.on("end", () => {
              eventEnded = true
              flushEventChunks()
            })
            void handshakeRelease.promise.then(() => {
              if (eventHeadersSent) return
              eventHeadersSent = true
              const headers = { ...upstreamResponse.headers }
              delete headers["content-length"]
              response.writeHead(upstreamResponse.statusCode ?? 502, headers)
              flushEventChunks()
            })
          },
        )
        upstreamRequest.on("error", (error) => response.destroy(error))
        request.pipe(upstreamRequest)
      })
      await new Promise<void>((resolve, reject) => {
        proxy?.once("error", reject)
        proxy?.listen(0, "127.0.0.1", () => resolve())
      })
      const proxyAddress = proxy.address()
      if (!proxyAddress || typeof proxyAddress === "string")
        throw new Error("event proxy did not bind")
      const eventTypes: string[] = []
      const startup = startOpencodeSession({
        baseUrl: `http://127.0.0.1:${proxyAddress.port}`,
        providerID: "synthetic",
        modelID: "probe",
        onEvent: (event) => {
          eventTypes.push(event.type)
          if (eventTypes.at(-1) === "server.connected")
            connectedEventObserved.resolve()
          if (
            event.type === "message.part.updated" &&
            event.properties.part.type === "text" &&
            "text" in event.properties.part &&
            event.properties.part.text === "Native reply completed."
          )
            assistantEventObserved.resolve()
        },
        onPermissionRequest: () => "reject",
      })
      let startupSettled = false
      void startup.then(
        (value) => {
          session = value
          startupSettled = true
        },
        () => {
          startupSettled = true
        },
      )
      await handshakeObserved.promise
      if (phase === "startup") expect(startupSettled).toBe(false)
      handshakeRelease.resolve()
      session = await startup
      await connectedEventObserved.promise
      expect(eventTypes[0]).toBe("server.connected")

      if (phase === "completion") {
        const prompt = session.prompt("return the fixture reply")
        await Promise.all([
          modelCompleted.promise,
          promptResponseCompleted.promise,
        ])
        const promptSettledBeforeEvents = await Promise.race([
          prompt.then(
            () => true,
            () => true,
          ),
          new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(false), 250)
          }),
        ])
        expect(promptSettledBeforeEvents).toBe(false)
        eventsRelease.resolve()
        await assistantEventObserved.promise
        await expect(prompt).resolves.toMatchObject({
          text: "Native reply completed.",
        })
      }
    } catch (error) {
      primaryError = error
      handshakeRelease.resolve()
      eventsRelease.resolve()
    }
    handshakeRelease.resolve()
    eventsRelease.resolve()
    const cleanup: PromiseSettledResult<void>[] = []
    const clean = async (operation: Promise<void>): Promise<void> => {
      try {
        await operation
        cleanup.push({ status: "fulfilled", value: undefined })
      } catch (reason) {
        cleanup.push({ status: "rejected", reason })
      }
    }
    if (session) await clean(session.dispose())
    if (server) await clean(server.dispose())
    if (proxy)
      await clean(
        new Promise<void>((resolve, reject) => {
          proxy?.closeAllConnections()
          proxy?.close((error) => (error ? reject(error) : resolve()))
        }),
      )
    await clean(
      new Promise<void>((resolve, reject) => {
        model.close((error) => (error ? reject(error) : resolve()))
        model.closeAllConnections()
      }),
    )
    await clean(sandbox.destroy())
    await clean(rm(directory, { recursive: true, force: true }))
    if (primaryError !== undefined) failures.push(primaryError)
    for (const result of cleanup)
      if (result.status === "rejected") failures.push(result.reason)
    if (failures.length)
      throw new AggregateError(failures, "Native OpenCode SSE proof failed", {
        cause: primaryError,
      })
  },
)

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (!address || typeof address === "string") {
        probe.close()
        reject(new Error("free port probe did not bind"))
        return
      }
      probe.close(() => resolve(address.port))
    })
  })
}

/**
 * A fake `opencode` that outlives SIGTERM and keeps an unfinished request
 * open on the tool bridge, as a live MCP stream does. It appends its pid to
 * `pidFile` and answers one prompt.
 */
async function writeStubbornOpencode(bin: string, pidFile: string) {
  await mkdir(bin, { recursive: true })
  await writeFile(
    join(bin, "opencode"),
    `#!${process.execPath}
const http = require("node:http")
process.on("SIGTERM", () => {})
require("node:fs").appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n")
const port = Number(process.argv.find((arg) => arg.startsWith("--port=")).slice(7))
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}")
const bridge = Object.values(config.mcp || {})[0]
const sessionID = "ses_fixture"
const streams = []
const send = (event) => {
  for (const stream of streams) stream.write("data: " + JSON.stringify(event) + "\\n\\n")
}
const json = (res, body) => {
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}
http
  .createServer((req, res) => {
    const path = new URL(req.url, "http://fixture").pathname
    if (path === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" })
      streams.push(res)
      send({ type: "server.connected", properties: {} })
      return
    }
    if (req.method === "POST" && path === "/session") return json(res, { id: sessionID })
    if (req.method === "POST" && path === "/session/" + sessionID + "/message") {
      req.resume()
      req.on("end", () => {
        const info = { id: "msg_fixture", sessionID, role: "assistant", time: { created: Date.now(), completed: Date.now() } }
        const part = { id: "prt_fixture", messageID: info.id, sessionID, type: "text", text: "Turn complete." }
        send({ type: "message.updated", properties: { info } })
        send({ type: "message.part.updated", properties: { part } })
        json(res, { info, parts: [part] })
      })
      return
    }
    json(res, true)
  })
  .listen(port, "127.0.0.1", () => {
    if (bridge) {
      const held = http.request(bridge.url, {
        method: "POST",
        headers: { ...bridge.headers, "content-type": "application/json", "content-length": "1000" },
      })
      held.on("error", () => {})
      held.write("{")
    }
    console.log("opencode server listening on http://127.0.0.1:" + port)
  })
setInterval(() => {}, 1000)
`,
    { mode: 0o755 },
  )
}

async function readPids(pidFile: string): Promise<number[]> {
  const text = await readFile(pidFile, "utf8").catch(() => "")
  return text.split("\n").filter(Boolean).map(Number)
}

/**
 * One chat turn through the unsandboxed product provider. `wrap` lets a test
 * put a provider of its own between the product provider and the engine.
 */
async function runFixtureTurn(input: {
  directory: string
  wrap?: (provider: SandboxProvider) => SandboxProvider
}): Promise<{
  types: string[]
  textEndedAt?: number
  finishedAt?: number
}> {
  const provider = conversationSandboxProvider(
    "unsandboxed",
    `opencode-finish-${Date.now()}`,
  )
  const abortController = new AbortController()
  const result: { types: string[]; textEndedAt?: number; finishedAt?: number } =
    { types: [] }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const stream = chat({
      adapter: opencodeText("fixture/model", {
        hostname: "127.0.0.1",
        port: await freeLoopbackPort(),
      }),
      threadId: `opencode-finish-${Date.now()}`,
      messages: [{ role: "user", content: "Finish the turn." }],
      abortController,
      tools: [
        {
          name: "fixture_tool",
          description: "Bridged so that the run opens a tool bridge.",
          inputSchema: { type: "object", properties: {} },
          execute: async () => "unused",
        },
      ],
      middleware: [
        withSandbox(
          defineSandbox({
            id: "opencode-finish",
            provider: timedSandboxProvider(
              input.wrap ? input.wrap(provider) : provider,
            ),
            workspace: { source: { type: "none" } },
            lifecycle: {
              reuse: "thread",
              snapshot: "none",
              destroyOnComplete: false,
            },
          }),
        ),
      ],
    })
    const consumed = (async () => {
      for await (const chunk of stream) {
        result.types.push(chunk.type)
        if (chunk.type === "TEXT_MESSAGE_END") result.textEndedAt = Date.now()
        if (chunk.type === "RUN_FINISHED") result.finishedAt = Date.now()
      }
    })()
    consumed.catch(() => undefined)
    await Promise.race([
      consumed,
      new Promise((resolve) => {
        timer = setTimeout(resolve, 10_000)
      }),
    ])
    return result
  } finally {
    clearTimeout(timer)
    abortController.abort()
  }
}

it(
  "finishes a turn and stops its OpenCode server when the server ignores SIGTERM and holds the tool bridge open",
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctxpipe-opencode-finish-"))
    const pidFile = join(directory, "opencode.pids")
    await writeStubbornOpencode(join(directory, "bin"), pidFile)
    vi.stubEnv("PATH", `${join(directory, "bin")}:${process.env.PATH ?? ""}`)
    try {
      const turn = await runFixtureTurn({ directory })
      expect(turn.types).toContain("TEXT_MESSAGE_END")
      expect(turn.types).toContain("RUN_FINISHED")
      expect(turn.types).not.toContain("RUN_ERROR")
      expect(
        (turn.finishedAt ?? Number.POSITIVE_INFINITY) - (turn.textEndedAt ?? 0),
      ).toBeLessThan(5_000)
      const pids = await readPids(pidFile)
      expect(pids).toHaveLength(1)
      expect(pids.filter(processIsRunning)).toEqual([])
    } finally {
      vi.unstubAllEnvs()
      await killAll(await readPids(pidFile))
      await rm(directory, { recursive: true, force: true })
    }
  },
)

it(
  "finishes a turn when the sandbox never settles the OpenCode server kill",
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctxpipe-opencode-hang-"))
    const pidFile = join(directory, "opencode.pids")
    await writeStubbornOpencode(join(directory, "bin"), pidFile)
    vi.stubEnv("PATH", `${join(directory, "bin")}:${process.env.PATH ?? ""}`)
    // A provider whose kill never settles and never stops the process, as a
    // sandbox API call that never returns would do.
    const neverKill = (provider: SandboxProvider): SandboxProvider => ({
      name: provider.name,
      capabilities: () => provider.capabilities(),
      create: async (options) => {
        const handle = await provider.create(options)
        return {
          ...handle,
          process: {
            ...handle.process,
            spawn: async (command, options) => ({
              ...(await handle.process.spawn(command, options)),
              kill: () => new Promise<void>(() => undefined),
            }),
          },
        }
      },
      resume: (options) => provider.resume(options),
      destroy: (options) => provider.destroy(options),
    })
    try {
      const turn = await runFixtureTurn({ directory, wrap: neverKill })
      expect(turn.types).toContain("TEXT_MESSAGE_END")
      expect(turn.types).toContain("RUN_FINISHED")
      expect(
        (turn.finishedAt ?? Number.POSITIVE_INFINITY) - (turn.textEndedAt ?? 0),
      ).toBeLessThan(5_000)
    } finally {
      vi.unstubAllEnvs()
      await killAll(await readPids(pidFile))
      await rm(directory, { recursive: true, force: true })
    }
  },
)

it(
  "stops the unsandboxed OpenCode servers when the process that started them dies, also after its watchdog died",
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctxpipe-opencode-owner-"))
    const bin = join(directory, "bin")
    const pidFile = join(directory, "opencode.pids")
    await writeStubbornOpencode(bin, pidFile)
    // The owner is a real Node process. It starts a server in an unsandboxed
    // conversation sandbox for each "start" line, and then it dies without a
    // teardown.
    const owner = spawn(
      join(process.cwd(), "node_modules/.bin/tsx"),
      [
        "--input-type=module",
        "-e",
        `
import { createInterface } from "node:readline"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { startOpencodeServerInSandbox } from "@tanstack/ai-opencode"
import { withOwnerWatchdog } from ${JSON.stringify(join(import.meta.dirname, "sandbox-process-guards.ts"))}
const sandbox = await withOwnerWatchdog(localProcessSandbox({ dir: ${JSON.stringify(directory)} })).create({
  id: ${JSON.stringify(directory)},
  workspace: { source: { type: "none" } },
})
await sandbox.env.set({ PATH: ${JSON.stringify(bin)} + ":" + process.env.PATH })
let port = 40000 + Math.floor(Math.random() * 20000)
for await (const line of createInterface({ input: process.stdin })) {
  await startOpencodeServerInSandbox(sandbox, { port: port++, hostname: "127.0.0.1", cwd: "." })
  console.log("started " + process.pid)
}
`,
      ],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "inherit"] },
    )
    // tsx runs the script in a child process; that process is the owner.
    const started = async () =>
      new Promise<number>((resolve, reject) => {
        const onData = (data: Buffer) => {
          const match = /started (\d+)/.exec(data.toString())
          if (!match) return
          owner.stdout.off("data", onData)
          resolve(Number(match[1]))
        }
        owner.stdout.on("data", onData)
        owner.once("exit", (code) =>
          reject(new Error(`The owner process stopped early with ${code}`)),
        )
      })
    let ownerPid = 0
    try {
      owner.stdin.write("start\n")
      ownerPid = await started()
      // Kill the owner's watchdog. The next process must get a new one that
      // also watches the first server.
      const watchdog = execFileSync(
        "pgrep",
        ["-P", String(ownerPid), "-f", "while read"],
        { encoding: "utf8" },
      ).trim()
      expect(watchdog).not.toBe("")
      process.kill(Number(watchdog), "SIGKILL")
      await new Promise((resolve) => setTimeout(resolve, 200))
      owner.stdin.write("start\n")
      await started()
      const pids = await readPids(pidFile)
      expect(pids).toHaveLength(2)
      for (const pid of pids) expect(processIsRunning(pid)).toBe(true)
      process.kill(ownerPid, "SIGKILL")
      const deadline = Date.now() + 5_000
      while (pids.some(processIsRunning) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(pids.filter(processIsRunning)).toEqual([])
    } finally {
      owner.kill("SIGKILL")
      await killAll([ownerPid])
      await killAll(await readPids(pidFile))
      await rm(directory, { recursive: true, force: true })
    }
  },
)

async function killAll(pids: number[]): Promise<void> {
  for (const pid of pids)
    if (processIsRunning(pid)) process.kill(pid, "SIGKILL")
}

function processIsRunning(pid: number): boolean {
  // Pid 0 and negative pids name process groups, not one process.
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
