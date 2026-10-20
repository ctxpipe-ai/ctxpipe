import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { startIngestModelCall } from "../../domain/ingestion/ingest-telemetry.js"
import {
  observeWorkspaceChatCompletionStream,
  recordWorkspaceChatProxyCompletion,
} from "../../domain/workspaces/workspace-chat-model-proxy.js"
import { workspaceChatOpenCodeContract } from "../../domain/workspaces/workspace-chat-opencode-contract.js"
import {
  beginWorkspaceChatProxyGeneration,
  workspaceChatTurnId,
} from "../../domain/workspaces/workspace-chat-otel.js"
import {
  verifyWorkspaceChatRunCapability,
  verifyWorkspaceIngestRunCapability,
} from "../../domain/workspaces/workspace-chat-run-capability.js"
import { workspaceChatBearerToken } from "../../domain/workspaces/workspace-chat-token.js"
import { applyAttribution } from "../../observability/attribution.js"
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

/**
 * The caller of a model call: a chat turn, or an ingest step (ADR-052). An
 * ingest step has no conversation: it is attributed to its run, shard, and
 * step.
 */
type ModelCaller = {
  orgId: string
  orgSlug?: string
  conversationId?: string
  runId?: string
  ingest?: { runId: string; shard: number; step: string }
}

async function chatTokenFromRequest(
  c: Parameters<Parameters<OpenAPIHono<AppEnv>["openapi"]>[1]>[0],
): Promise<ModelCaller | undefined> {
  const presented = workspaceChatBearerToken(c.req.header("authorization"))
  if (!presented) return undefined
  const authSecret = c.var.env.AUTH_SECRET
  const chat = await verifyWorkspaceChatRunCapability({
    authSecret,
    token: presented,
    purpose: "workspace-chat-model",
  })
  if (chat) return chat
  const ingest = await verifyWorkspaceIngestRunCapability({
    authSecret,
    token: presented,
  })
  if (!ingest) return undefined
  return {
    orgId: ingest.orgId,
    orgSlug: ingest.orgSlug,
    ingest: { runId: ingest.runId, shard: ingest.shard, step: ingest.step },
  }
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
      "ctxpipe.ingest.run.id": token.ingest?.runId,
      "ctxpipe.ingest.shard": token.ingest
        ? String(token.ingest.shard)
        : undefined,
      "ctxpipe.ingest.step": token.ingest?.step,
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
      // A streamed answer then ends with a `usage` chunk for the span.
      ...(body.stream === true
        ? {
            stream_options: {
              ...(body.stream_options as Record<string, unknown> | undefined),
              include_usage: true,
            },
          }
        : {}),
    }
    // An ingest step has no chat turn to add a generation to.
    const turnId = token.conversationId
      ? workspaceChatTurnId({
          conversationId: token.conversationId,
          runId: token.runId,
        })
      : undefined
    if (turnId)
      beginWorkspaceChatProxyGeneration(turnId, {
        model: contract.modelBase,
        messages: body.messages,
        reasoningEffort: extras.reasoning_effort ?? body.reasoning_effort,
      })
    const startedAt = Date.now()
    let ttfbMs: number | null = null
    const observer = observeWorkspaceChatCompletionStream()
    const markTtfb = () => {
      if (ttfbMs == null) ttfbMs = Date.now() - startedAt
    }
    // An ingest step has a model call in the Langfuse session of its run.
    const ingestCall = token.ingest
      ? startIngestModelCall(token.ingest, contract.modelBase)
      : undefined
    let recorded = false
    const record = (status: number) => {
      if (recorded) return
      recorded = true
      observer.end()
      ingestCall?.finish({
        status,
        durationMs: Date.now() - startedAt,
        finishReason: observer.finishReason,
        responseModel: observer.responseModel,
        usage: observer.usage,
      })
      recordWorkspaceChatProxyCompletion(turnId, {
        ttfbMs: ttfbMs ?? Date.now() - startedAt,
        durationMs: Date.now() - startedAt,
        finishReason: observer.finishReason,
        tools: observer.tools,
        text: observer.text,
        status,
        model: contract.modelBase,
        responseModel: observer.responseModel,
        usage: observer.usage,
      })
    }
    getLogger().info("workspace-chat-model-proxy.request", {
      step: "workspace-chat-model-proxy.request",
      method: "POST",
      path: "/v1/chat/completions",
      conversationId: token.conversationId,
      ingestRunId: token.ingest?.runId,
      ingestStep: token.ingest?.step,
      orgId: token.orgId,
    })
    if (env.MODEL_PROVIDER === "bedrock") {
      const response = await handleNativeBedrockResponse(
        c,
        handleBedrockChatCompletion(env, forwarded),
        {
          observe: (chunk) => {
            markTtfb()
            observer.push(chunk)
          },
          onObservedComplete: record,
        },
      )
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
      onObservedComplete: record,
    })
  })
