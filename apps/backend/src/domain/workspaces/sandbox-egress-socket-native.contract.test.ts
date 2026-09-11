import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http"
import {
  type AddressInfo,
  connect,
  createServer,
  type NetConnectOpts,
  type Server,
  type Socket,
} from "node:net"
import { networkInterfaces, tmpdir } from "node:os"
import { join } from "node:path"
import type { Readable } from "node:stream"
import { expect, it } from "vitest"

function reachableIpv4(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address
    }
  }
  throw new Error(
    "Native egress socket proof requires a non-loopback IPv4 address",
  )
}

function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, host, () =>
      resolve((server.address() as AddressInfo).port),
    )
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function freePort(host: string): Promise<number> {
  const server = createServer()
  const port = await listen(server, host)
  await close(server)
  return port
}

function waitForLine(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ""
    const cleanup = (): void => {
      stream.off("data", onData)
      stream.off("end", onEnd)
    }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString()
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      cleanup()
      resolve(buffer.slice(0, newline))
    }
    const onEnd = (): void => {
      cleanup()
      reject(new Error(`Native egress proxy ended before readiness: ${buffer}`))
    }
    stream.on("data", onData)
    stream.on("end", onEnd)
  })
}

function connectSocket(options: NetConnectOpts): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(options)
    socket.once("connect", () => resolve(socket))
    socket.once("error", reject)
  })
}

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname: "127.0.0.1", port, path, headers },
      (response) => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk) => (body += chunk))
        response.once("end", () =>
          resolve({ status: response.statusCode ?? 0, body }),
        )
        response.once("error", reject)
      },
    )
    request.setTimeout(15_000, () =>
      request.destroy(new Error("delayed egress request timed out")),
    )
    request.once("error", reject)
    request.end()
  })
}

async function controlRequest(
  path: string,
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const socket = await connectSocket({ path })
  return new Promise((resolve, reject) => {
    let text = ""
    const finish = (): void => {
      socket.off("data", onData)
      socket.off("error", onError)
      socket.off("close", onClose)
    }
    const onData = (chunk: Buffer): void => {
      text += chunk.toString()
      const newline = text.indexOf("\n")
      if (newline < 0) return
      finish()
      socket.end()
      try {
        resolve(JSON.parse(text.slice(0, newline)) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    }
    const onError = (error: Error): void => {
      finish()
      reject(error)
    }
    const onClose = (): void => {
      finish()
      reject(new Error(`Control socket closed before reply: ${text}`))
    }
    socket.on("data", onData)
    socket.once("error", onError)
    socket.once("close", onClose)
    socket.write(`${JSON.stringify(message)}\n`)
  })
}

function waitForText(socket: Socket, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ""
    const finish = (): void => {
      socket.off("data", onData)
      socket.off("error", onError)
      socket.off("close", onClose)
    }
    const onData = (chunk: Buffer): void => {
      text += chunk.toString()
      if (!text.includes(expected)) return
      finish()
      resolve(text)
    }
    const onError = (error: Error): void => {
      finish()
      reject(error)
    }
    const onClose = (): void => {
      finish()
      reject(new Error(`Socket closed before ${expected}: ${text}`))
    }
    socket.on("data", onData)
    socket.once("error", onError)
    socket.once("close", onClose)
  })
}

it(
  "keeps the native egress proxy alive after a CONNECT peer reset",
  { timeout: 10_000 },
  async () => {
    const host = reachableIpv4()
    const directory = await mkdtemp(join(tmpdir(), "ctxpipe-egress-reset-"))
    const controlSocketPath = join(directory, "control.sock")
    const upstreamSockets = new Set<Socket>()
    const upstream = createServer((socket) => {
      upstreamSockets.add(socket)
      socket.on("error", () => socket.destroy())
      socket.once("close", () => upstreamSockets.delete(socket))
      const timer = setInterval(() => socket.write(Buffer.alloc(64 * 1024)), 1)
      socket.once("close", () => clearInterval(timer))
    })
    const upstreamPort = await listen(upstream, host)
    const proxyModule = new URL(
      "./egress-proxy.js",
      import.meta.resolve("@tanstack/ai-sandbox-docker"),
    ).href
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { startEgressProxy } from ${JSON.stringify(proxyModule)};
const handle = await startEgressProxy({
  allowConnect: [{ host: ${JSON.stringify(host)}, port: ${upstreamPort} }],
  allowHttp: [],
  ingressTargetHost: "127.0.0.1",
  bindAddress: "127.0.0.1",
  proxyPort: 0,
  controlSocketPath: ${JSON.stringify(controlSocketPath)},
});
process.stdout.write(JSON.stringify({ port: handle.proxyPort }) + "\\n");
const shutdown = async () => { await handle.close(); process.exit(0) };
process.once("SIGTERM", () => { void shutdown() });
setInterval(() => {}, 1_000).unref();`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve())
    })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    try {
      assert(child.stdout)
      const ready = JSON.parse(await waitForLine(child.stdout)) as {
        port: number
      }
      const client = await connectSocket({
        host: "127.0.0.1",
        port: ready.port,
      })
      client.write(
        `CONNECT ${host}:${upstreamPort} HTTP/1.1\r\nHost: ${host}:${upstreamPort}\r\n\r\n`,
      )
      await waitForText(client, "200 Connection Established")
      client.resetAndDestroy()
      await new Promise((resolve) => setTimeout(resolve, 250))

      expect(
        child.exitCode,
        `Native egress proxy exited after reset: ${stderr}`,
      ).toBeNull()
      const control = await connectSocket({ path: controlSocketPath })
      control.write('{"op":"revoke","id":"missing"}\n')
      await expect(waitForText(control, '{"ok":true}')).resolves.toContain(
        '{"ok":true}',
      )
      control.end()
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM")
      await closed
      for (const socket of upstreamSockets) socket.destroy()
      await close(upstream)
      await rm(directory, { recursive: true, force: true })
    }
  },
)

it(
  "does not abort allowed HTTP or authenticated ingress while waiting for headers",
  { timeout: 30_000 },
  async () => {
    const host = reachableIpv4()
    const directory = await mkdtemp(join(tmpdir(), "ctxpipe-egress-delay-"))
    const delayedTimers = new Set<ReturnType<typeof setTimeout>>()
    const upstream = createHttpServer((_request, response) => {
      const timer = setTimeout(() => {
        delayedTimers.delete(timer)
        response.writeHead(200, {
          "content-type": "text/plain",
          connection: "close",
        })
        response.end("delayed response")
      }, 5_500)
      delayedTimers.add(timer)
      response.once("close", () => {
        clearTimeout(timer)
        delayedTimers.delete(timer)
      })
    })
    const upstreamPort = await listen(upstream, host)
    const ingressListen = await freePort("127.0.0.1")
    const proxyModule = new URL(
      "./egress-proxy.js",
      import.meta.resolve("@tanstack/ai-sandbox-docker"),
    ).href
    const controlSocketPath = join(directory, "control.sock")
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { startEgressProxy } from ${JSON.stringify(proxyModule)};
const handle = await startEgressProxy({
  allowConnect: [],
  allowHttp: [{ host: ${JSON.stringify(host)}, port: ${upstreamPort}, paths: ["/slow"] }],
  ingressTargetHost: ${JSON.stringify(host)},
  ingress: [{ listenPort: ${ingressListen}, targetPort: ${upstreamPort} }],
  bindAddress: "127.0.0.1",
  ingressBindAddress: "127.0.0.1",
  proxyPort: 0,
  controlSocketPath: ${JSON.stringify(controlSocketPath)},
});
process.stdout.write(JSON.stringify({ port: handle.proxyPort, ingress: handle.ingressPorts[0] }) + "\\n");
const shutdown = async () => { await handle.close(); process.exit(0) };
process.once("SIGTERM", () => { void shutdown() });
setInterval(() => {}, 1_000).unref();`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    )
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))

    try {
      assert(child.stdout)
      const ready = JSON.parse(await waitForLine(child.stdout)) as {
        port: number
        ingress: number
      }
      const outbound = await httpGet(
        ready.port,
        `http://${host}:${upstreamPort}/slow`,
      )
      expect(outbound).toEqual({ status: 200, body: "delayed response" })

      const admitted = await controlRequest(controlSocketPath, {
        op: "open-ingress",
        port: upstreamPort,
      })
      expect(admitted.ok).toBe(true)
      const ingress = await httpGet(ready.ingress, "/slow", {
        "x-tanstack-sandbox-token": String(admitted.token),
      })
      expect(ingress).toEqual({ status: 200, body: "delayed response" })
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM")
      await closed
      for (const timer of delayedTimers) clearTimeout(timer)
      delayedTimers.clear()
      await close(upstream)
      await rm(directory, { recursive: true, force: true })
      expect(child.exitCode, `Native egress proxy failed: ${stderr}`).toBe(0)
    }
  },
)
