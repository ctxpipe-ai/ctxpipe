import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  observeWorkspaceChatCompletionStream,
  recordWorkspaceChatProxyCompletion,
} from "../../domain/workspaces/workspace-chat-model-proxy.js"
import { workspaceChatOpenCodeContract } from "../../domain/workspaces/workspace-chat-opencode-contract.js"
import {
  beginWorkspaceChatProxyGeneration,
  workspaceChatTurnId,
} from "../../domain/workspaces/workspace-chat-otel.js"
import { verifyWorkspaceChatRunCapability } from "../../domain/workspaces/workspace-chat-run-capability.js"
import {
  verifyWorkspaceChatToken,
  workspaceChatBearerToken,
} from "../../domain/workspaces/workspace-chat-token.js"
import { applyAttribution } from "../../observability/attribution.js"
import { runWithLangfuseContext } from "../../observability/langfuse.js"
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
    applyAttribution({
      "ctxpipe.org.id": token.orgId,
      "ctxpipe.conversation.id": token.conversationId,
      ...(token.orgSlug ? { "ctxpipe.org.slug": token.orgSlug } : {}),
    })
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
    return runWithLangfuseContext(
      { sessionId: token.conversationId },
      async () => {
        const turnId = workspaceChatTurnId(token)
        beginWorkspaceChatProxyGeneration(turnId)
        const startedAt = Date.now()
        let ttfbMs: number | null = null
        const observer = observeWorkspaceChatCompletionStream()
        const markTtfb = () => {
          if (ttfbMs == null) ttfbMs = Date.now() - startedAt
        }
        const record = (status: number) => {
          recordWorkspaceChatProxyCompletion(turnId, {
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
      },
    )
  })
