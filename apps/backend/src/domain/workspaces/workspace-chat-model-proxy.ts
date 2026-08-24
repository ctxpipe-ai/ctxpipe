import { timingSafeEqual } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { log } from "evlog"
import type { ModelParams } from "../../retrieval/services/modelParams.js"
import { lowerOpenAiChatCompletionsParams } from "../../retrieval/services/providers/openAILikeModelProvider.js"

export type WorkspaceChatModelProxy = {
  baseUrl: string
  close: () => Promise<void>
}

export async function startWorkspaceChatModelProxy(input: {
  runToken: string
  upstreamBaseUrl: string
  upstreamApiKey: string
  modelBase: string
  modelParams?: ModelParams
  listenHost?: string
  advertisedHost?: string
  fetch?: typeof fetch
}): Promise<WorkspaceChatModelProxy> {
  const doFetch = input.fetch ?? fetch
  const listenHost = input.listenHost ?? "127.0.0.1"
  const advertisedHost = input.advertisedHost ?? "127.0.0.1"
  const server = createServer((req, res) => {
    void handleProxyRequest(req, res, input, doFetch)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, listenHost, () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("Workspace chat model proxy failed to bind")
  }
  return {
    baseUrl: `http://${advertisedHost}:${address.port}`,
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
    modelParams?: ModelParams
  },
  doFetch: typeof fetch,
): Promise<void> {
  if (!bearerMatches(headerValue(req.headers.authorization), input.runToken)) {
    writeJson(res, 401, { error: "Unauthorized" })
    return
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1")
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
  const startedAt = Date.now()
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
  log.info({
    step: "workspace-chat-model-proxy",
    path: url.pathname,
    status: upstream.status,
    durationMs: Date.now() - startedAt,
    model: typeof forwarded.model === "string" ? forwarded.model : undefined,
  })

  const contentType = upstream.headers.get("content-type") ?? "application/json"
  res.writeHead(upstream.status, { "content-type": contentType })
  if (!upstream.body) {
    res.end()
    return
  }
  const reader = upstream.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) res.write(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
    res.end()
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
