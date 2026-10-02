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

/**
 * Hostname or IP that a remotely hosted sandbox uses to call this backend.
 * A port or URL is rejected because the model proxy and per-run tool bridge
 * each select their own port.
 */
export function sandboxCallbackHost(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env.SANDBOX_CALLBACK_HOST?.trim()
  if (!raw) return undefined

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

/** Provide explicit remote routing, while retaining TanStack's local default. */
export function workspaceChatCallbackMiddleware(callbackHost?: string) {
  const provisioner = callbackHost
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
