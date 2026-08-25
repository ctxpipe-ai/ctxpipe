import { afterEach, describe, expect, it } from "vitest"
import { startWorkspaceChatModelProxy } from "./workspace-chat-model-proxy.js"

describe("startWorkspaceChatModelProxy", () => {
  const servers: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it("forwards chat completions to the configured upstream with the run token only", async () => {
    const upstreamHits: Array<{
      url: string
      authorization: string | null
      body: Record<string, unknown>
    }> = []
    const upstream = await listenJson(async (req, url) => {
      const body = (await req.json()) as Record<string, unknown>
      upstreamHits.push({
        url: url.pathname,
        authorization: req.headers.get("authorization"),
        body,
      })
      return {
        id: "chatcmpl_stub",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "stub-ok" },
            finish_reason: "stop",
          },
        ],
      }
    })
    servers.push(upstream)

    const proxy = await startWorkspaceChatModelProxy({
      runToken: "run-token-1",
      upstreamBaseUrl: upstream.baseUrl,
      upstreamApiKey: "sk-upstream-secret",
      modelBase: "openai/gpt-5.6-terra",
      modelParams: { reasoning: { effort: "low" } },
    })
    servers.push(proxy)

    const denied = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong",
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4-5",
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(denied.status).toBe(401)

    const allowed = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer run-token-1",
      },
      body: JSON.stringify({
        model: "ctxpipe/openai/gpt-5.6-terra",
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toMatchObject({
      choices: [{ message: { content: "stub-ok" } }],
    })
    expect(upstreamHits).toEqual([
      {
        url: "/v1/chat/completions",
        authorization: "Bearer sk-upstream-secret",
        body: expect.objectContaining({
          model: "openai/gpt-5.6-terra",
          reasoning_effort: "low",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    ])
  })

  it("can bind an explicitly leased port", async () => {
    const { leaseLocalProcessOpenCodePort } = await import(
      "./workspace-chat-opencode-port.js"
    )
    const lease = await leaseLocalProcessOpenCodePort()
    const proxy = await startWorkspaceChatModelProxy({
      runToken: "run-token-port",
      upstreamBaseUrl: "http://127.0.0.1:9",
      upstreamApiKey: "sk-unused",
      modelBase: "openai/gpt-5.6-terra",
      listenHost: "0.0.0.0",
      advertisedHost: "127.0.0.1",
      port: lease.port,
    })
    servers.push({
      close: async () => {
        await proxy.close()
        await lease.release()
      },
    })
    expect(new URL(proxy.baseUrl).port).toBe(String(lease.port))
  })

  it("listens on all interfaces so a local-process OpenCode can reach it", async () => {
    const proxy = await startWorkspaceChatModelProxy({
      runToken: "run-token-listen",
      upstreamBaseUrl: "http://127.0.0.1:9",
      upstreamApiKey: "sk-unused",
      modelBase: "openai/gpt-5.6-terra",
      listenHost: "0.0.0.0",
      advertisedHost: "127.0.0.1",
    })
    servers.push(proxy)
    const port = Number(new URL(proxy.baseUrl).port)
    expect(proxy.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: "Bearer run-token-listen" },
    })
    expect(res.status).toBe(200)
  })

  it("self-checks on loopback even when advertising host.docker.internal", async () => {
    const proxy = await startWorkspaceChatModelProxy({
      runToken: "run-token-docker-host",
      upstreamBaseUrl: "http://127.0.0.1:9",
      upstreamApiKey: "sk-unused",
      modelBase: "openai/gpt-5.6-terra",
      listenHost: "0.0.0.0",
      advertisedHost: "host.docker.internal",
    })
    servers.push(proxy)
    expect(proxy.baseUrl).toMatch(/^http:\/\/host\.docker\.internal:\d+$/)
    const port = Number(new URL(proxy.baseUrl).port)
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: "Bearer run-token-docker-host" },
    })
    expect(res.status).toBe(200)
  })

  it("lists only the configured model", async () => {
    const proxy = await startWorkspaceChatModelProxy({
      runToken: "run-token-2",
      upstreamBaseUrl: "http://127.0.0.1:9",
      upstreamApiKey: "sk-unused",
      modelBase: "openai/gpt-5.6-terra",
    })
    servers.push(proxy)
    const res = await fetch(`${proxy.baseUrl}/v1/models`, {
      headers: { authorization: "Bearer run-token-2" },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      object: "list",
      data: [{ id: "openai/gpt-5.6-terra", object: "model" }],
    })
  })

  it("records generation TTFB and tool names from upstream SSE", async () => {
    const { beginWorkspaceChatTurn, finishWorkspaceChatTurn } = await import(
      "./workspace-chat-otel.js"
    )
    const upstream = await listenSse([
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"bash"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ])
    servers.push(upstream)
    beginWorkspaceChatTurn("conv_proxy_otel")
    const proxy = await startWorkspaceChatModelProxy({
      runToken: "run-token-otel",
      upstreamBaseUrl: upstream.baseUrl,
      upstreamApiKey: "sk-upstream-secret",
      modelBase: "openai/gpt-5.6-terra",
      conversationId: "conv_proxy_otel",
    })
    servers.push(proxy)
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer run-token-otel",
      },
      body: JSON.stringify({
        model: "ctxpipe/openai/gpt-5.6-terra",
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(200)
    await res.text()
    const summary = finishWorkspaceChatTurn("conv_proxy_otel")
    expect(summary?.loops).toBe(1)
    expect(summary?.generations[0]?.finishReason).toBe("tool_calls")
    expect(summary?.generations[0]?.tools).toEqual(["bash"])
    expect(summary?.generations[0]?.ttfbMs).toBeGreaterThanOrEqual(0)
  })

  it("records stop-generation text from upstream SSE", async () => {
    const {
      beginWorkspaceChatTurn,
      lastWorkspaceChatStopText,
      finishWorkspaceChatTurn,
    } = await import("./workspace-chat-otel.js")
    const upstream = await listenSse([
      'data: {"choices":[{"delta":{"content":"This repo is "},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"a TypeScript monorepo."},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ])
    servers.push(upstream)
    beginWorkspaceChatTurn("conv_proxy_stop_text")
    const proxy = await startWorkspaceChatModelProxy({
      runToken: "run-token-stop",
      upstreamBaseUrl: upstream.baseUrl,
      upstreamApiKey: "sk-upstream-secret",
      modelBase: "openai/gpt-5.6-terra",
      conversationId: "conv_proxy_stop_text",
    })
    servers.push(proxy)
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer run-token-stop",
      },
      body: JSON.stringify({
        model: "ctxpipe/openai/gpt-5.6-terra",
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(200)
    await res.text()
    expect(lastWorkspaceChatStopText("conv_proxy_stop_text")).toBe(
      "This repo is a TypeScript monorepo.",
    )
    finishWorkspaceChatTurn("conv_proxy_stop_text")
  })
})

async function listenJson(
  handler: (req: Request, url: URL) => Promise<unknown>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { createServer } = await import("node:http")
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const request = new Request(url, {
        method: req.method,
        headers: req.headers as HeadersInit,
        body:
          req.method === "GET" || req.method === "HEAD"
            ? undefined
            : Buffer.concat(chunks),
      })
      const json = await handler(request, url)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(json))
    })()
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("expected tcp address")
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

async function listenSse(
  frames: string[],
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { createServer } = await import("node:http")
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const frame of frames) res.write(frame)
    res.end()
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("expected tcp address")
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
