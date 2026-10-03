/**
 * Org-scoped generic OpenAI-compatible model proxy.
 *
 * Generic surface for signed-in CLI / product consumers (`withBearerAuth`).
 * Local Markdown memory (ADR-024) does not require this route; it remains for
 * other model-proxy uses. Upstream provider comes from `MODEL_PROVIDER_*`.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { modelSpecBase } from "../../retrieval/services/parseModelSpec.js"
import {
  handleBedrockChatCompletion,
  handleBedrockEmbedding,
} from "./bedrockOpenAiProxy.js"
import {
  forwardToUpstream,
  handleNativeBedrockResponse,
  hasUpstreamAuth,
  unavailableResponse,
  upstreamAuthUnavailableMessage,
} from "./openai-upstream.js"

const ErrorResponseSchema = z
  .object({ error: z.string(), allowedModels: z.array(z.string()).optional() })
  .openapi("OpenAIProxyError")

const UnavailableResponseSchema = z
  .object({
    status: z.literal("enhanced-memory-unavailable"),
    reason: z.string(),
    message: z.string(),
  })
  .openapi("OpenAIProxyUnavailable")

const ChatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(z.unknown()).min(1),
    stream: z.boolean().optional(),
  })
  .passthrough()
  .openapi("OpenAIProxyChatRequest")

const EmbeddingRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.unknown(),
  })
  .passthrough()
  .openapi("OpenAIProxyEmbeddingRequest")

const chatRoute = createRoute({
  method: "post",
  path: "/v1/chat/completions",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: ChatCompletionRequestSchema },
      },
    },
  },
  responses: {
    200: { description: "Upstream chat-completion response (JSON or SSE)" },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Model not allowed",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Org not found",
    },
    429: { description: "Upstream rate limited" },
    503: {
      content: { "application/json": { schema: UnavailableResponseSchema } },
      description: "Hosted model proxy not configured on this server",
    },
  },
})

const embeddingsRoute = createRoute({
  method: "post",
  path: "/v1/embeddings",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: EmbeddingRequestSchema },
      },
    },
  },
  responses: {
    200: { description: "Upstream embeddings response" },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Model not allowed",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Org not found",
    },
    503: {
      content: { "application/json": { schema: UnavailableResponseSchema } },
      description: "Hosted model proxy not configured on this server",
    },
  },
})

function configuredChatModelSpecs(env: AppEnv["Variables"]["env"]): string[] {
  return [
    env.MODEL_FAST_NAME,
    env.MODEL_MEDIUM_NAME,
    env.MODEL_HIGH_NAME,
  ].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  )
}

function allowedChatModels(env: AppEnv["Variables"]["env"]): string[] {
  return [...new Set(configuredChatModelSpecs(env).map(modelSpecBase))]
}

function allowedEmbeddingModels(env: AppEnv["Variables"]["env"]): string[] {
  const spec = env.MODEL_EMBEDDING_NAME
  if (typeof spec !== "string" || spec.length === 0) return []
  return [modelSpecBase(spec)]
}

function isModelAllowed(requested: string, configuredSpecs: string[]): boolean {
  const requestedBase = modelSpecBase(requested)
  return configuredSpecs.some((spec) => modelSpecBase(spec) === requestedBase)
}

export const openaiRoutes = new OpenAPIHono<AppEnv>()
  .openapi(chatRoute, async (c) => {
    const auth = ensureAuth(c)
    if (auth !== null) return auth as never
    const env = c.var.env
    if (!hasUpstreamAuth(env)) {
      return c.json(
        unavailableResponse(
          "no-upstream-key",
          upstreamAuthUnavailableMessage(env),
        ),
        503,
      )
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      model?: unknown
      stream?: unknown
      messages?: unknown[]
      temperature?: number
    }
    const allowed = allowedChatModels(env)
    const configured = configuredChatModelSpecs(env)
    if (allowed.length === 0) {
      return c.json(
        unavailableResponse(
          "no-models-configured",
          "Model allowlist is empty. Set MODEL_FAST_NAME (and related MODEL_* names) on the server.",
        ),
        503,
      )
    }
    if (
      typeof body.model === "string" &&
      !isModelAllowed(body.model, configured)
    ) {
      return c.json(
        {
          error: "model not allowed",
          allowedModels: allowed,
        },
        400,
      )
    }
    if (env.MODEL_PROVIDER === "bedrock") {
      return handleNativeBedrockResponse(
        c,
        handleBedrockChatCompletion(env, body),
      )
    }
    return forwardToUpstream(c, "/v1/chat/completions", body)
  })
  .openapi(embeddingsRoute, async (c) => {
    const auth = ensureAuth(c)
    if (auth !== null) return auth as never
    const env = c.var.env
    if (!hasUpstreamAuth(env)) {
      return c.json(
        unavailableResponse(
          "no-upstream-key",
          upstreamAuthUnavailableMessage(env),
        ),
        503,
      )
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      model?: unknown
      input?: unknown
    }
    const allowed = allowedEmbeddingModels(env)
    const embeddingSpec =
      typeof env.MODEL_EMBEDDING_NAME === "string" &&
      env.MODEL_EMBEDDING_NAME.length > 0
        ? env.MODEL_EMBEDDING_NAME
        : undefined
    if (
      allowed.length > 0 &&
      typeof body.model === "string" &&
      embeddingSpec !== undefined &&
      !isModelAllowed(body.model, [embeddingSpec])
    ) {
      return c.json(
        {
          error: "model not allowed",
          allowedModels: allowed,
        },
        400,
      )
    }
    if (env.MODEL_PROVIDER === "bedrock") {
      return handleNativeBedrockResponse(
        c,
        handleBedrockEmbedding(env, body),
      )
    }
    return forwardToUpstream(c, "/v1/embeddings", body)
  })

function ensureAuth(
  c: Parameters<Parameters<OpenAPIHono<AppEnv>["openapi"]>[1]>[0],
) {
  if (!c.get("user") || !c.get("session")) {
    return c.json({ error: "Unauthorized" }, 401)
  }
  if (!c.get("orgId")) {
    return c.json({ error: "Not found" }, 404)
  }
  return null
}
