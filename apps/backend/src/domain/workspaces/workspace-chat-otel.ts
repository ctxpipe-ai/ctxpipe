import { type Span, trace } from "@opentelemetry/api"
import { log } from "../../observability/logger.js"

export type WorkspaceChatGenerationRecord = {
  index: number
  ttfbMs: number
  durationMs: number
  finishReason: string | null
  tools: string[]
  text?: string
}

export type WorkspaceChatToolRecord = {
  name: string
  durationMs: number
  generationIndex: number
}

type WorkspaceChatTurnState = {
  conversationId: string
  startedAt: number
  firstShownTokenAt: number | null
  generations: WorkspaceChatGenerationRecord[]
  tools: WorkspaceChatToolRecord[]
  pendingTools: string[]
  pendingToolSpans: Span[]
  pendingToolsStartedAt: number | null
  generationSpan: Span | null
  rootSpan: Span
}

const turns = new Map<string, WorkspaceChatTurnState>()
const tracer = () => trace.getTracer("ctxpipe-workspace-chat")

export function beginWorkspaceChatTurn(conversationId: string): void {
  const existing = turns.get(conversationId)
  existing?.rootSpan.end()
  turns.set(conversationId, {
    conversationId,
    startedAt: Date.now(),
    firstShownTokenAt: null,
    generations: [],
    tools: [],
    pendingTools: [],
    pendingToolSpans: [],
    pendingToolsStartedAt: null,
    generationSpan: null,
    rootSpan: tracer().startSpan("workspace-chat.turn", {
      attributes: {
        "workspace_chat.conversation_id": conversationId,
      },
    }),
  })
}

export function markWorkspaceChatFirstShownToken(conversationId: string): void {
  const state = turns.get(conversationId)
  if (!state || state.firstShownTokenAt != null) return
  state.firstShownTokenAt = Date.now()
}

export function beginWorkspaceChatProxyGeneration(
  conversationId: string,
): void {
  const state = turns.get(conversationId)
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
  state.generationSpan = tracer().startSpan(
    `generation #${state.generations.length}`,
    {
      attributes: {
        "gen_ai.operation.name": "chat",
        "workspace_chat.conversation_id": conversationId,
        "workspace_chat.generation.index": state.generations.length,
      },
    },
  )
}

export function recordWorkspaceChatProxyGeneration(
  conversationId: string,
  input: {
    ttfbMs: number
    durationMs: number
    finishReason: string | null
    tools: string[]
    text?: string
  },
): void {
  const state = turns.get(conversationId)
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
  })
  state.generationSpan?.end()
  state.generationSpan = null
  state.generations.push(generation)
  if (input.tools.length > 0) {
    state.pendingTools = input.tools
    state.pendingToolsStartedAt = Date.now()
    state.pendingToolSpans = input.tools.map((name) =>
      tracer().startSpan(`tool ${name}`, {
        attributes: {
          "gen_ai.tool.name": name,
          "gen_ai.tool.type": "function",
          "workspace_chat.conversation_id": conversationId,
        },
      }),
    )
  }
}

export function lastWorkspaceChatStopText(conversationId: string): string {
  const state = turns.get(conversationId)
  if (!state) return ""
  for (let i = state.generations.length - 1; i >= 0; i -= 1) {
    const generation = state.generations[i]
    const finish = generation?.finishReason
    const text = generation?.text?.trim() ?? ""
    if ((finish === "stop" || finish === "length") && text) return text
  }
  return ""
}

export function finishWorkspaceChatTurn(
  conversationId: string,
  input?: { error?: string },
): {
  loops: number
  ttftMs: number | null
  generations: WorkspaceChatGenerationRecord[]
  tools: WorkspaceChatToolRecord[]
} | null {
  const state = turns.get(conversationId)
  if (!state) return null
  turns.delete(conversationId)
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
  log.info({
    step: "workspace-chat-turn",
    conversationId,
    loops: state.generations.length,
    ttftMs,
    generations: state.generations.map(
      ({ text: _text, ...generation }) => generation,
    ),
    tools: state.tools,
    error: input?.error,
    message: `workspace chat turn loops=${state.generations.length} ttftMs=${ttftMs ?? "none"} generations=${generationSummary || "-"} tools=${toolSummary || "-"}`,
  })
  return {
    loops: state.generations.length,
    ttftMs,
    generations: state.generations,
    tools: state.tools,
  }
}
