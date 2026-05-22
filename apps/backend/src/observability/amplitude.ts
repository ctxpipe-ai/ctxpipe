import * as amplitude from "@amplitude/analytics-node"
import type { Env } from "../config/env.js"

/**
 * Amplitude (product analytics) — **opt-in only**.
 *
 * If **`AMPLITUDE_API_KEY` is unset**, we never call `amplitude.init` and **no events are sent**
 * to Amplitude (default for all deployments). There is no “silent” or sampled send without a key.
 */

/** `true` only after `initAmplitudeFromEnv` ran with a non-empty API key. */
let amplitudeInitialized = false

export function initAmplitudeFromEnv(env: Env): void {
  if (!env.AMPLITUDE_API_KEY) {
    // Explicit default: no Amplitude SDK, no outbound analytics.
    return
  }
  amplitude.init(env.AMPLITUDE_API_KEY, {
    serverZone: env.AMPLITUDE_REGION === "eu" ? "EU" : "US",
  })
  amplitudeInitialized = true
}

export function trackMcpToolInvocation(args: {
  userId: string
  orgId: string
  orgSlug: string
  toolName: string
}): void {
  // No key at startup → `amplitudeInitialized` stays false → no outbound events.
  if (!amplitudeInitialized) return
  try {
    amplitude.track(
      "mcp.tool.called",
      {
        toolName: args.toolName,
        orgSlug: args.orgSlug,
        orgId: args.orgId,
      },
      {
        user_id: args.userId,
        // Same group key as browser (`org`) so charts slice by organization in Amplitude.
        groups: { org: args.orgId },
      },
    )
  } catch {
    /* ignore */
  }
}
