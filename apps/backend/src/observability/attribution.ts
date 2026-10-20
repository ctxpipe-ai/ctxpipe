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
  "ctxpipe.mcp.resource",
  "ctxpipe.conversation.id",
  "ctxpipe.ingest.run.id",
  "ctxpipe.ingest.shard",
  "ctxpipe.ingest.step",
  "ctxpipe.repository.id",
  "ctxpipe.workspace.id",
  "ctxpipe.connection.id",
  "ctxpipe.mcp.call.id",
  "ctxpipe.mcp.connection.key",
  "ctxpipe.mcp.client.name",
  "ctxpipe.mcp.conversation.id",
  "ctxpipe.mcp.conversation.source",
  "ctxpipe.mcp.turn.id",
  "ctxpipe.mcp.turn.source",
  "ctxpipe.mcp.correlation.source",
  "ctxpipe.mcp.error.code",
  "ctxpipe.api_key.event",
  "ctxpipe.api_key.outcome",
  "ctxpipe.auth.refusal_reason",
  "ctxpipe.auth.method",
] as const

export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number]

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
  key: { id: string; orgId: string },
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

/**
 * Give one unit of work (for example one MCP tool call of a batch) its own
 * bag. The bag starts with a copy of the parent entries, so request
 * attribution stays, and entries set later do not go to sibling calls.
 */
export function contextWithForkedAttributionBag(parent: Context): Context {
  const { context: forked, bag } = contextWithAttributionBag(parent)
  for (const [key, value] of attributionBagFromContext(parent) ?? []) {
    bag.set(key, value)
  }
  return forked
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
  getLogger().set(cleaned)
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
