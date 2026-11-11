import { createSocket } from "node:dgram"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { networkInterfaces } from "node:os"

import { defineChatMiddleware } from "@tanstack/ai"
import {
  nodeHttpBridgeProvisioner,
  provideToolBridgeProvisioner,
  startHostToolBridge,
  type ToolBridgeProvisioner,
  ToolBridgeProvisionerCapability,
} from "@tanstack/ai-sandbox"

import type { RunVault } from "./agent-vault.js"
import { parseSandboxCallbackHost } from "./sandbox-callback-host.js"
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
 * AgentCore sandboxes reach the backend only through Agent Vault, so there
 * it is the address this process reaches Agent Vault from.
 */
export async function sandboxCallbackHost(
  env: NodeJS.ProcessEnv = process.env,
  network: CallbackNetwork = systemNetwork,
): Promise<string | undefined> {
  const raw = env.SANDBOX_CALLBACK_HOST?.trim()
  if (!raw) {
    const routeTarget =
      remoteDockerHost(env) ??
      (env.SANDBOX_PROVIDER?.trim() === "agentcore" &&
      env.AGENT_VAULT_ADDR?.trim()
        ? new URL(env.AGENT_VAULT_ADDR.trim()).hostname
        : undefined)
    const address = routeTarget
      ? await localAddressTowards(routeTarget, network)
      : undefined
    // Agent Vault rules take host names, not addresses. The AWS stack sets
    // the VPC's DNS suffix, under which every VPC address has a name.
    const suffix = env.SANDBOX_CALLBACK_DNS_SUFFIX?.trim()
    if (address && suffix && isIP(address) === 4)
      return `ip-${address.replaceAll(".", "-")}.${suffix}`
    return address
  }

  return parseSandboxCallbackHost(raw)
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

/**
 * The OpenCode MCP configuration in the sandbox gets a placeholder; the run's
 * vault holds the bridge token, and Agent Vault adds it to bridge calls.
 */
function withBridgeTokenInVault(
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

/** Provide explicit remote routing, while retaining TanStack's local default. */
export function workspaceChatCallbackMiddleware(
  callbackHost?: string,
  /** Docker and AgentCore: the run's vault, which holds the bridge token. */
  vault?: Pick<RunVault, "addRules">,
) {
  const provisioner = withBridgeTokenInVault(
    callbackHost
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
