import { randomBytes } from "node:crypto"
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
 * host, it is this process's own address: the tool bridge lives in the replica
 * running the turn, so a shared service name could reach another replica.
 */
export function sandboxCallbackHost(
  env: NodeJS.ProcessEnv = process.env,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | undefined {
  const raw = env.SANDBOX_CALLBACK_HOST?.trim()
  if (!raw)
    return remoteDockerHost(env) ? soleIpv4Address(interfaces) : undefined

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

function soleIpv4Address(
  interfaces: ReturnType<typeof networkInterfaces>,
): string {
  const addresses = [
    ...new Set(
      Object.values(interfaces)
        .flatMap((entries) => entries ?? [])
        .filter((entry) => entry.family === "IPv4" && !entry.internal)
        .map((entry) => entry.address),
    ),
  ]
  const [address] = addresses
  if (addresses.length !== 1 || !address)
    throw new Error(
      `Sandboxes on a remote Docker host call this backend back, but it has ${addresses.length} non-loopback IPv4 addresses; set SANDBOX_CALLBACK_HOST`,
    )
  return address
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
