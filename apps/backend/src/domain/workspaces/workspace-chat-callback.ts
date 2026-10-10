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
import type { RunVault } from "./agent-vault.js"
import { bearerUrlRule } from "./sandbox-credential-rules.js"
import { remoteDockerHost } from "./sandbox-provider.js"
import { WORKSPACE_CHAT_FIREWALL_PLACEHOLDER } from "./workspace-chat-opencode-contract.js"

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
  network: CallbackNetwork = systemNetwork,
): Promise<string | undefined> {
  const raw = env.SANDBOX_CALLBACK_HOST?.trim()
  if (!raw) {
    const daemonHost = remoteDockerHost(env)
    const address = daemonHost
      ? await localAddressTowards(daemonHost, network)
      : undefined
    // Agent Vault rules take host names, not addresses. The AWS stack sets
    // the VPC's DNS suffix, under which every VPC address has a name.
    const suffix = env.SANDBOX_CALLBACK_DNS_SUFFIX?.trim()
    if (address && suffix && isIP(address) === 4)
      return `ip-${address.replaceAll(".", "-")}.${suffix}`
    return address
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

/** Name resolution and kernel routing, the environment the default host comes from. */
export type CallbackNetwork = {
  lookup: (host: string) => Promise<{ address: string; family: number }>
  /** The local address the kernel would send from to reach `address`. */
  sourceAddress: (address: string, family: number) => Promise<string>
}

const systemNetwork: CallbackNetwork = {
  lookup: (host) => lookup(host),
  async sourceAddress(address, family) {
    // A connected UDP socket only selects a route; it sends nothing.
    const socket = createSocket(family === 6 ? "udp6" : "udp4")
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject)
        socket.connect(9, address, resolve)
      })
      return socket.address().address
    } finally {
      socket.close()
    }
  },
}

/**
 * The local address this process reaches the Docker daemon's host from.
 * Undefined when that is a loopback address: the daemon runs on this machine,
 * and its sandboxes use the provider's local defaults (`host.docker.internal`).
 * A daemon name that does not resolve or route yet (an AWS sandbox host being
 * replaced) fails the turn until it does.
 */
async function localAddressTowards(
  host: string,
  network: CallbackNetwork,
): Promise<string | undefined> {
  let source: string
  let family: number
  try {
    // URL hostnames keep IPv6 brackets; the resolver does not take them.
    const target = await network.lookup(host.replace(/^\[(.*)\]$/, "$1"))
    family = target.family
    source = await network.sourceAddress(target.address, target.family)
  } catch (error) {
    throw new Error(
      `The sandbox host ${host} is not reachable yet; Workspace chat resumes when it is`,
      { cause: error },
    )
  }
  const mapped = source.toLowerCase().startsWith("::ffff:")
    ? source.slice(7)
    : source
  if (mapped === "::1" || mapped.startsWith("127.")) return undefined
  return family === 6 && isIP(mapped) === 6 ? `[${mapped}]` : mapped
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

/** The path of a run's tool bridge on the backend's public origin. */
export function workspaceChatToolBridgePath(bridgeId: string): string {
  return `/api/v1/workspace-chat/tool-bridge/${bridgeId}`
}

/**
 * Hosted sandboxes reach the backend's public origin, so each run's tool
 * bridge is served from a route there instead of its own port. The bridge
 * lives in the process running the turn (production runs one backend
 * replica; during a rolling deploy a call can land on the other one and fail).
 * The id and token are set before the run, so the firewall can add the
 * token; the sandbox gets a placeholder only.
 */
export function publicRouteBridgeProvisioner(
  publicBaseUrl: string,
  bridge: { id: string; token: string },
): ToolBridgeProvisioner {
  return {
    async provision(tools, options) {
      const { provider: _provider, ...core } = options
      const { id, token } = bridge
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
        url: `${publicBaseUrl.replace(/\/$/, "")}${workspaceChatToolBridgePath(id)}`,
        token: WORKSPACE_CHAT_FIREWALL_PLACEHOLDER,
        close: async () => {
          publicBridges.delete(id)
        },
      }
    },
  }
}

/**
 * The OpenCode MCP configuration in the sandbox gets a placeholder; the run's
 * vault holds the bridge token, and Agent Vault adds it to bridge calls.
 */
export function withBridgeTokenInVault(
  provisioner: ToolBridgeProvisioner,
  vault: Pick<RunVault, "addRules"> | undefined,
): ToolBridgeProvisioner {
  if (!vault) return provisioner
  return {
    async provision(tools, options) {
      const bridge = await provisioner.provision(tools, options)
      await vault.addRules([
        bearerUrlRule("tool-bridge", bridge.url, bridge.token),
      ])
      return { ...bridge, token: WORKSPACE_CHAT_FIREWALL_PLACEHOLDER }
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
  hosted?: { publicBaseUrl: string; bridge: { id: string; token: string } },
  /** Docker: the run's vault, which holds the bridge token. */
  vault?: Pick<RunVault, "addRules">,
) {
  const provisioner = withBridgeTokenInVault(
    hosted
      ? publicRouteBridgeProvisioner(hosted.publicBaseUrl, hosted.bridge)
      : callbackHost
        ? workspaceChatToolBridgeProvisioner(callbackHost)
        : nodeHttpBridgeProvisioner,
    vault,
  )
  return defineChatMiddleware({
    name: "workspace-chat-callback",
    provides: [ToolBridgeProvisionerCapability],
    setup(ctx) {
      provideToolBridgeProvisioner(ctx, provisioner)
    },
  })
}
