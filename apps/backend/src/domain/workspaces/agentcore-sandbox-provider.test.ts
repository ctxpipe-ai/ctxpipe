import { createServer } from "node:http"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  listen,
  RUNTIME_ARN,
  startFakeAgentCore,
} from "../../test/agentcore-fake.js"
import {
  agentCoreRuntime,
  agentCoreSandboxProvider,
} from "./agentcore-sandbox-provider.js"

let fake: Awaited<ReturnType<typeof startFakeAgentCore>>
let provider: ReturnType<typeof agentCoreSandboxProvider>
let root = ""

beforeAll(async () => {
  fake = await startFakeAgentCore("production")
  provider = agentCoreSandboxProvider({
    runtime: fake.runtime,
    paths: fake.paths,
  })
  root = join(fake.paths.workdir, "..")
})
afterAll(() => fake.close())

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

  it("keeps env values, scripts and file content out of the command text, which AgentCore logs", async () => {
    const handle = await provider.create({
      env: { HTTPS_PROXY: "https://session-secret@vault:14322" },
    })
    await handle.env.set({ OPENCODE_SERVER_PASSWORD: "turn-password" })
    await handle.fs.write("notes.md", "repository content")
    const result = await handle.process.exec(
      'echo "$HTTPS_PROXY $OPENCODE_SERVER_PASSWORD $(cat notes.md) inline-script-text"',
    )
    expect(result.stdout).toBe(
      "https://session-secret@vault:14322 turn-password repository content inline-script-text\n",
    )
    const logged = fake.commandTexts.join("\n")
    for (const value of [
      "session-secret",
      "turn-password",
      "repository content",
      "inline-script-text",
    ])
      expect(logged).not.toContain(value)
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
      `kill -0 -${server.pid} 2>/dev/null && echo alive || echo gone`,
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

  it("makes no call for a kill or an abort after a command finished, so a stopped session stays stopped", async () => {
    const handle = await provider.create({})
    const controller = new AbortController()
    const job = await handle.process.spawn("true", {
      signal: controller.signal,
    })
    expect(await job.wait()).toBe(0)
    await provider.destroy({ id: handle.id })
    const calls = fake.calls.length
    await job.kill("SIGKILL")
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(fake.calls.length).toBe(calls)
    expect(fake.running.has(handle.id)).toBe(false)
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

      // A stopped session's port is gone, so no request starts a new microVM.
      await provider.destroy({ id: handle.id })
      expect((await fetch(`${channel.url}/session`)).status).toBe(404)

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
