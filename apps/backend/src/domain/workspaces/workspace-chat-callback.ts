import { randomBytes } from "node:crypto"
import { createSocket } from "node:dgram"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { networkInterfaces } from "node:os"
import { defineChatMiddleware } from "@tanstack/ai"
import {
  BRIDGED_MCP_SERVER_NAME,
  createToolBridgeCore,
  handleBridgeJsonRpc,
  nodeHttpBridgeProvisioner,
  provideToolBridgeProvisioner,
  startHostToolBridge,
  type ToolBridgeCore,
  type ToolBridgeProvisioner,
  ToolBridgeProvisionerCapability,
  timingSafeBearerEqual,
} from "@tanstack/ai-sandbox"
import { Hono } from "hono"
import { remoteDockerHost } from "./sandbox-provider.js"

/**
 * Hostname or IP that a remotely hosted sandbox uses to call this backend.
 * A port or URL is rejected because the model proxy and per-run tool bridge
 * each select their own port. With a remote Docker daemon and no explicit
 * host, it is the address this process reaches the daemon from: the daemon's
 * host routes sandbox traffic back to it, and the tool bridge lives in the
 * replica running the turn, so a shared service name could reach another
 * replica. A backend on several networks (Compose) gets the sandbox one.
 */
export async function sandboxCallbackHost(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const raw = env.SANDBOX_CALLBACK_HOST?.trim()
  if (!raw) {
    const daemonHost = remoteDockerHost(env)
    return daemonHost ? localAddressTowards(daemonHost) : undefined
  }

  const unwrapped =
    raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw
  const ipVersion = isIP(unwrapped)
  if (
    /[/\\?#]/.test(raw) ||
    (raw.includes(":") && ipVersion !== 6) ||
    (raw !== unwrapped && ipVersion !== 6)
  ) {
    throw new Error("SANDBOX_CALLBACK_HOST must be a hostname or IP address")
  }
  const candidate = ipVersion === 6 ? `[${unwrapped}]` : raw
  let parsed: URL
  try {
    parsed = new URL(`http://${candidate}`)
  } catch {
    throw new Error("SANDBOX_CALLBACK_HOST must be a hostname or IP address")
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("SANDBOX_CALLBACK_HOST must be a hostname or IP address")
  }
  return parsed.host
}

/**
 * The local address the kernel picks to reach `host` (a UDP connect sends
 * nothing). Undefined for a daemon on this machine, whose sandboxes use the
 * provider's local defaults.
 */
async function localAddressTowards(host: string): Promise<string | undefined> {
  let target: { address: string; family: number }
  try {
    target = await lookup(host)
  } catch {
    throw new Error(
      `Cannot resolve Docker host ${host} to pick the address sandboxes call back on; set SANDBOX_CALLBACK_HOST`,
    )
  }
  const socket = createSocket(target.family === 6 ? "udp6" : "udp4")
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject)
      socket.connect(9, target.address, resolve)
    })
    const { address } = socket.address()
    if (address === "::1" || address.startsWith("127.")) return undefined
    return target.family === 6 ? `[${address}]` : address
  } finally {
    socket.close()
  }
}

/** Native per-run bridge server/token ownership on one reachable interface. */
export function workspaceChatToolBridgeProvisioner(
  callbackHost: string,
): ToolBridgeProvisioner {
  return {
    async provision(tools, options) {
      const bindAddress = await localCallbackBindAddress(callbackHost)
      return startHostToolBridge(tools, {
        hostForSandbox: callbackHost,
        bindAddress,
        ...(options.context !== undefined ? { context: options.context } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.emitCustomEvent !== undefined
          ? { emitCustomEvent: options.emitCustomEvent }
          : {}),
        ...(options.permission !== undefined
          ? { permission: options.permission }
          : {}),
      })
    },
  }
}

async function localCallbackBindAddress(callbackHost: string): Promise<string> {
  const hostname =
    callbackHost.startsWith("[") && callbackHost.endsWith("]")
      ? callbackHost.slice(1, -1)
      : callbackHost
  const resolved = await lookup(hostname, { all: true, verbatim: true })
  const localAddresses = new Set(
    Object.values(networkInterfaces()).flatMap(
      (entries) => entries?.map((entry) => entry.address) ?? [],
    ),
  )
  const local = resolved.find((entry) => localAddresses.has(entry.address))
  if (!local) {
    throw new Error(
      `SANDBOX_CALLBACK_HOST must resolve to a local backend interface: ${callbackHost}`,
    )
  }
  return local.address
}

/** Bridges served by this process for runs in remote (Vercel) sandboxes. */
const publicBridges = new Map<string, { core: ToolBridgeCore; token: string }>()

/**
 * Remote sandboxes reach only the backend's public origin, so each run's tool
 * bridge is served from a route there instead of its own port. The bridge
 * lives in the process running the turn (production runs one backend
 * replica; during a rolling deploy a call can land on the other one and fail).
 */
export function publicRouteBridgeProvisioner(
  publicBaseUrl: string,
): ToolBridgeProvisioner {
  return {
    async provision(tools, options) {
      const { provider: _provider, ...core } = options
      const id = randomBytes(16).toString("hex")
      const token = randomBytes(24).toString("hex")
      publicBridges.set(id, { core: createToolBridgeCore(tools, core), token })
      options.signal?.addEventListener(
        "abort",
        () => publicBridges.delete(id),
        {
          once: true,
        },
      )
      return {
        name: BRIDGED_MCP_SERVER_NAME,
        url: `${publicBaseUrl.replace(/\/$/, "")}/api/v1/workspace-chat/tool-bridge/${id}`,
        token,
        close: async () => {
          publicBridges.delete(id)
        },
      }
    },
  }
}

/** Stateless MCP over HTTP: JSON-RPC in, JSON out, per-run bearer token. */
export const workspaceChatToolBridgeRoutes = new Hono()
  .post("/api/v1/workspace-chat/tool-bridge/:bridgeId", async (c) => {
    const bridge = publicBridges.get(c.req.param("bridgeId"))
    if (
      !bridge ||
      !timingSafeBearerEqual(c.req.header("authorization"), bridge.token)
    )
      return c.text("unauthorized", 401)
    let message: unknown
    try {
      message = await c.req.json()
    } catch {
      return c.text("invalid JSON body", 400)
    }
    const response = await handleBridgeJsonRpc(bridge.core, message)
    return response === null ? c.body(null, 202) : c.json(response)
  })
  .get("/api/v1/workspace-chat/tool-bridge/:bridgeId", (c) =>
    c.text("method not allowed", 405),
  )

/** Provide explicit remote routing, while retaining TanStack's local default. */
export function workspaceChatCallbackMiddleware(
  callbackHost?: string,
  publicBaseUrl?: string,
) {
  const provisioner = publicBaseUrl
    ? publicRouteBridgeProvisioner(publicBaseUrl)
    : callbackHost
      ? workspaceChatToolBridgeProvisioner(callbackHost)
      : nodeHttpBridgeProvisioner
  return defineChatMiddleware({
    name: "workspace-chat-callback",
    provides: [ToolBridgeProvisionerCapability],
    setup(ctx) {
      provideToolBridgeProvisioner(ctx, provisioner)
    },
  })
}
