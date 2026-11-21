import { z } from "zod"

/** The OpenRouter base URL, the default of `MODEL_PROVIDER_URL`. */
export const DEFAULT_OPENROUTER_BASE = "https://openrouter.ai/api/v1"

/**
 * The OpenRouter provider block of each model call of the backend
 * (ADR-070). It allows only ZDR endpoints, and no data collection. When the
 * operator sets `MODEL_PROVIDER_ALLOWLIST`, it also allows only the
 * providers of that list (`only`). It pins no provider and sets no order,
 * so OpenRouter can fall back among the endpoints that pass the filters.
 *
 * The hosted stack sets the list. A self-hosted deployment usually leaves
 * it unset, and then the block has no `only` filter.
 */
export function openRouterProvider(): {
  data_collection: "deny"
  zdr: true
  only?: string[]
} {
  const only = providerAllowlist()
  return { data_collection: "deny", zdr: true, ...(only ? { only } : {}) }
}

/**
 * The provider slugs of `MODEL_PROVIDER_ALLOWLIST` (separated by commas),
 * or undefined when it is unset or only spaces. Each slug is a base
 * provider slug of the OpenRouter provider list (`GET /api/v1/providers`),
 * for example `google-vertex`: it matches each endpoint of that provider. A
 * value that is not a slug list (also an empty entry) stops the call: a
 * typing error must not remove the filter.
 */
export function providerAllowlist(
  value = process.env.MODEL_PROVIDER_ALLOWLIST,
): string[] | undefined {
  if (!value?.trim()) return undefined
  const slugs = value.split(",").map((slug) => slug.trim())
  if (!slugs.every((slug) => /^[a-z0-9][a-z0-9-]*$/.test(slug)))
    throw new Error(
      `MODEL_PROVIDER_ALLOWLIST must be OpenRouter provider slugs separated by commas, for example "openai,anthropic". Got "${value}".`,
    )
  return slugs
}

/**
 * The start check of `MODEL_PROVIDER_ALLOWLIST`: a slug list, and model
 * settings that send each call to OpenRouter. Else a call that is not
 * classified as an OpenRouter call would leave the allowlist with no
 * error, so the backend does not start.
 */
export function allowlistSettingsProblem(env: {
  MODEL_PROVIDER?: string
  MODEL_PROVIDER_URL?: string
  MODEL_PROVIDER_ALLOWLIST?: string
}): string | undefined {
  try {
    if (!providerAllowlist(env.MODEL_PROVIDER_ALLOWLIST)) return undefined
  } catch (error) {
    return (error as Error).message
  }
  if (!isOpenRouterCall(env.MODEL_PROVIDER, env.MODEL_PROVIDER_URL))
    return "MODEL_PROVIDER_ALLOWLIST needs model settings that point at OpenRouter: MODEL_PROVIDER=openrouter, or a MODEL_PROVIDER_URL on openrouter.ai."
  return undefined
}

/**
 * True when the allowlist allows the provider of `tag` (a provider slug or
 * an endpoint tag, for example `google-vertex/global`), or when no allowlist
 * is set.
 */
export function isAllowedProvider(tag: string): boolean {
  const allowlist = providerAllowlist()
  return !allowlist || allowlist.includes(tag.split("/")[0] ?? "")
}

/**
 * The JSON body of a request with the provider block over its own provider
 * fields. The block sets `zdr` and `data_collection`. A request `only` list
 * stays when each of its entries is a provider of the allowlist (or an
 * endpoint of one), because it then narrows the list. Else the allowlist
 * replaces it. The other provider fields of the request (for example
 * `order`, `ignore` or `sort`) stay.
 */
export function withOpenRouterProvider(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const own = z.record(z.string(), z.unknown()).safeParse(body.provider).data
  const block = openRouterProvider()
  const asked = z.array(z.string()).safeParse(own?.only).data
  const narrows =
    block.only !== undefined &&
    asked !== undefined &&
    asked.length > 0 &&
    asked.every(isAllowedProvider)
  return {
    ...body,
    provider: { ...own, ...block, ...(narrows ? { only: asked } : {}) },
  }
}

/**
 * The JSON body of a call of the model settings `kind` and `baseUrl`: with
 * the provider block when the call goes to OpenRouter and the body is a
 * JSON object, else unchanged. The tier calls and the embeddings of the
 * current stack use it.
 */
export function withProviderBlock(
  kind: string | undefined,
  baseUrl: string | undefined,
  body: unknown,
): unknown {
  const record = z.record(z.string(), z.unknown()).safeParse(body).data
  return record && isOpenRouterCall(kind, baseUrl)
    ? withOpenRouterProvider(record)
    : body
}

/**
 * The JSON body of a client request that a proxy route forwards (the
 * OpenAI-compatible proxy and the model proxy of the sandboxes). To
 * OpenRouter, it drops the fields that send the content past the provider
 * filters: `plugins` (for example a web search or a file parser at another
 * service), `models` (fallback models) and `route`. Then it puts the
 * provider block over the provider fields of the client.
 */
export function proxiedBody(
  kind: string | undefined,
  baseUrl: string | undefined,
  body: unknown,
): unknown {
  const record = z.record(z.string(), z.unknown()).safeParse(body).data
  if (!record || !isOpenRouterCall(kind, baseUrl)) return body
  const { plugins: _plugins, models: _models, route: _route, ...rest } = record
  return withOpenRouterProvider(rest)
}

/**
 * True when the model settings send a call to OpenRouter: the provider kind
 * is `openrouter`, or the base URL is on the OpenRouter host (also the
 * default URL of `openai-like`). Another OpenAI-compatible API (for example
 * OpenAI, Azure or a local server) can refuse the unknown `provider` field,
 * so it does not get the block. The clients of the models that are only on
 * OpenRouter (Jev, the plane embeddings, the vision model) send the block
 * on each call (`openRouterSettings`).
 */
export function isOpenRouterCall(
  kind: string | undefined,
  baseUrl: string | undefined,
): boolean {
  if (kind === "openrouter") return true
  if (kind === "azure" || kind === "bedrock") return false
  try {
    return (
      new URL(baseUrl?.trim() || DEFAULT_OPENROUTER_BASE).hostname ===
      "openrouter.ai"
    )
  } catch {
    return false
  }
}
