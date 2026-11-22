import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"

import type { AppEnv } from "../../app/env.js"
import {
  type IngestModelTier,
  isIngestModelTier,
} from "../../domain/ingestion/ingest-opencode.js"
import {
  addIngestModelCost,
  type IngestModelCallCost,
  ingestModelCallUsd,
} from "../../domain/ingestion/ingest-spend.js"
import {
  logIngestEvent,
  startIngestModelCall,
} from "../../domain/ingestion/ingest-telemetry.js"
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
import { convertFileParts } from "../../retrieval/services/convertFileParts.js"
import { lowerOpenAiChatCompletionsParams } from "../../retrieval/services/providers/openAILikeModelProvider.js"
import {
  scrubForModel,
  unreadableContentPart,
} from "../../retrieval/services/scrubForModel.js"
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
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "A file part or an image data URL that the proxy cannot convert to text",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    429: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Each file conversion slot is taken",
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Workspace chat model is not configured, or the file converter cannot start",
    },
  },
})

function contractFromEnv(
  env: AppEnv["Variables"]["env"],
  tier: IngestModelTier = "fast",
) {
  return workspaceChatOpenCodeContract(
    {
      MODEL_PROVIDER: env.MODEL_PROVIDER,
      MODEL_PROVIDER_API_KEY: env.MODEL_PROVIDER_API_KEY,
      MODEL_PROVIDER_URL: env.MODEL_PROVIDER_URL,
      MODEL_FAST_NAME: env.MODEL_FAST_NAME,
      MODEL_MEDIUM_NAME: env.MODEL_MEDIUM_NAME,
      MODEL_HIGH_NAME: env.MODEL_HIGH_NAME,
    },
    tier,
  )
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
  ingest?: { runId: string; shard: number; step: string; lockOwner: string }
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
    ingest: {
      runId: ingest.runId,
      shard: ingest.shard,
      step: ingest.step,
      lockOwner: ingest.lockOwner,
    },
  }
}

/**
 * Add the cost of one ingest model call to its step (CTX-1522), before the
 * sandbox sees the end of the answer. A call with no gateway cost counts at
 * the fallback prices and is a log event. A failed write is logged: the
 * answer still goes to the sandbox.
 */
async function recordIngestCallCost(
  orgId: string,
  ingest: NonNullable<ModelCaller["ingest"]>,
  cost: IngestModelCallCost,
): Promise<void> {
  if (cost.estimated)
    logIngestEvent("warn", "ingestion-v2.model-cost-estimated", {
      ingestionRunId: ingest.runId,
      shard: ingest.shard,
      ingestStep: ingest.step,
      usd: cost.usd,
    })
  try {
    await addIngestModelCost({ orgId, ...ingest }, cost.usd)
  } catch (error) {
    getLogger().error(
      error instanceof Error ? error : new Error(String(error)),
      {
        step: "ingestion-v2.model-cost-write-failed",
        ingestionRunId: ingest.runId,
        shard: ingest.shard,
        ingestStep: ingest.step,
      },
    )
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
    // Each PDF file part becomes the text of our converter, and each other
    // file part fails the request (CTX-1454).
    const converted = await convertFileParts(
      await c.req.json().catch(() => ({})),
    )
    if (!converted.ok)
      return c.json({ error: converted.error }, converted.status)
    // The body goes to a model: each secret in it is removed first, and a
    // part that the scrubber cannot read is refused (ADR-072).
    const unreadable = unreadableContentPart(converted.body)
    if (unreadable) return c.json({ error: unreadable }, 400)
    const body = (await scrubForModel(converted.body)) as Record<
      string,
      unknown
    >
    // The request's `model` of an ingest step is its tier name. Each other
    // value from the sandbox (also a configured model name) gets the fast
    // tier. A chat turn always uses the fast tier.
    const tier =
      token.ingest && isIngestModelTier(body.model) ? body.model : "fast"
    const contract = contractFromEnv(env, tier)
    if (!contract.ok) {
      return c.json({ error: contract.error }, 503)
    }
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
    // An ingest step has a model call span, attributed to its run.
    const ingestCall = token.ingest
      ? startIngestModelCall(token.ingest, {
          tier,
          model: contract.modelBase,
        })
      : undefined
    let recorded = false
    const record = async (status: number) => {
      if (recorded) return
      recorded = true
      observer.end()
      const cost = token.ingest ? ingestModelCallUsd(observer.usage) : undefined
      ingestCall?.finish({
        status,
        durationMs: Date.now() - startedAt,
        finishReason: observer.finishReason,
        responseModel: observer.responseModel,
        usage: observer.usage,
        ...(cost ? { cost } : {}),
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
      if (token.ingest && cost)
        await recordIngestCallCost(token.orgId, token.ingest, cost)
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
