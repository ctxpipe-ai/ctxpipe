import { propagateAttributes } from "@langfuse/tracing"
import {
  type Context,
  context,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import { otelMiddleware } from "@tanstack/ai/middlewares/otel"
import {
  contextWithAttributionBag,
  readAttribution,
  sanitizeAttribution,
} from "../../observability/attribution.js"
import { langfusePropagation } from "../../observability/langfuse.js"
import { log } from "../../observability/logger.js"
import { maskCredentialsDeep } from "./mask-credentials.js"
import type { WorkspaceChatCompletionUsage } from "./workspace-chat-model-proxy.js"

type WorkspaceChatGenerationRecord = {
  index: number
  ttfbMs: number
  durationMs: number
  finishReason: string | null
  tools: string[]
  text?: string
}

type WorkspaceChatToolRecord = {
  name: string
  durationMs: number
  generationIndex: number
}

type WorkspaceChatTurnState = {
  conversationId: string
  turnId: string
  startedAt: number
  firstShownTokenAt: number | null
  generations: WorkspaceChatGenerationRecord[]
  tools: WorkspaceChatToolRecord[]
  pendingTools: string[]
  pendingToolSpans: Span[]
  pendingToolsStartedAt: number | null
  generationSpan: Span | null
  rootSpan: Span
  /** The turn's attribution and root span: the parent of each child span. */
  context: Context
}

const turns = new Map<string, WorkspaceChatTurnState>()
const tracer = () => trace.getTracer("ctxpipe-workspace-chat")

/**
 * TanStack spans of a chat turn. Each model call is a `generation #N` span
 * with its own usage and cost, so in Langfuse the TanStack turn summary and
 * its iterations are plain spans: the turn does not count its tokens and
 * cost two times.
 */
export function workspaceChatOtelMiddleware() {
  return otelMiddleware({
    tracer: tracer(),
    attributeEnricher: (info): Record<string, string> =>
      info.kind === "chat" || info.kind === "iteration"
        ? { "langfuse.observation.type": "span" }
        : {},
  })
}

export function workspaceChatTurnId(input: {
  conversationId: string
  runId?: string
}): string {
  return input.runId ?? input.conversationId
}

/** Who runs the turn, for its attribution and Langfuse trace. */
type WorkspaceChatTurnOwner = {
  orgId?: string
  orgSlug?: string
  workspaceId?: string
  /** The person who sent the turn. */
  userId?: string
  /** The conversation source (`ui`, `mcp`, ...), a Langfuse tag. */
  source?: string | null
}

/**
 * Open the turn root span and return the one context of the turn. It holds
 * the attribution that is active now (user, request) plus the owner and the
 * conversation, and the Langfuse trace attributes. Generation and tool spans
 * start under it, also when a proxy request is the active context.
 */
export function beginWorkspaceChatTurn(
  conversationId: string,
  turnId = conversationId,
  owner?: WorkspaceChatTurnOwner,
): Context {
  const previous = turns.get(turnId)
  previous?.rootSpan.end()
  const parent = context.active()
  const { context: bagContext, bag } = contextWithAttributionBag(parent)
  const active = readAttribution()
  // A caller with no auth attribution (the socket) is the user who sent it.
  const sender =
    owner?.userId && !active["ctxpipe.actor.type"]
      ? { "enduser.id": owner.userId, "ctxpipe.actor.type": "user" }
      : {}
  const attribution = {
    ...active,
    ...sanitizeAttribution({
      ...sender,
      "ctxpipe.org.id": owner?.orgId,
      "ctxpipe.org.slug": owner?.orgSlug,
      "ctxpipe.workspace.id": owner?.workspaceId,
      "ctxpipe.conversation.id": conversationId,
    }),
  }
  for (const [key, value] of Object.entries(attribution)) bag.set(key, value)
  const turnParent = context.with(bagContext, () =>
    propagateAttributes(
      {
        ...langfusePropagation({
          sessionId: conversationId,
          userId: owner?.userId,
          tags: owner?.source ? [owner.source] : undefined,
        }),
        // The collector sends only gen_ai spans to Langfuse, so each span
        // of the turn carries the trace name.
        traceName: "workspace-chat",
      },
      () => context.active(),
    ),
  )
  const rootSpan = tracer().startSpan(
    "workspace-chat.turn",
    {
      attributes: {
        ...attribution,
        "workspace_chat.conversation_id": conversationId,
        "workspace_chat.turn_id": turnId,
      },
    },
    turnParent,
  )
  const turnContext = trace.setSpan(turnParent, rootSpan)
  turns.set(turnId, {
    conversationId,
    turnId,
    startedAt: Date.now(),
    firstShownTokenAt: null,
    generations: [],
    tools: [],
    pendingTools: [],
    pendingToolSpans: [],
    pendingToolsStartedAt: null,
    generationSpan: null,
    rootSpan,
    context: turnContext,
  })
  return turnContext
}

/** Run each step of `stream` in the turn context, so its spans join the turn. */
export async function* iterateInWorkspaceChatTurn<T>(
  turnContext: Context,
  stream: AsyncIterable<T>,
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await context.with(turnContext, () => iterator.next())
      if (next.done) return
      yield next.value
    }
  } finally {
    await context.with(turnContext, async () => {
      await iterator.return?.()
    })
  }
}

/** A child of the turn root, linked to the active span (the proxy request). */
function startTurnChildSpan(
  state: WorkspaceChatTurnState,
  name: string,
  attributes: Record<string, string | number>,
): Span {
  const caller = trace.getActiveSpan()?.spanContext()
  return tracer().startSpan(
    name,
    {
      attributes,
      ...(caller && caller.spanId !== state.rootSpan.spanContext().spanId
        ? { links: [{ context: caller }] }
        : {}),
    },
    state.context,
  )
}

export function markWorkspaceChatFirstShownToken(turnId: string): void {
  const state = turns.get(turnId)
  if (!state || state.firstShownTokenAt != null) return
  state.firstShownTokenAt = Date.now()
}

/** Langfuse reads these; the ClickHouse pipeline removes them from HyperDX. */
const MAX_LANGFUSE_CONTENT = 64 * 1024

/**
 * JSON for a Langfuse input or output, at most `MAX_LANGFUSE_CONTENT`
 * characters. Credentials are masked first. A message list keeps its newest
 * whole messages; a text that is still too long keeps its end.
 */
function langfuseContent(value: unknown): string {
  let masked = maskCredentialsDeep(value)
  if (Array.isArray(masked)) {
    let size = JSON.stringify(masked).length
    let start = 0
    while (size > MAX_LANGFUSE_CONTENT && start < masked.length - 1) {
      size -= JSON.stringify(masked[start]).length + 1
      start += 1
    }
    masked = masked.slice(start)
  }
  let json = JSON.stringify(masked)
  // One message or answer is still too long: keep the end of its text.
  const last = Array.isArray(masked) ? masked.at(-1) : masked
  while (
    json.length > MAX_LANGFUSE_CONTENT &&
    last &&
    typeof last === "object" &&
    typeof (last as { content?: unknown }).content === "string"
  ) {
    const item = last as { content: string }
    const keep = item.content.length - (json.length - MAX_LANGFUSE_CONTENT) - 32
    if (keep <= 0) {
      item.content = "[truncated]"
      json = JSON.stringify(masked)
      break
    }
    item.content = `[truncated]${item.content.slice(-keep)}`
    json = JSON.stringify(masked)
  }
  return json.length <= MAX_LANGFUSE_CONTENT
    ? json
    : JSON.stringify("[truncated]")
}

export function beginWorkspaceChatProxyGeneration(
  turnId: string,
  request?: { model?: string; messages?: unknown; reasoningEffort?: unknown },
): void {
  const state = turns.get(turnId)
  if (!state) return
  if (state.pendingToolsStartedAt && state.pendingTools.length > 0) {
    const durationMs = Math.max(0, Date.now() - state.pendingToolsStartedAt)
    for (const [index, name] of state.pendingTools.entries()) {
      state.tools.push({
        name,
        durationMs,
        generationIndex: Math.max(0, state.generations.length - 1),
      })
      const toolSpan = state.pendingToolSpans[index]
      if (toolSpan) {
        toolSpan.setAttribute("workspace_chat.tool.duration_ms", durationMs)
        toolSpan.end()
      }
    }
    state.pendingTools = []
    state.pendingToolSpans = []
    state.pendingToolsStartedAt = null
  }
  state.generationSpan?.end()
  state.generationSpan = startTurnChildSpan(
    state,
    `generation #${state.generations.length}`,
    {
      "gen_ai.operation.name": "chat",
      "workspace_chat.turn_id": turnId,
      "workspace_chat.generation.index": state.generations.length,
      ...(request?.model ? { "gen_ai.request.model": request.model } : {}),
      // The effort sent upstream: traces then show why an answer reasons long.
      ...(typeof request?.reasoningEffort === "string"
        ? {
            "gen_ai.request.reasoning_effort": request.reasoningEffort,
            "langfuse.observation.model.parameters": JSON.stringify({
              reasoning_effort: request.reasoningEffort,
            }),
          }
        : {}),
      ...(request?.messages !== undefined
        ? { "langfuse.observation.input": langfuseContent(request.messages) }
        : {}),
    },
  )
}

export function recordWorkspaceChatProxyGeneration(
  turnId: string,
  input: {
    ttfbMs: number
    durationMs: number
    finishReason: string | null
    tools: string[]
    text?: string
    responseModel?: string
    usage?: WorkspaceChatCompletionUsage
  },
): void {
  const state = turns.get(turnId)
  const generation: WorkspaceChatGenerationRecord = {
    index: state?.generations.length ?? 0,
    ttfbMs: input.ttfbMs,
    durationMs: input.durationMs,
    finishReason: input.finishReason,
    tools: input.tools,
    ...(input.text?.trim() ? { text: input.text } : {}),
  }
  if (!state) return
  state.generationSpan?.setAttributes({
    "workspace_chat.generation.ttfb_ms": input.ttfbMs,
    "workspace_chat.generation.duration_ms": input.durationMs,
    ...(input.finishReason
      ? { "gen_ai.response.finish_reasons": input.finishReason }
      : {}),
    ...(input.responseModel
      ? { "gen_ai.response.model": input.responseModel }
      : {}),
    ...usageAttributes(input.usage),
    "langfuse.observation.output": langfuseContent({
      role: "assistant",
      content: input.text ?? "",
      ...(input.tools.length > 0 ? { tool_calls: input.tools } : {}),
    }),
  })
  state.generationSpan?.end()
  state.generationSpan = null
  state.generations.push(generation)
  if (input.tools.length > 0) {
    state.pendingTools = input.tools
    state.pendingToolsStartedAt = Date.now()
    state.pendingToolSpans = input.tools.map((name) =>
      startTurnChildSpan(state, `tool ${name}`, {
        "gen_ai.tool.name": name,
        "gen_ai.tool.type": "function",
        "workspace_chat.turn_id": turnId,
      }),
    )
  }
}

function usageAttributes(
  usage: WorkspaceChatCompletionUsage | undefined,
): Record<string, number> {
  if (!usage) return {}
  const attributes: Record<string, number | undefined> = {
    "gen_ai.usage.input_tokens": usage.inputTokens,
    "gen_ai.usage.output_tokens": usage.outputTokens,
    "gen_ai.usage.cache_read.input_tokens": usage.cachedInputTokens,
    "gen_ai.usage.cost": usage.cost,
  }
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined),
  ) as Record<string, number>
}

export function finishWorkspaceChatTurn(
  turnId: string,
  input?: { error?: string },
): {
  loops: number
  ttftMs: number | null
  generations: WorkspaceChatGenerationRecord[]
  tools: WorkspaceChatToolRecord[]
} | null {
  const state = turns.get(turnId)
  if (!state) return null
  turns.delete(turnId)
  const ttftMs =
    state.firstShownTokenAt == null
      ? null
      : state.firstShownTokenAt - state.startedAt
  for (const span of state.pendingToolSpans) span.end()
  state.generationSpan?.end()
  state.rootSpan.setAttributes({
    "tanstack.ai.iterations": state.generations.length,
    ...(ttftMs != null ? { "workspace_chat.ttft_ms": ttftMs } : {}),
    ...(input?.error ? { "error.type": input.error } : {}),
  })
  if (input?.error)
    state.rootSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: input.error,
    })
  state.rootSpan.end()
  const generationSummary = state.generations
    .map(
      (generation) =>
        `${generation.index}:ttfb=${generation.ttfbMs},ms=${generation.durationMs},reason=${generation.finishReason ?? "-"},tools=${generation.tools.join("+") || "-"}`,
    )
    .join(";")
  const toolSummary = state.tools
    .map((tool) => `${tool.name}:${tool.durationMs}@${tool.generationIndex}`)
    .join(";")
  // In the turn context, so the log line carries the turn trace id.
  context.with(state.context, () =>
    log.info({
      step: "workspace-chat-turn",
      conversationId: state.conversationId,
      turnId,
      loops: state.generations.length,
      ttftMs,
      generations: state.generations.map(
        ({ text: _text, ...generation }) => generation,
      ),
      tools: state.tools,
      error: input?.error,
      message: `workspace chat turn loops=${state.generations.length} ttftMs=${ttftMs ?? "none"} generations=${generationSummary || "-"} tools=${toolSummary || "-"}`,
    }),
  )
  return {
    loops: state.generations.length,
    ttftMs,
    generations: state.generations,
    tools: state.tools,
  }
}
