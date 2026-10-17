import { log } from "../../observability/logger.js"
import { recordWorkspaceChatProxyGeneration } from "./workspace-chat-otel.js"

/** Use the sandbox callback host when there is one, otherwise provider-local defaults. */
export function workspaceChatModelProxyAdvertisedHost(
  isolation: string,
  callbackHost?: string,
): string {
  if (callbackHost) return callbackHost
  return isolation === "docker" ? "host.docker.internal" : "127.0.0.1"
}

export function workspaceChatCompletionsBaseUrl(input: {
  isolation: string
  orgSlug: string
  port: number
  callbackHost?: string
}): string {
  const host = workspaceChatModelProxyAdvertisedHost(
    input.isolation,
    input.callbackHost,
  )
  return `http://${host}:${input.port}${workspaceChatCompletionsPath(input.orgSlug)}`
}

/** The path of the org's OpenAI-compatible model proxy on the API. */
export function workspaceChatCompletionsPath(orgSlug: string): string {
  return `/${orgSlug}/api/v1/workspace-chat/openai/v1`
}

/** Token counts and cost from an OpenAI-compatible `usage` object. */
export type WorkspaceChatCompletionUsage = {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  /** USD, when the gateway reports it (OpenRouter does). */
  cost?: number
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function completionUsage(value: unknown): WorkspaceChatCompletionUsage | null {
  if (!value || typeof value !== "object") return null
  const usage = value as Record<string, unknown>
  const details =
    usage.prompt_tokens_details &&
    typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : {}
  return {
    inputTokens: numberOrUndefined(usage.prompt_tokens),
    outputTokens: numberOrUndefined(usage.completion_tokens),
    cachedInputTokens: numberOrUndefined(details.cached_tokens),
    cost: numberOrUndefined(usage.cost),
  }
}

export function observeWorkspaceChatCompletionStream(): {
  push: (chunk: Uint8Array) => void
  /** Read the last line, which has no newline in a plain JSON response. */
  end: () => void
  finishReason: string | null
  tools: string[]
  text: string
  responseModel: string | null
  usage: WorkspaceChatCompletionUsage | null
} {
  const decoder = new TextDecoder()
  let buffer = ""
  let text = ""
  const tools = new Set<string>()
  let finishReason: string | null = null
  let responseModel: string | null = null
  let usage: WorkspaceChatCompletionUsage | null = null
  return {
    get finishReason() {
      return finishReason
    },
    get responseModel() {
      return responseModel
    },
    get usage() {
      return usage
    },
    get tools() {
      return [...tools]
    },
    get text() {
      return text
    },
    push(chunk) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) noteLine(line)
    },
    end() {
      buffer += decoder.decode()
      noteLine(buffer)
      buffer = ""
    },
  }

  function noteLine(line: string): void {
    const payload = line.startsWith("data:")
      ? line.slice(5).trim()
      : line.trim()
    if (!payload || payload === "[DONE]") return
    try {
      noteCompletionJson(JSON.parse(payload) as Record<string, unknown>)
    } catch {
      /* ignore partial SSE */
    }
  }

  function noteCompletionJson(json: Record<string, unknown>): void {
    if (typeof json.model === "string" && json.model) responseModel = json.model
    usage = completionUsage(json.usage) ?? usage
    const choices = Array.isArray(json.choices) ? json.choices : []
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue
      const record = choice as Record<string, unknown>
      if (typeof record.finish_reason === "string") {
        finishReason = record.finish_reason
      }
      const delta =
        record.delta && typeof record.delta === "object"
          ? (record.delta as Record<string, unknown>)
          : record.message && typeof record.message === "object"
            ? (record.message as Record<string, unknown>)
            : null
      if (typeof delta?.content === "string") text += delta.content
      const calls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : []
      for (const call of calls) {
        if (!call || typeof call !== "object") continue
        const fn = (call as { function?: { name?: unknown } }).function
        if (typeof fn?.name === "string" && fn.name.trim()) tools.add(fn.name)
      }
    }
  }
}

export function recordWorkspaceChatProxyCompletion(
  turnId: string | undefined,
  input: {
    ttfbMs: number
    durationMs: number
    finishReason: string | null
    tools: string[]
    text?: string
    status: number
    model?: string
    responseModel?: string | null
    usage?: WorkspaceChatCompletionUsage | null
  },
): void {
  log.info({
    step: "workspace-chat-model-proxy",
    path: "/v1/chat/completions",
    status: input.status,
    durationMs: input.durationMs,
    ttfbMs: input.ttfbMs,
    finishReason: input.finishReason,
    tools: input.tools,
    model: input.model,
    message: `workspace chat generation ttfbMs=${input.ttfbMs} durationMs=${input.durationMs} finishReason=${input.finishReason ?? "-"} tools=${input.tools.join(",") || "-"}`,
  })
  if (!turnId) return
  recordWorkspaceChatProxyGeneration(turnId, {
    ttfbMs: input.ttfbMs,
    durationMs: input.durationMs,
    finishReason: input.finishReason,
    tools: input.tools,
    ...(input.text?.trim() ? { text: input.text } : {}),
    responseModel: input.responseModel ?? undefined,
    usage: input.usage ?? undefined,
  })
}
