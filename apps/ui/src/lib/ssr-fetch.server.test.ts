import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"
import { ssrFetch } from "./ssr-fetch.server"

const PARENT_TRACE = "0af7651916cd43dd8448eb211c80319c"
const PARENT_SPAN = "b7ad6b7169203331"
const incomingTraceparent = `00-${PARENT_TRACE}-${PARENT_SPAN}-01`

const seen: { traceparent: string | null }[] = []
const server = setupServer(
  http.get("http://backend.test/api/v1/workspaces", ({ request }) => {
    seen.push({ traceparent: request.headers.get("traceparent") })
    return HttpResponse.json([])
  }),
)
const exporter = new InMemorySpanExporter()

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" })
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    }),
  )
})
beforeEach(() => {
  seen.length = 0
  exporter.reset()
})
afterEach(() => server.resetHandlers())
afterAll(() => {
  server.close()
  trace.disable()
})

describe("ssrFetch spans", () => {
  it("names the backend call in a child span of the document request", async () => {
    const res = await ssrFetch(
      "http://backend.test/api/v1/workspaces?limit=5",
      { headers: { traceparent: incomingTraceparent, cookie: "s=1" } },
    )
    expect(res.status).toBe(200)

    const [span] = exporter.getFinishedSpans()
    expect(span?.name).toBe("HTTP GET")
    expect(span?.kind).toBe(SpanKind.CLIENT)
    expect(span?.spanContext().traceId).toBe(PARENT_TRACE)
    expect(span?.parentSpanContext?.spanId).toBe(PARENT_SPAN)
    expect(span?.attributes).toMatchObject({
      "http.request.method": "GET",
      "url.path": "/api/v1/workspaces",
      "server.address": "backend.test",
      "http.response.status_code": 200,
    })
    // The backend span joins the same trace under the UI span.
    expect(seen[0]?.traceparent).toBe(
      `00-${PARENT_TRACE}-${span?.spanContext().spanId}-01`,
    )
  })

  it("marks a call that times out as an error", async () => {
    server.use(
      http.get("http://backend.test/api/v1/workspaces", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        return HttpResponse.json([])
      }),
    )
    await expect(
      ssrFetch("http://backend.test/api/v1/workspaces", {
        signal: AbortSignal.timeout(50),
      }),
    ).rejects.toThrow()

    const [span] = exporter.getFinishedSpans()
    expect(span?.status.code).toBe(SpanStatusCode.ERROR)
    expect(span?.events.map((event) => event.name)).toContain("exception")
  })
})

describe("ssrFetch under Bun", () => {
  // The UI server runs on Bun. Bun keeps idle sockets in a pool. When a proxy
  // drops an idle socket without a FIN, the next request on it waits for the
  // whole timeout. This proxy forwards the first request and then goes silent
  // on that socket, as the Railway edge did on pr-280.
  it("does not send a second request on a pooled socket", () => {
    const modulePath = fileURLToPath(
      new URL("./ssr-fetch.server.ts", import.meta.url),
    )
    const script = `
      import net from "node:net"
      import http from "node:http"
      import { ssrFetch } from ${JSON.stringify(modulePath)}
      const upstream = http.createServer((_req, res) => res.end("ok"))
      await new Promise((r) => upstream.listen(0, "127.0.0.1", r))
      const sockets = []
      const proxy = net.createServer((client) => {
        const state = { silent: false }
        sockets.push(state)
        const up = net.connect(upstream.address().port, "127.0.0.1")
        client.on("data", (d) => { if (!state.silent) up.write(d) })
        up.on("data", (d) => { if (!state.silent) client.write(d) })
        client.on("error", () => {})
        up.on("error", () => {})
      })
      await new Promise((r) => proxy.listen(0, "127.0.0.1", r))
      const url = "http://127.0.0.1:" + proxy.address().port + "/"
      await (await ssrFetch(url, {})).text()
      for (const s of sockets) s.silent = true
      try {
        const res = await ssrFetch(url, { signal: AbortSignal.timeout(2000) })
        console.log("second:" + (await res.text()))
      } catch (error) {
        console.log("second:" + error.name)
      }
      process.exit(0)
    `
    const out = execFileSync("bun", ["-e", script], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
      timeout: 15_000,
    })
    expect(out.trim()).toBe("second:ok")
  })
})
