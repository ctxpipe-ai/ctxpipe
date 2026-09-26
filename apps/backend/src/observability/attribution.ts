import {
  type Context,
  context,
  createContextKey,
  propagation,
  trace,
} from "@opentelemetry/api"

import { getLogger } from "./logger.js"

export const ATTRIBUTION_KEYS = [
  "request.id",
  "enduser.id",
  "ctxpipe.org.id",
  "ctxpipe.org.slug",
  "ctxpipe.actor.type",
  "ctxpipe.api_key.id",
  "ctxpipe.oauth.client_id",
  "ctxpipe.mcp.tool",
  "ctxpipe.conversation.id",
  "ctxpipe.repository.id",
  "ctxpipe.connection.id",
] as const

export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number]

export type ActorType =
  | "user"
  | "org_api_key"
  | "oauth_client"
  | "webhook"
  | "job"

const ATTRIBUTION_BAG = createContextKey("ctxpipe.attribution.bag")

export type AttributionInput = Partial<
  Record<AttributionKey, string | undefined>
>

export function sanitizeAttribution(
  input: AttributionInput,
): Partial<Record<AttributionKey, string>> {
  const out: Partial<Record<AttributionKey, string>> = {}
  for (const key of ATTRIBUTION_KEYS) {
    const value = input[key]?.trim()
    if (value) out[key] = value
  }
  return out
}

export function attributesForOrgApiKey(
  key: { id: string; orgId: string; secret?: string },
  orgSlug?: string,
): Partial<Record<AttributionKey, string>> {
  return sanitizeAttribution({
    "ctxpipe.actor.type": "org_api_key",
    "ctxpipe.api_key.id": key.id,
    "ctxpipe.org.id": key.orgId,
    "ctxpipe.org.slug": orgSlug,
  })
}

export function contextWithAttributionBag(parent: Context): {
  context: Context
  bag: Map<string, string>
} {
  const bag = new Map<string, string>()
  return { context: parent.setValue(ATTRIBUTION_BAG, bag), bag }
}

function attributionBagFromContext(
  parent: Context,
): Map<string, string> | undefined {
  const value = parent.getValue(ATTRIBUTION_BAG)
  return value instanceof Map ? value : undefined
}

export function readAttribution(): Partial<Record<AttributionKey, string>> {
  const bag = attributionBagFromContext(context.active())
  if (!bag) return {}
  return Object.fromEntries(bag) as Partial<Record<AttributionKey, string>>
}

export function applyAttribution(
  input: AttributionInput,
): Partial<Record<AttributionKey, string>> {
  const cleaned = sanitizeAttribution(input)
  if (Object.keys(cleaned).length === 0) return cleaned
  trace.getActiveSpan()?.setAttributes(cleaned)
  try {
    const logger = getLogger()
    if (typeof logger.set === "function") logger.set(cleaned)
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        error.message.startsWith("getLogger: no logger in context")
      )
    ) {
      throw error
    }
  }
  const bag = attributionBagFromContext(context.active())
  if (bag) {
    for (const [key, value] of Object.entries(cleaned)) {
      if (value) bag.set(key, value)
    }
  }
  return cleaned
}

export function copyAttributionToSpan(
  span: { setAttributes(attributes: Record<string, string>): void },
  parent: Context,
): void {
  const bag = attributionBagFromContext(parent)
  if (!bag || bag.size === 0) return
  span.setAttributes(Object.fromEntries(bag))
}

export function baggageWithAttribution(parent: Context): Context {
  let baggage = propagation.createBaggage()
  const bag = attributionBagFromContext(parent)
  if (bag) {
    for (const [key, value] of bag) {
      baggage = baggage.setEntry(key, { value })
    }
  }
  return propagation.setBaggage(parent, baggage)
}

export function propagationHeaders(
  headers: Headers,
  active = context.active(),
): void {
  propagation.inject(baggageWithAttribution(active), headers, {
    set(carrier, key, value) {
      carrier.set(key, value)
    },
  })
}
