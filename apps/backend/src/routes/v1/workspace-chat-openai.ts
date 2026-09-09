import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { resolveWorkspaceChatGitCredential } from "../../domain/workspaces/workspace-chat-git-credentials.js"
import {
  observeWorkspaceChatCompletionStream,
  recordWorkspaceChatProxyCompletion,
} from "../../domain/workspaces/workspace-chat-model-proxy.js"
import { workspaceChatOpenCodeContract } from "../../domain/workspaces/workspace-chat-opencode-contract.js"
import { beginWorkspaceChatProxyGeneration } from "../../domain/workspaces/workspace-chat-otel.js"
import { verifyWorkspaceChatRunCapability } from "../../domain/workspaces/workspace-chat-run-capability.js"
import {
  verifyWorkspaceChatToken,
  workspaceChatBearerToken,
} from "../../domain/workspaces/workspace-chat-token.js"
import { getLogger } from "../../observability/logger.js"
import { lowerOpenAiChatCompletionsParams } from "../../retrieval/services/providers/openAILikeModelProvider.js"
import { handleBedrockChatCompletion } from "./bedrockOpenAiProxy.js"
import {
  forwardToUpstream,
  handleNativeBedrockResponse,
  hasUpstreamAuth,
  unavailableResponse,
  upstreamAuthUnavailableMessage,
} from "./openai-upstream.js"

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("WorkspaceChatOpenAIError")

const ChatCompletionRequestSchema = z
  .object({
    model: z.string().min(1).optional(),
    messages: z.array(z.unknown()).min(1),
    stream: z.boolean().optional(),
  })
  .passthrough()
  .openapi("WorkspaceChatOpenAIChatRequest")

const modelsRoute = createRoute({
  method: "get",
  path: "/v1/models",
  responses: {
    200: { description: "Locked workspace-chat model list" },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Workspace chat model is not configured",
    },
  },
})

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
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Workspace chat model is not configured",
    },
  },
})

const gitCredentialRoute = createRoute({
  method: "get",
  path: "/v1/git-credentials",
  request: {
    headers: z.object({
      "x-ctxpipe-repository": z.string().max(2048).optional(),
    }),
  },
  responses: {
    200: {
      description: "Short-lived workspace-scoped GitHub read credential",
      content: {
        "application/json": {
          schema: z.object({
            username: z.literal("x-access-token"),
            password: z.string(),
          }),
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "Repository outside workspace read scope",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    503: {
      description: "GitHub read credential unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
})

function contractFromEnv(env: AppEnv["Variables"]["env"]) {
  return workspaceChatOpenCodeContract({
    MODEL_PROVIDER: env.MODEL_PROVIDER,
    MODEL_PROVIDER_API_KEY: env.MODEL_PROVIDER_API_KEY,
    MODEL_PROVIDER_URL: env.MODEL_PROVIDER_URL,
    MODEL_FAST_NAME: env.MODEL_FAST_NAME,
    MODEL_MEDIUM_NAME: env.MODEL_MEDIUM_NAME,
    MODEL_HIGH_NAME: env.MODEL_HIGH_NAME,
  })
}

async function chatTokenFromRequest(
  c: Parameters<Parameters<OpenAPIHono<AppEnv>["openapi"]>[1]>[0],
) {
  const presented = workspaceChatBearerToken(c.req.header("authorization"))
  if (!presented) return undefined
  return (
    verifyWorkspaceChatToken({
      authSecret: c.var.env.AUTH_SECRET,
      token: presented,
    }) ??
    (await verifyWorkspaceChatRunCapability({
      authSecret: c.var.env.AUTH_SECRET,
      token: presented,
      purpose: "workspace-chat-model",
    }))
  )
}

export const workspaceChatOpenaiRoutes = new OpenAPIHono<AppEnv>()
  .openapi(gitCredentialRoute, async (c) => {
    c.header("cache-control", "no-store")
    const capability = workspaceChatBearerToken(c.req.header("authorization"))
    if (!capability) return c.json({ error: "Unauthorized" }, 401)
    try {
      const result = await resolveWorkspaceChatGitCredential({
        env: c.var.env,
        capability,
        repositoryUrl: c.req.valid("header")["x-ctxpipe-repository"],
      })
      if (!result.ok) return c.json({ error: result.error }, result.status)
      return c.json(
        { username: result.username, password: result.password },
        200,
      )
    } catch {
      // Provider errors can contain authorization headers; keep them out of
      // both the client response and the logger's serialized error metadata.
      getLogger().error(
        new Error("Workspace GitHub read credential unavailable"),
        {
          step: "workspace-chat-git-credential",
        },
      )
      return c.json(
        { error: "Workspace GitHub read credential unavailable" },
        503,
      )
    }
  })
  .openapi(modelsRoute, async (c) => {
    const token = await chatTokenFromRequest(c)
    if (!token) return c.json({ error: "Unauthorized" }, 401)
    const contract = contractFromEnv(c.var.env)
    if (!contract.ok) {
      return c.json({ error: contract.error }, 503)
    }
    return c.json({
      object: "list",
      data: [{ id: contract.modelBase, object: "model" }],
    })
  })
  .openapi(chatRoute, async (c) => {
    const token = await chatTokenFromRequest(c)
    if (!token) return c.json({ error: "Unauthorized" }, 401)
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
    const contract = contractFromEnv(env)
    if (!contract.ok) {
      return c.json({ error: contract.error }, 503)
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >
    const extras = lowerOpenAiChatCompletionsParams(contract.modelParams) ?? {}
    const forwarded = {
      ...body,
      ...extras,
      model: contract.modelBase,
    }
    beginWorkspaceChatProxyGeneration(token.conversationId)
    const startedAt = Date.now()
    let ttfbMs: number | null = null
    const observer = observeWorkspaceChatCompletionStream()
    const markTtfb = () => {
      if (ttfbMs == null) ttfbMs = Date.now() - startedAt
    }
    const record = (status: number) => {
      recordWorkspaceChatProxyCompletion(token.conversationId, {
        ttfbMs: ttfbMs ?? Date.now() - startedAt,
        durationMs: Date.now() - startedAt,
        finishReason: observer.finishReason,
        tools: observer.tools,
        text: observer.text,
        status,
        model: contract.modelBase,
      })
    }
    getLogger().info("workspace-chat-model-proxy.request", {
      step: "workspace-chat-model-proxy.request",
      method: "POST",
      path: "/v1/chat/completions",
      conversationId: token.conversationId,
      orgId: token.orgId,
    })
    if (env.MODEL_PROVIDER === "bedrock") {
      const response = await handleNativeBedrockResponse(
        c,
        handleBedrockChatCompletion(env, forwarded),
      )
      record(response.status)
      return response
    }
    return forwardToUpstream(c, "/v1/chat/completions", forwarded, {
      conversationId: token.conversationId,
      step: "workspace-chat-model-proxy",
      origin: contract.upstreamBaseUrl,
      observe: (chunk) => {
        markTtfb()
        observer.push(chunk)
      },
      onObservedComplete: () => record(200),
    })
  })
