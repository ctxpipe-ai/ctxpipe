import { log } from "../../observability/logger.js"
import { recordWorkspaceChatProxyGeneration } from "./workspace-chat-otel.js"

/** Docker sandboxes reach the host via host.docker.internal; unsandboxed OpenCode is local. */
export function workspaceChatModelProxyAdvertisedHost(
  isolation: "docker" | "unsandboxed" | "railway" | string,
): string {
  return isolation === "docker" ? "host.docker.internal" : "127.0.0.1"
}

export function workspaceChatCompletionsBaseUrl(input: {
  isolation: string
  orgSlug: string
  port: number
}): string {
  const host = workspaceChatModelProxyAdvertisedHost(input.isolation)
  return `http://${host}:${input.port}/${input.orgSlug}/api/v1/workspace-chat/openai/v1`
}

export function observeWorkspaceChatCompletionStream(): {
  push: (chunk: Uint8Array) => void
  finishReason: string | null
  tools: string[]
  text: string
} {
  const decoder = new TextDecoder()
  let buffer = ""
  let text = ""
  const tools = new Set<string>()
  let finishReason: string | null = null
  return {
    get finishReason() {
      return finishReason
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
      for (const line of lines) {
        const payload = line.startsWith("data:")
          ? line.slice(5).trim()
          : line.trim()
        if (!payload || payload === "[DONE]") continue
        try {
          noteCompletionJson(JSON.parse(payload) as Record<string, unknown>)
        } catch {
          /* ignore partial SSE */
        }
      }
    },
  }

  function noteCompletionJson(json: Record<string, unknown>): void {
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
  conversationId: string | undefined,
  input: {
    ttfbMs: number
    durationMs: number
    finishReason: string | null
    tools: string[]
    text?: string
    status: number
    model?: string
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
  if (!conversationId) return
  recordWorkspaceChatProxyGeneration(conversationId, {
    ttfbMs: input.ttfbMs,
    durationMs: input.durationMs,
    finishReason: input.finishReason,
    tools: input.tools,
    ...(input.text?.trim() ? { text: input.text } : {}),
  })
}
