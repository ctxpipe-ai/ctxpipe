import type { OpenAPIHono } from "@hono/zod-openapi"

import type { AppEnv } from "../../app/env.js"
import { getLogger } from "../../observability/logger.js"
import { proxiedBody } from "../../retrieval/services/openRouterProvider.js"

type OpenAiProxyContext = Parameters<
  Parameters<OpenAPIHono<AppEnv>["openapi"]>[1]
>[0]

export function hasUpstreamAuth(env: AppEnv["Variables"]["env"]): boolean {
  if (env.MODEL_PROVIDER_API_KEY?.trim()) return true
  return env.MODEL_PROVIDER === "bedrock"
}

export function upstreamAuthUnavailableMessage(
  env: AppEnv["Variables"]["env"],
): string {
  if (env.MODEL_PROVIDER === "bedrock") {
    return "ctxpipe memory proxy is not configured on this server. Ask your operator to set MODEL_PROVIDER=bedrock and grant the runtime IAM permissions to invoke Bedrock models (for example an ECS task role with bedrock:InvokeModel)."
  }
  return "ctxpipe memory proxy is not configured on this server. Ask your operator to set MODEL_PROVIDER_API_KEY (or MODEL_PROVIDER=bedrock with IAM for Amazon Bedrock)."
}

export function unavailableResponse(reason: string, message: string) {
  return {
    status: "enhanced-memory-unavailable" as const,
    reason,
    message,
  }
}

async function resolveUpstreamAuthorization(
  env: AppEnv["Variables"]["env"],
): Promise<string | null> {
  const apiKey = env.MODEL_PROVIDER_API_KEY?.trim()
  if (apiKey) return `Bearer ${apiKey}`
  return null
}

async function fetchOpenAiCompatibleUpstream(input: {
  env: AppEnv["Variables"]["env"]
  path: string
  body: unknown
  origin?: string
  fetch?: typeof fetch
}): Promise<
  | { ok: true; upstream: Response; target: string; startedAt: number }
  | { ok: false; reason: "no-upstream-key" | "unreachable" }
> {
  const authorization = await resolveUpstreamAuthorization(input.env)
  if (!authorization) return { ok: false, reason: "no-upstream-key" }
  const upstreamOrigin = (
    input.origin?.trim() ||
    input.env.MODEL_PROVIDER_URL?.trim() ||
    "https://openrouter.ai/api/v1"
  ).replace(/\/+$/, "")
  const cleanOrigin = upstreamOrigin.replace(/\/v1$/, "")
  const target = `${cleanOrigin}${input.path}`
  // The provider block goes over the provider fields of the client
  // (ADR-070): a client cannot turn off ZDR or leave the allowlist.
  const body = proxiedBody(input.env.MODEL_PROVIDER, upstreamOrigin, input.body)
  const startedAt = Date.now()
  try {
    const upstream = await (input.fetch ?? fetch)(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization,
      },
      body: JSON.stringify(body),
    })
    return { ok: true, upstream, target, startedAt }
  } catch {
    return { ok: false, reason: "unreachable" }
  }
}

export async function forwardToUpstream(
  c: OpenAiProxyContext,
  path: string,
  body: unknown,
  options?: {
    conversationId?: string
    step?: string
    origin?: string
    observe?: (chunk: Uint8Array) => void
    onObservedComplete?: (status: number) => void | Promise<void>
  },
) {
  const env = c.var.env
  const fetched = await fetchOpenAiCompatibleUpstream({
    env,
    path,
    body,
    origin: options?.origin,
  })
  if (!fetched.ok) {
    if (fetched.reason === "no-upstream-key") {
      void options?.onObservedComplete?.(503)
      return c.json(
        unavailableResponse(
          "no-upstream-key",
          upstreamAuthUnavailableMessage(env),
        ),
        503,
      )
    }
    getLogger().error(new Error("upstream unreachable"), {
      step: options?.step ?? "openai-proxy",
      path,
      orgId: c.get("orgId"),
      conversationId: options?.conversationId,
    })
    void options?.onObservedComplete?.(502)
    return c.json({ error: "upstream unreachable" }, 502)
  }
  const { upstream, target, startedAt } = fetched
  getLogger().info("request completed", {
    step: options?.step ?? "openai-proxy",
    target,
    status: upstream.status,
    latencyMs: Date.now() - startedAt,
    orgId: c.get("orgId"),
    conversationId: options?.conversationId,
    userId: c.get("user")?.id,
  })
  const headers = new Headers()
  const contentType = upstream.headers.get("content-type")
  if (contentType) headers.set("content-type", contentType)
  const status = upstream.status as 200 | 400 | 401 | 404 | 429 | 503
  return c.body(
    observedBody(upstream, options, c.req.raw.signal),
    status,
    Object.fromEntries(headers),
  )
}

type CompletionObserver = {
  observe?: (chunk: Uint8Array) => void
  /**
   * A returned promise holds back the end of a complete body until it
   * settles, so that a write of the call's cost ends before the caller sees
   * the end of the answer.
   */
  onObservedComplete?: (status: number) => void | Promise<void>
}

/** Close the observation on EOF, upstream failure, or client cancellation. */
function observedBody(
  response: Response,
  observer?: CompletionObserver,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  if (!observer?.observe || !response.body) {
    void observer?.onObservedComplete?.(response.status)
    // No upstream body sends an empty body.
    return (
      response.body ??
      new ReadableStream<Uint8Array>({
        start: (controller) => controller.close(),
      })
    )
  }
  const reader = response.body.getReader()
  let ended = false
  const finish = async (status: number) => {
    if (ended) return
    ended = true
    signal?.removeEventListener("abort", abort)
    await observer.onObservedComplete?.(status)
  }
  const abort = () => {
    void finish(499).finally(() => reader.cancel().catch(() => {}))
  }
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  const endMarker = sseEndMarker()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // A pull that enqueues nothing can stall the stream: read on until
        // there are bytes to give or the body ends.
        for (;;) {
          const { value, done } = await reader.read()
          if (done) {
            await finish(response.status)
            const end = endMarker.rest()
            if (end.length) controller.enqueue(end)
            controller.close()
            return
          }
          observer.observe?.(value)
          const ready = endMarker.take(value)
          if (ready.length) {
            controller.enqueue(ready)
            return
          }
        }
      } catch (error) {
        await finish(502)
        controller.error(error)
      }
    },
    async cancel(reason) {
      await finish(499)
      await reader.cancel(reason)
    },
  })
}

/**
 * Hold back the SSE end marker (`data: [DONE]` at the start of a line) and
 * all bytes after it until the body ends. A client can stop at the marker, so
 * it must not get it before `onObservedComplete` settles (CTX-1522). `take`
 * gives the bytes of a chunk that can go now; it also holds a chunk end that
 * can be the start of a marker that the next chunk completes. `rest` gives
 * what it held.
 */
function sseEndMarker() {
  const marker = new TextEncoder().encode("data: [DONE]")
  const newline = 10
  let held = new Uint8Array(0)
  // The last byte that went to the client; the body start is a line start.
  let sent = newline
  let seen = false
  const startsMarkerAt = (bytes: Uint8Array, at: number) => {
    if ((at === 0 ? sent : bytes[at - 1]) !== newline) return false
    for (let i = 0; i < marker.length && at + i < bytes.length; i++)
      if (bytes[at + i] !== marker[i]) return false
    return true
  }
  return {
    take(chunk: Uint8Array): Uint8Array {
      const bytes = new Uint8Array(held.length + chunk.length)
      bytes.set(held)
      bytes.set(chunk, held.length)
      if (seen) {
        held = bytes
        return new Uint8Array(0)
      }
      // The first line start where the marker starts, completely or as a
      // part that runs to the chunk end.
      let at = 0
      while (at < bytes.length && !startsMarkerAt(bytes, at)) at++
      if (at + marker.length <= bytes.length) seen = true
      held = bytes.subarray(at)
      if (at > 0) sent = bytes[at - 1] ?? sent
      return bytes.subarray(0, at)
    },
    rest: () => held,
  }
}

export async function handleNativeBedrockResponse(
  c: OpenAiProxyContext,
  responsePromise: Promise<Response>,
  observer?: CompletionObserver,
) {
  const started = Date.now()
  try {
    const response = await responsePromise
    const latencyMs = Date.now() - started
    getLogger().info("request completed", {
      step: "openai-proxy",
      provider: "bedrock-native",
      status: response.status,
      latencyMs,
      orgId: c.get("orgId"),
      userId: c.get("user")?.id,
    })

    const headers = new Headers()
    const contentType = response.headers.get("content-type")
    if (contentType) headers.set("content-type", contentType)

    if (response.status >= 400) {
      const errorBody = await response.json().catch(() => ({
        error: "bedrock request failed",
      }))
      void observer?.onObservedComplete?.(response.status)
      return c.json(errorBody, response.status as 400 | 401 | 404 | 429 | 503)
    }

    if (contentType?.includes("text/event-stream")) {
      return c.body(
        observedBody(response, observer, c.req.raw.signal),
        200,
        Object.fromEntries(headers),
      )
    }

    const json = await response.json()
    observer?.observe?.(new TextEncoder().encode(JSON.stringify(json)))
    await observer?.onObservedComplete?.(response.status)
    return c.json(json, 200)
  } catch (err) {
    getLogger().error(err instanceof Error ? err : new Error(String(err)), {
      step: "openai-proxy",
      provider: "bedrock-native",
      orgId: c.get("orgId"),
      userId: c.get("user")?.id,
    })
    void observer?.onObservedComplete?.(502)
    return c.json({ error: "bedrock request failed" }, 502)
  }
}
