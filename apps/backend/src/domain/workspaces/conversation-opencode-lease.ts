import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createServer as createTcpServer } from "node:net"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import type { AnyTool } from "@tanstack/ai"
import {
  BRIDGED_MCP_SERVER_NAME,
  createToolBridgeCore,
  type HostToolBridge,
  hostForSandbox,
  type ProcessOptions,
  type SandboxHandle,
  type SpawnHandle,
  type ToolBridgeCore,
  type ToolBridgeProvisioner,
  type ToolBridgeProvisionOptions,
  timingSafeBearerEqual,
} from "@tanstack/ai-sandbox"
import { log } from "../../observability/logger.js"

const READY_LINE = (url: string) => `opencode server listening on ${url}\n`

type BridgeLease = {
  url: string
  token: string
  name: string
  core: { current: ToolBridgeCore }
  close: () => Promise<void>
}

type ServeLease = {
  fingerprint: string
  pid: number
  readyLine: string
  proc: SpawnHandle
  exited: boolean
}

type ConversationLease = {
  bridge?: BridgeLease
  serve?: ServeLease
  unsandboxedPort?: number
}

const leases = new Map<string, ConversationLease>()

function leaseFor(conversationId: string): ConversationLease {
  const existing = leases.get(conversationId)
  if (existing) return existing
  const created: ConversationLease = {}
  leases.set(conversationId, created)
  return created
}

export function conversationScopedToolBridgeProvisioner(
  conversationId: string,
  resolveBind?: (
    options: ToolBridgeProvisionOptions,
  ) => Promise<{ hostForSandbox: string; bindAddress?: string }>,
): ToolBridgeProvisioner {
  return {
    async provision(tools, options) {
      const current = leaseFor(conversationId)
      if (current.bridge) {
        current.bridge.core.current = createToolBridgeCore(tools, options)
        return facadeBridge(current.bridge)
      }
      const bind = resolveBind
        ? await resolveBind(options)
        : {
            hostForSandbox: hostForSandbox(options.provider),
          }
      current.bridge = await startMutableHostToolBridge(tools, {
        ...options,
        ...bind,
      })
      return facadeBridge(current.bridge)
    },
  }
}

function facadeBridge(bridge: BridgeLease): HostToolBridge {
  return {
    name: bridge.name,
    url: bridge.url,
    token: bridge.token,
    close: async () => undefined,
  }
}

async function startMutableHostToolBridge(
  tools: AnyTool[],
  options: ToolBridgeProvisionOptions & {
    hostForSandbox: string
    bindAddress?: string
  },
): Promise<BridgeLease> {
  const token = randomBytes(24).toString("hex")
  const core = { current: createToolBridgeCore(tools, options) }
  const bindAddress =
    options.bindAddress ??
    (options.hostForSandbox === "host.docker.internal"
      ? "0.0.0.0"
      : "127.0.0.1")

  const httpServer = createServer((req, res) => {
    void (async () => {
      if (!timingSafeBearerEqual(req.headers.authorization, token)) {
        res.writeHead(401).end("unauthorized")
        return
      }
      const server = new McpServer(
        { name: BRIDGED_MCP_SERVER_NAME, version: "1.0.0" },
        { capabilities: { tools: {} } },
      )
      server.server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: core.current.listTools(),
      }))
      server.server.setRequestHandler(
        CallToolRequestSchema,
        async (request) => {
          const result = await core.current.callTool(
            request.params.name,
            request.params.arguments ?? {},
          )
          return {
            content: result.content,
            ...(result.isError ? { isError: true } : {}),
          }
        },
      )
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      })
      res.on("close", () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      let body = ""
      for await (const chunk of req) body += chunk
      let parsed: unknown
      try {
        parsed = body ? JSON.parse(body) : undefined
      } catch {
        if (!res.headersSent) res.writeHead(400).end("invalid JSON body")
        return
      }
      await transport.handleRequest(req, res, parsed)
    })().catch((error: unknown) => {
      log.error({
        step: "conversation-tool-bridge",
        error: error instanceof Error ? error.message : String(error),
      })
      if (!res.headersSent) res.writeHead(500).end("bridge error")
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      httpServer.off("listening", onListening)
      reject(error)
    }
    const onListening = (): void => {
      httpServer.off("error", onError)
      resolve()
    }
    httpServer.once("error", onError)
    httpServer.once("listening", onListening)
    httpServer.listen(0, bindAddress)
  })

  const port = (httpServer.address() as AddressInfo).port
  const url = `http://${options.hostForSandbox}:${port}/mcp`
  let admission:
    | Awaited<
        ReturnType<NonNullable<SandboxHandle["hostBridgeAccess"]>["admit"]>
      >
    | undefined
  try {
    admission = await options.sandbox?.hostBridgeAccess?.admit({ url, token })
  } catch (admissionError) {
    await closeHttpServer(httpServer)
    throw admissionError
  }

  let closeTask: Promise<void> | undefined
  const close = (): Promise<void> => {
    closeTask ??= (async () => {
      const errors: unknown[] = []
      try {
        await admission?.revoke()
      } catch (error) {
        errors.push(error)
      }
      try {
        await closeHttpServer(httpServer)
      } catch (error) {
        errors.push(error)
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Conversation tool bridge close failed",
        )
      }
    })()
    return closeTask
  }

  return { url, token, name: BRIDGED_MCP_SERVER_NAME, core, close }
}

function closeHttpServer(
  httpServer: ReturnType<typeof createServer>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error)
      else resolve()
    })
    httpServer.closeAllConnections()
  })
}

export function reuseOpencodeServeHandle(
  handle: SandboxHandle,
  conversationId: () => string | undefined,
): SandboxHandle {
  return {
    ...handle,
    process: {
      ...handle.process,
      spawn: async (command, options) => {
        const id = conversationId()
        if (!id || !command.includes("opencode serve")) {
          return handle.process.spawn(command, options)
        }
        return spawnOrAttachOpencodeServe(id, handle, command, options)
      },
    },
    destroy: async () => {
      const id = conversationId()
      try {
        if (id) await releaseConversationOpencodeLease(id)
      } finally {
        await handle.destroy()
      }
    },
  }
}

async function spawnOrAttachOpencodeServe(
  conversationId: string,
  handle: SandboxHandle,
  command: string,
  options?: ProcessOptions,
): Promise<SpawnHandle> {
  const current = leaseFor(conversationId)
  const fingerprint = serveFingerprint(command, options)
  const live = current.serve
  if (live && !live.exited && live.fingerprint === fingerprint) {
    return facadeServe(live)
  }
  if (live) await stopServe(live)

  const { signal: _turnSignal, ...spawnOptions } = options ?? {}
  const proc = await handle.process.spawn(command, spawnOptions)
  const serve: ServeLease = {
    fingerprint,
    pid: proc.pid,
    readyLine: "",
    proc,
    exited: false,
  }
  void proc.wait().then(
    () => {
      serve.exited = true
    },
    () => {
      serve.exited = true
    },
  )
  current.serve = serve
  const lifetime = createFacadeLifetime()
  return {
    pid: proc.pid,
    stdout: exposeReadyStdout(proc.stdout, serve),
    stderr: proc.stderr,
    stdin: proc.stdin,
    wait: lifetime.wait,
    kill: lifetime.kill,
  }
}

function serveFingerprint(command: string, options?: ProcessOptions): string {
  return JSON.stringify({
    command,
    cwd: options?.cwd ?? "",
    env: options?.env ?? {},
  })
}

async function* exposeReadyStdout(
  stdout: AsyncIterable<string>,
  serve: ServeLease,
): AsyncIterable<string> {
  let scan = ""
  for await (const chunk of stdout) {
    scan = `${scan}${chunk}`.slice(-16_000)
    if (!serve.readyLine) {
      const match = scan.match(
        /opencode server listening on (https?:\/\/[^\s]+)/,
      )
      if (match?.[1]) serve.readyLine = READY_LINE(match[1])
    }
    yield chunk
  }
}

function facadeServe(serve: ServeLease): SpawnHandle {
  const lifetime = createFacadeLifetime()
  return {
    pid: serve.pid,
    stdout: (async function* () {
      if (serve.readyLine) yield serve.readyLine
    })(),
    stderr: (async function* () {})(),
    stdin: {
      write: async () => undefined,
      end: async () => undefined,
    },
    wait: lifetime.wait,
    kill: lifetime.kill,
  }
}

function createFacadeLifetime(): {
  wait: () => Promise<number>
  kill: (signal?: NodeJS.Signals | number) => Promise<void>
} {
  let resolveWait: (code: number) => void
  const waited = new Promise<number>((resolve) => {
    resolveWait = resolve
  })
  let settled = false
  return {
    wait: () => waited,
    kill: async () => {
      if (settled) return
      settled = true
      resolveWait(0)
    },
  }
}

async function stopServe(serve: ServeLease): Promise<void> {
  if (serve.exited) return
  try {
    await serve.proc.kill("SIGKILL")
  } catch {
    // Process may already be gone.
  }
  serve.exited = true
}

export async function claimUnsandboxedOpencodePort(
  conversationId: string,
): Promise<number> {
  const current = leaseFor(conversationId)
  if (current.unsandboxedPort) return current.unsandboxedPort
  const port = await new Promise<number>((resolve, reject) => {
    const server = createTcpServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("Unsandboxed OpenCode listen port missing"))
        return
      }
      const allocated = address.port
      server.close((error) => (error ? reject(error) : resolve(allocated)))
    })
  })
  current.unsandboxedPort = port
  return port
}

export async function releaseConversationOpencodeLease(
  conversationId: string,
): Promise<void> {
  const current = leases.get(conversationId)
  if (!current) return
  leases.delete(conversationId)
  const errors: unknown[] = []
  if (current.serve) {
    try {
      await stopServe(current.serve)
    } catch (error) {
      errors.push(error)
    }
  }
  if (current.bridge) {
    try {
      await current.bridge.close()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "Conversation OpenCode lease release failed",
    )
  }
}
