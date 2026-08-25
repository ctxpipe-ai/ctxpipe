import { timingSafeEqual } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { log } from "../../observability/logger.js"
import type { ModelParams } from "../../retrieval/services/modelParams.js"
import { lowerOpenAiChatCompletionsParams } from "../../retrieval/services/providers/openAILikeModelProvider.js"
import {
  beginWorkspaceChatProxyGeneration,
  recordWorkspaceChatProxyGeneration,
} from "./workspace-chat-otel.js"

export type WorkspaceChatModelProxy = {
  baseUrl: string
  close: () => Promise<void>
}

export async function startWorkspaceChatModelProxy(input: {
  runToken: string
  upstreamBaseUrl: string
  upstreamApiKey: string
  modelBase: string
  conversationId?: string
  modelParams?: ModelParams
  listenHost?: string
  advertisedHost?: string
  port?: number
  fetch?: typeof fetch
}): Promise<WorkspaceChatModelProxy> {
  const doFetch = input.fetch ?? fetch
  const listenHost = input.listenHost ?? "0.0.0.0"
  const advertisedHost = input.advertisedHost ?? "127.0.0.1"
  const server = createServer((req, res) => {
    void handleProxyRequest(req, res, input, doFetch)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(input.port ?? 0, listenHost, () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("Workspace chat model proxy failed to bind")
  }
  const baseUrl = `http://${advertisedHost}:${address.port}`
  const ready = await doFetch(`${baseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${input.runToken}` },
  }).catch((error: unknown) => {
    throw new Error(
      `Workspace chat model proxy bound ${listenHost}:${address.port} but is not reachable at ${baseUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  })
  if (!ready.ok) {
    throw new Error(
      `Workspace chat model proxy self-check failed at ${baseUrl}/v1/models (${ready.status})`,
    )
  }
  log.info({
    step: "workspace-chat-model-proxy.listen",
    listenHost,
    port: address.port,
    advertisedHost,
  })
  return {
    baseUrl,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const prefix = "Bearer "
  if (!header?.startsWith(prefix)) return false
  const presented = header.slice(prefix.length)
  const expected = Buffer.from(token)
  const actual = Buffer.from(presented)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

async function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  input: {
    runToken: string
    upstreamBaseUrl: string
    upstreamApiKey: string
    modelBase: string
    conversationId?: string
    modelParams?: ModelParams
  },
  doFetch: typeof fetch,
): Promise<void> {
  if (!bearerMatches(headerValue(req.headers.authorization), input.runToken)) {
    writeJson(res, 401, { error: "Unauthorized" })
    return
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1")
  log.info({
    step: "workspace-chat-model-proxy.request",
    method: req.method,
    path: url.pathname,
    message: `workspace chat proxy ${req.method} ${url.pathname}`,
  })
  if (req.method === "GET" && url.pathname === "/v1/models") {
    writeJson(res, 200, {
      object: "list",
      data: [{ id: input.modelBase, object: "model" }],
    })
    return
  }

  if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    writeJson(res, 404, { error: "Not found" })
    return
  }

  const raw = await readBody(req)
  let body: Record<string, unknown> = {}
  try {
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    writeJson(res, 400, { error: "invalid json" })
    return
  }

  const extras = lowerOpenAiChatCompletionsParams(input.modelParams) ?? {}
  const forwarded = {
    ...body,
    ...extras,
    model: input.modelBase,
  }
  const origin = input.upstreamBaseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")
  const target = `${origin}/v1/chat/completions`
  if (input.conversationId) {
    beginWorkspaceChatProxyGeneration(input.conversationId)
  }
  const startedAt = Date.now()
  let ttfbMs: number | null = null
  let upstream: Response
  try {
    upstream = await doFetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.upstreamApiKey}`,
      },
      body: JSON.stringify(forwarded),
    })
    ttfbMs = Date.now() - startedAt
  } catch {
    log.error({
      step: "workspace-chat-model-proxy",
      path: url.pathname,
      status: 502,
      durationMs: Date.now() - startedAt,
      message: "upstream unreachable",
    })
    writeJson(res, 502, { error: "upstream unreachable" })
    return
  }

  const contentType = upstream.headers.get("content-type") ?? "application/json"
  res.writeHead(upstream.status, { "content-type": contentType })
  if (!upstream.body) {
    recordProxyCompletion(input.conversationId, {
      ttfbMs: ttfbMs ?? Date.now() - startedAt,
      durationMs: Date.now() - startedAt,
      finishReason: null,
      tools: [],
      status: upstream.status,
      model: typeof forwarded.model === "string" ? forwarded.model : undefined,
    })
    res.end()
    return
  }
  const observer = createCompletionObserver()
  const reader = upstream.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (ttfbMs == null) ttfbMs = Date.now() - startedAt
      observer.push(value)
      res.write(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
    res.end()
    recordProxyCompletion(input.conversationId, {
      ttfbMs: ttfbMs ?? Date.now() - startedAt,
      durationMs: Date.now() - startedAt,
      finishReason: observer.finishReason,
      tools: observer.tools,
      text: observer.text,
      status: upstream.status,
      model: typeof forwarded.model === "string" ? forwarded.model : undefined,
    })
  }
}

function recordProxyCompletion(
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

function createCompletionObserver(): {
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

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}
