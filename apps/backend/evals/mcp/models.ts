/** Send every eval model through OpenRouter (CTO decision, 2026-10-18). */

import { openRouterModelId } from "@ctxpipe/visual-review"
import { z } from "zod"

import {
  DEFAULT_OPENROUTER_BASE,
  withOpenRouterProvider,
} from "../../src/retrieval/services/openRouterProvider.js"

const providerName = "openrouter-eval"

/** The OpenRouter base URL of the eval: `MODEL_PROVIDER_URL`, else the default. */
export function openRouterBaseUrl(env: Record<string, string | undefined>) {
  return env.MODEL_PROVIDER_URL || DEFAULT_OPENROUTER_BASE
}

/** The client settings for one model: base URL from `MODEL_PROVIDER_URL`, key from `MODEL_PROVIDER_API_KEY`. */
export function openRouterClient(
  model: string,
  env: Record<string, string | undefined>,
) {
  const apiKey = env.MODEL_PROVIDER_API_KEY
  if (!apiKey)
    throw new Error(
      `Set MODEL_PROVIDER_API_KEY (the OpenRouter key) for ${model}.`,
    )
  const baseUrl = openRouterBaseUrl(env)
  const id = openRouterModelId(model)
  return {
    // The model name the SDK receives; `model` stays the report key.
    sdkModel: `${providerName}/${id}`,
    apiKey,
    customProviders: {
      [providerName]: {
        name: providerName,
        protocol: "openai-compatible" as const,
        baseUrl,
        modelIds: [id],
        useChatCompletions: true,
      },
    },
  }
}

/**
 * Put the provider block of ADR-070 on each JSON POST to `baseUrl` until the
 * returned function runs. The eval SDK has no setting for the request body,
 * but its AI SDK client reads `globalThis.fetch` at each call, so this
 * wrapper sees each model call.
 */
export function sendProviderBlock(baseUrl: string): () => void {
  const next = globalThis.fetch
  const prefix = `${baseUrl.replace(/\/+$/, "")}/`
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.method !== "POST" || !request.url.startsWith(prefix))
      return next(request)
    const body = z.record(z.string(), z.unknown()).safeParse(
      await request
        .clone()
        .json()
        .catch(() => undefined),
    ).data
    if (!body) return next(request)
    return next(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(withOpenRouterProvider(body)),
        signal: request.signal,
      }),
    )
  }
  globalThis.fetch = Object.assign(wrapped, next)
  return () => {
    globalThis.fetch = next
  }
}
