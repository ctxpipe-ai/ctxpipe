import type { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { getLogger } from "../../observability/logger.js"

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
    return "ctx| memory proxy is not configured on this server. Ask your operator to set MODEL_PROVIDER=bedrock and grant the runtime IAM permissions to invoke Bedrock models (for example an ECS task role with bedrock:InvokeModel)."
  }
  return "ctx| memory proxy is not configured on this server. Ask your operator to set MODEL_PROVIDER_API_KEY (or MODEL_PROVIDER=bedrock with IAM for Amazon Bedrock)."
}

export function unavailableResponse(reason: string, message: string) {
  return {
    status: "enhanced-memory-unavailable" as const,
    reason,
    message,
  }
}

export async function resolveUpstreamAuthorization(
  env: AppEnv["Variables"]["env"],
): Promise<string | null> {
  const apiKey = env.MODEL_PROVIDER_API_KEY?.trim()
  if (apiKey) return `Bearer ${apiKey}`
  return null
}

export async function fetchOpenAiCompatibleUpstream(input: {
  env: AppEnv["Variables"]["env"]
  path: string
  body: unknown
  fetch?: typeof fetch
}): Promise<
  | { ok: true; upstream: Response; target: string; startedAt: number }
  | { ok: false; reason: "no-upstream-key" | "unreachable" }
> {
  const authorization = await resolveUpstreamAuthorization(input.env)
  if (!authorization) return { ok: false, reason: "no-upstream-key" }
  const upstreamOrigin = (
    input.env.MODEL_PROVIDER_URL ?? "https://api.openai.com"
  ).replace(/\/+$/, "")
  const cleanOrigin = upstreamOrigin.replace(/\/v1$/, "")
  const target = `${cleanOrigin}${input.path}`
  const startedAt = Date.now()
  try {
    const upstream = await (input.fetch ?? fetch)(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization,
      },
      body: JSON.stringify(input.body),
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
    observe?: (chunk: Uint8Array) => void
    onObservedComplete?: () => void
  },
) {
  const env = c.var.env
  const fetched = await fetchOpenAiCompatibleUpstream({ env, path, body })
  if (!fetched.ok) {
    if (fetched.reason === "no-upstream-key") {
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
  if (!options?.observe || !upstream.body) {
    options?.onObservedComplete?.()
    return c.body(upstream.body, status, Object.fromEntries(headers))
  }
  const observed = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        options.observe?.(chunk)
        controller.enqueue(chunk)
      },
      flush() {
        options.onObservedComplete?.()
      },
    }),
  )
  return c.body(observed, status, Object.fromEntries(headers))
}

export async function handleNativeBedrockResponse(
  c: OpenAiProxyContext,
  responsePromise: Promise<Response>,
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
      return c.json(errorBody, response.status as 400 | 401 | 404 | 429 | 503)
    }

    if (contentType?.includes("text/event-stream")) {
      return c.body(response.body, 200, Object.fromEntries(headers))
    }

    const json = await response.json()
    return c.json(json, 200)
  } catch (err) {
    getLogger().error(err instanceof Error ? err : new Error(String(err)), {
      step: "openai-proxy",
      provider: "bedrock-native",
      orgId: c.get("orgId"),
      userId: c.get("user")?.id,
    })
    return c.json({ error: "bedrock request failed" }, 502)
  }
}
