import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type Server,
} from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore"
import { EventStreamCodec } from "@smithy/eventstream-codec"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  type AgentCoreRuntime,
  agentCoreRuntime,
  agentCoreSandboxProvider,
} from "./agentcore-sandbox-provider.js"

const RUNTIME_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/ctxpipe_test-abc123"
const SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id"

const codec = new EventStreamCodec(
  (bytes) => new TextDecoder().decode(bytes),
  (text) => new TextEncoder().encode(text),
)

/** One event-stream message as AgentCore sends it. */
function message(
  headers: Record<string, string>,
  body: unknown,
): Uint8Array<ArrayBuffer> {
  return codec.encode({
    headers: Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        { type: "string" as const, value },
      ]),
    ),
    body: new TextEncoder().encode(JSON.stringify(body)),
  }) as Uint8Array<ArrayBuffer>
}

const chunk = (body: unknown) =>
  message(
    {
      ":message-type": "event",
      ":event-type": "chunk",
      ":content-type": "application/json",
    },
    body,
  )

/**
 * A fake AgentCore endpoint on loopback, with one fake microVM whose files
 * are in `root`. A call to a session that is not running starts a new
 * microVM with empty folders, as AgentCore does. It is a real HTTP server,
 * not msw: msw does not close the answer when the caller closes the
 * connection, and the port bridge depends on that close.
 */
function fakeAgentCore(root: string, shimPort: () => number) {
  const running = new Set<string>()
  const calls: { api: string; sessionId: string; qualifier: string | null }[] =
    []
  let failNext: "platform" | "exception" | undefined
  const freshMicroVm = (sessionId: string) => {
    if (running.has(sessionId)) return
    rmSync(join(root, "state"), { recursive: true, force: true })
    rmSync(join(root, "workspace"), { recursive: true, force: true })
    mkdirSync(join(root, "workspace"), { recursive: true })
    running.add(sessionId)
  }
  const readBody = async (request: IncomingMessage) => {
    const chunks: Buffer[] = []
    for await (const part of request) chunks.push(part as Buffer)
    return Buffer.concat(chunks)
  }
  const server = createServer((request, response) => {
    void (async () => {
      const sessionId = String(request.headers[SESSION_HEADER] ?? "")
      const url = new URL(request.url ?? "/", "http://agentcore")
      const api = url.pathname.split("/").at(-1) ?? ""
      const body = await readBody(request)
      calls.push({
        api,
        sessionId,
        qualifier: url.searchParams.get("qualifier"),
      })
      if (api === "stopruntimesession") {
        if (!running.delete(sessionId)) {
          response.writeHead(404, {
            "content-type": "application/json",
            "x-amzn-errortype": "ResourceNotFoundException",
          })
          response.end(JSON.stringify({ message: "No such session" }))
          return
        }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ runtimeSessionId: sessionId }))
        return
      }
      freshMicroVm(sessionId)
      if (api === "invocations") {
        // The microVM's port 8080: the real shim of the image.
        const upstream = httpRequest(
          {
            host: "127.0.0.1",
            port: shimPort(),
            method: "POST",
            path: "/invocations",
          },
          (answer) => {
            response.writeHead(200, { "content-type": "text/event-stream" })
            answer.pipe(response)
          },
        )
        response.on("close", () => upstream.destroy())
        upstream.end(body)
        return
      }
      const { command } = JSON.parse(body.toString()) as { command: string }
      response.writeHead(200, {
        "content-type": "application/vnd.amazon.eventstream",
      })
      response.write(chunk({ contentStart: {} }))
      const fail = failNext
      failNext = undefined
      if (fail === "exception") {
        response.end(
          message(
            {
              ":message-type": "exception",
              ":exception-type": "validationException",
              ":content-type": "application/json",
            },
            { message: "The command is too long" },
          ),
        )
        return
      }
      if (fail === "platform") {
        response.end(
          chunk({ contentStop: { exitCode: -1, status: "COMPLETED" } }),
        )
        return
      }
      // AgentCore runs the command text with a shell.
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: join(root, "workspace"),
      })
      child.stdout.on("data", (data: Buffer) =>
        response.write(chunk({ contentDelta: { stdout: data.toString() } })),
      )
      child.stderr.on("data", (data: Buffer) =>
        response.write(chunk({ contentDelta: { stderr: data.toString() } })),
      )
      child.on("close", (code) =>
        response.end(
          chunk({
            contentStop: { exitCode: code ?? 137, status: "COMPLETED" },
          }),
        ),
      )
    })()
  })
  return {
    server,
    calls,
    running,
    failNextCommand: (kind: "platform" | "exception") => (failNext = kind),
  }
}

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve(typeof address === "object" && address ? address.port : 0)
    }),
  )

const root = mkdtempSync(join(tmpdir(), "agentcore-fake-"))
let shim: Server
let shimPort = 0
const fake = fakeAgentCore(root, () => shimPort)
let runtime: AgentCoreRuntime
let provider: ReturnType<typeof agentCoreSandboxProvider>

beforeAll(async () => {
  // The shim is a plain ESM file of the sandbox image.
  const shimFile = new URL(
    "../../../../../scripts/chat-sandbox/agentcore-shim.mjs",
    import.meta.url,
  ).href
  const { shimServer } = (await import(shimFile)) as {
    shimServer: () => Server
  }
  shim = shimServer()
  shimPort = await listen(shim)
  runtime = {
    client: new BedrockAgentCoreClient({
      region: "us-west-2",
      endpoint: `http://127.0.0.1:${await listen(fake.server)}`,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      maxAttempts: 1,
    }),
    runtimeArn: RUNTIME_ARN,
    qualifier: "production",
  }
  provider = agentCoreSandboxProvider({
    runtime,
    paths: { state: join(root, "state"), workdir: join(root, "workspace") },
  })
})
afterAll(() => {
  shim.close()
  fake.server.close()
  rmSync(root, { recursive: true, force: true })
})

describe("agentCoreRuntime", () => {
  it("reads the runtime, its region and its endpoint from the environment", async () => {
    const found = agentCoreRuntime({
      AGENTCORE_RUNTIME_ARN: RUNTIME_ARN,
      AGENTCORE_RUNTIME_QUALIFIER: "production",
    })
    expect(found?.runtimeArn).toBe(RUNTIME_ARN)
    expect(found?.qualifier).toBe("production")
    expect(await found?.client.config.region()).toBe("us-west-2")
    expect(agentCoreRuntime({})).toBeUndefined()
    expect(() =>
      agentCoreRuntime({ AGENTCORE_RUNTIME_ARN: "runtime-1" }),
    ).toThrow("AGENTCORE_RUNTIME_ARN must be an AgentCore runtime ARN")
  })
})

describe("agentCoreSandboxProvider", () => {
  it("runs commands in the workspace with the create environment, through the runtime endpoint", async () => {
    const handle = await provider.create({
      env: { HTTPS_PROXY: "https://session:token@vault:14322", QUOTE: "it's" },
    })
    expect(handle.id).toMatch(/^ctxpipe-[0-9a-f]{32}$/)
    await handle.env.set({ OPENCODE_SERVER_PASSWORD: "pw" })
    const result = await handle.process.exec(
      'echo "$HTTPS_PROXY $QUOTE $OPENCODE_SERVER_PASSWORD $EXTRA"; pwd; echo oops >&2; exit 3',
      { env: { EXTRA: "per-command" } },
    )
    expect(result).toEqual({
      stdout: `https://session:token@vault:14322 it's pw per-command\n${join(root, "workspace")}\n`,
      stderr: "oops\n",
      exitCode: 3,
    })
    // Each call names the session and the runtime endpoint.
    const own = fake.calls.filter((call) => call.sessionId === handle.id)
    expect(own.length).toBeGreaterThan(1)
    expect(new Set(own.map((call) => call.qualifier))).toEqual(
      new Set(["production"]),
    )
    // The marker and the create environment are private to the agent user.
    const modes = await handle.process.exec(
      `stat -c %a ${join(root, "state")} 2>/dev/null || stat -f %Lp ${join(root, "state")}`,
    )
    expect(modes.stdout.trim()).toBe("700")
    await provider.destroy({ id: handle.id })
  })

  it("reads, writes and lists files, also a file larger than one command", async () => {
    const handle = await provider.create({})
    const large = `${"x".repeat(100_000)}\n'quoted' $HOME\n`
    await handle.fs.write("/workspace/dir/large.txt", large)
    expect(await handle.fs.read("/workspace/dir/large.txt")).toBe(large)
    await handle.fs.write("bytes.bin", new Uint8Array([0, 255, 10]))
    expect([...(await handle.fs.readBytes("bytes.bin"))]).toEqual([0, 255, 10])
    expect(await handle.fs.list("/workspace")).toEqual([
      { name: "bytes.bin", path: "/workspace/bytes.bin", type: "file" },
      { name: "dir", path: "/workspace/dir", type: "dir" },
    ])
    await handle.fs.rename("bytes.bin", "/workspace/dir/moved.bin")
    expect(await handle.fs.exists("bytes.bin")).toBe(false)
    expect(await handle.fs.exists("/workspace/dir/moved.bin")).toBe(true)
    await handle.fs.remove("/workspace/dir")
    expect(await handle.fs.exists("/workspace/dir")).toBe(false)
    await expect(handle.fs.read("missing.txt")).rejects.toThrow("read failed")
    await provider.destroy({ id: handle.id })
  })

  it("streams a background process and kills its process group", async () => {
    const handle = await provider.create({})
    const server = await handle.process.spawn(
      "echo opencode server listening; sh -c 'sleep 30' & sleep 30",
    )
    expect(server.pid).toBeGreaterThan(1)
    const first = await server.stdout[Symbol.asyncIterator]().next()
    expect(first.value).toBe("opencode server listening\n")
    await server.kill("SIGKILL")
    expect(await server.wait()).not.toBe(0)
    const left = await handle.process.exec(
      `kill -0 -- -${server.pid} 2>/dev/null && echo alive || echo gone`,
    )
    expect(left.stdout.trim()).toBe("gone")
    await provider.destroy({ id: handle.id })
  })

  it("stops a command when its signal aborts", async () => {
    const handle = await provider.create({})
    const controller = new AbortController()
    const running = handle.process.exec("sleep 30", {
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 200)
    await expect(running).rejects.toThrow()
    await provider.destroy({ id: handle.id })
  })

  it("resumes the same microVM, and gives null when AgentCore started a new one", async () => {
    const handle = await provider.create({})
    await handle.fs.write("kept.txt", "kept")
    const resumed = await provider.resume({ id: handle.id })
    expect(await resumed?.fs.read("kept.txt")).toBe("kept")

    // The session ended (idle timeout): the next call starts an empty microVM.
    await provider.destroy({ id: handle.id })
    expect(await provider.resume({ id: handle.id })).toBeNull()
    // The empty microVM that the check started is stopped again.
    expect(fake.running.has(handle.id)).toBe(false)
    // A session that is already gone counts as destroyed.
    await provider.destroy({ id: handle.id })
  })

  it("fails a command that AgentCore cannot run", async () => {
    const handle = await provider.create({})
    fake.failNextCommand("platform")
    await expect(handle.process.exec("true")).rejects.toThrow(
      "AgentCore could not run the command",
    )
    fake.failNextCommand("exception")
    await expect(handle.process.exec("true")).rejects.toThrow(
      "The command is too long",
    )
    await provider.destroy({ id: handle.id })
  })

  it("reaches a sandbox port through the shim and streams its answer", async () => {
    const handle = await provider.create({})
    let upstreamClosed = () => {}
    const closed = new Promise<void>((resolve) => (upstreamClosed = resolve))
    const upstream = createServer((request, response) => {
      if (request.url === "/event") {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write("data: one\n\n")
        request.on("close", upstreamClosed)
        return
      }
      let body = ""
      request.on("data", (data: Buffer) => (body += data.toString()))
      request.on("end", () => {
        response.writeHead(201, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            method: request.method,
            url: request.url,
            authorization: request.headers.authorization,
            body,
          }),
        )
      })
    })
    const port = await listen(upstream)
    try {
      const channel = await handle.ports.connect(port)
      expect(channel.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}$/)
      const created = await fetch(`${channel.url}/session?directory=x`, {
        method: "POST",
        headers: { authorization: "Basic b3BlbmNvZGU6cHc=" },
        body: '{"title":"t"}',
      })
      expect(created.status).toBe(201)
      expect(await created.json()).toEqual({
        method: "POST",
        url: "/session?directory=x",
        authorization: "Basic b3BlbmNvZGU6cHc=",
        body: '{"title":"t"}',
      })

      // A long answer streams; closing it stops the request to the port.
      const controller = new AbortController()
      const events = await fetch(`${channel.url}/event`, {
        signal: controller.signal,
      })
      const reader = events.body?.getReader()
      if (!reader) throw new Error("The event stream has no body")
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        "data: one\n\n",
      )
      controller.abort()
      await closed

      // A wrong token reaches no session.
      const wrong = await fetch(
        channel.url.replace(/[0-9a-f]{48}$/, "0".repeat(48)),
      )
      expect(wrong.status).toBe(404)
    } finally {
      upstream.close()
      await provider.destroy({ id: handle.id })
    }
  })
})
