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
  vi,
} from "vitest"
import { Route } from "@/routes/[.]otel.v1.$signal"

type Captured = {
  url: string
  authorization: string | null
  contentType: string | null
  token: string | null
  body: unknown
}

let captured: Captured | null = null
let upstreamPosts = 0

const server = setupServer(
  http.post("http://127.0.0.1:9/*", async ({ request }) => {
    upstreamPosts += 1
    captured = {
      url: request.url,
      authorization: request.headers.get("authorization"),
      contentType: request.headers.get("content-type"),
      token: request.headers.get("x-token"),
      body: await request.json(),
    }
    return HttpResponse.json({ partialSuccess: {} })
  }),
)

const serverHandlers = (
  Route.options as unknown as {
    server: {
      handlers: Record<
        string,
        (ctx: {
          request: Request
          params: { signal: string }
        }) => Promise<Response>
      >
    }
  }
).server.handlers

const post = serverHandlers.POST
if (!post) throw new Error("POST handler missing")

/** Node and Bun omit Content-Length on `new Request`; browsers send it. */
function setKnownContentLength(
  headers: Headers,
  body: BodyInit | null | undefined,
): void {
  if (headers.has("content-length") || body == null) return
  const bytes =
    typeof body === "string"
      ? new TextEncoder().encode(body).byteLength
      : body instanceof Uint8Array
        ? body.byteLength
        : body instanceof ArrayBuffer
          ? body.byteLength
          : null
  if (bytes != null) headers.set("content-length", String(bytes))
}

function sameOriginRequest(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  if (!headers.has("origin")) headers.set("origin", new URL(url).origin)
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  setKnownContentLength(headers, init.body)
  return new Request(url, { method: "POST", ...init, headers })
}

/** Browser hit the public backend; the UI process sees its private host. */
function proxiedUiRequest(init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  headers.set("x-forwarded-host", "backend-pr-343.up.railway.app")
  headers.set("x-forwarded-proto", "https")
  if (!headers.has("origin")) {
    headers.set("origin", "https://backend-pr-343.up.railway.app")
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  setKnownContentLength(headers, init.body)
  return new Request("http://ui.railway.internal:3002/.otel/v1/traces", {
    method: "POST",
    ...init,
    headers,
  })
}

async function postSignal(signal: string, request: Request): Promise<Response> {
  const response = await post({ request, params: { signal } })
  return response
}

describe("POST /.otel/v1/$signal", () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" })
  })

  beforeEach(() => {
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "http://127.0.0.1:9/v1/traces",
    )
    vi.stubEnv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "")
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_HEADERS",
      "authorization=Basic%20abc=,x-token=a=b",
    )
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-343")
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "")
    captured = null
    upstreamPosts = 0
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    server.resetHandlers()
  })

  afterAll(() => {
    server.close()
  })

  it("registers only POST", () => {
    expect(Object.keys(serverHandlers)).toEqual(["POST"])
  })

  it("returns 204 when that signal's exporter endpoint is unset", async () => {
    const logs = await postSignal(
      "logs",
      sameOriginRequest("https://app.example/.otel/v1/logs", { body: "{}" }),
    )
    expect(logs.status).toBe(204)

    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
    const traces = await postSignal(
      "traces",
      sameOriginRequest("https://app.example/.otel/v1/traces", { body: "{}" }),
    )
    expect(traces.status).toBe(204)
    expect(upstreamPosts).toBe(0)
  })

  it("forwards a scrubbed body with the resource pinned to service.name=ui", async () => {
    const response = await postSignal(
      "traces",
      sameOriginRequest("https://app.example/.otel/v1/traces", {
        headers: { Authorization: "browser-should-not-forward" },
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: {
                attributes: [
                  {
                    key: "service.name",
                    value: { stringValue: "backend" },
                  },
                  {
                    key: "enduser.id",
                    value: { stringValue: "user_forged" },
                  },
                  {
                    key: "rum.sessionId",
                    value: { stringValue: "5abd8152fd3ba7e4f4436f9750f5442d" },
                  },
                ],
              },
              scopeSpans: [
                {
                  scope: { name: "Langfuse SDK" },
                  spans: [
                    {
                      name: "GET /.auth/reset-password/sekret?next=1",
                      attributes: [
                        {
                          key: "gen_ai.request.model",
                          value: { stringValue: "gpt-test" },
                        },
                        {
                          key: "location.href",
                          value: {
                            stringValue:
                              "https://user:pass@app.example/.auth/accept-invitation?invitationId=inv_not_real#done",
                          },
                        },
                        {
                          key: "user.email",
                          value: { stringValue: "alice@example.com" },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              resource: {
                attributes: [
                  {
                    key: "rum.sessionId",
                    value: { stringValue: "alice@example.com" },
                  },
                ],
              },
              scopeSpans: [],
            },
          ],
          resourceLogs: [
            {
              scopeLogs: [
                {
                  logRecords: [
                    {
                      body: {
                        stringValue:
                          "see /.auth/api/v1/public/invitations/inv_not_real?x=1 bob@example.com",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(upstreamPosts).toBe(1)
    expect(captured?.url).toBe("http://127.0.0.1:9/v1/traces")
    expect(captured?.authorization).toBe("Basic abc=")
    expect(captured?.token).toBe("a=b")
    expect(captured?.contentType).toBe("application/json")
    const body = captured?.body as {
      resourceSpans: Array<{
        resource: {
          attributes: Array<{ key: string; value: { stringValue: string } }>
        }
        scopeSpans: Array<{
          scope?: { name: string }
          spans: Array<{
            name: string
            attributes: Array<{ key: string; value: { stringValue: string } }>
          }>
        }>
      }>
      resourceLogs: Array<{
        resource: { attributes: Array<{ key: string }> }
        scopeLogs: Array<{
          logRecords: Array<{ body: { stringValue: string } }>
        }>
      }>
    }
    const span = body.resourceSpans[0]?.scopeSpans[0]?.spans[0]
    expect(body.resourceSpans[0]?.scopeSpans[0]?.scope?.name).toBe(
      "Langfuse SDK",
    )
    expect(span?.name).toBe("GET /.auth/reset-password/{token}")
    expect(span?.attributes.map((attribute) => attribute.key)).toEqual([
      "gen_ai.request.model",
      "location.href",
      "user.email",
    ])
    expect(span?.attributes[0]?.value.stringValue).toBe("gpt-test")
    expect(span?.attributes[1]?.value.stringValue).toBe(
      "https://app.example/.auth/accept-invitation",
    )
    expect(span?.attributes[2]?.value.stringValue).toBe("{email}")
    expect(body.resourceSpans[0]?.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "ui" } },
      { key: "service.namespace", value: { stringValue: "ctxpipe" } },
      { key: "deployment.environment", value: { stringValue: "pr-343" } },
      {
        key: "rum.sessionId",
        value: { stringValue: "5abd8152fd3ba7e4f4436f9750f5442d" },
      },
    ])
    expect(body.resourceSpans[1]?.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "ui" } },
      { key: "service.namespace", value: { stringValue: "ctxpipe" } },
      { key: "deployment.environment", value: { stringValue: "pr-343" } },
    ])
    expect(
      body.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.body.stringValue,
    ).toBe("see /.auth/api/v1/public/invitations/{invitation} {email}")
    expect(body.resourceLogs[0]?.resource.attributes[0]?.key).toBe(
      "service.name",
    )
  })

  it("posts logs to OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", async () => {
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
      "http://127.0.0.1:9/otlp/v1/logs",
    )
    const response = await postSignal(
      "logs",
      sameOriginRequest("https://app.example/.otel/v1/logs", { body: "{}" }),
    )
    expect(response.status).toBe(200)
    expect(captured?.url).toBe("http://127.0.0.1:9/otlp/v1/logs")
  })

  it("accepts the public origin when the request host is the private UI host", async () => {
    const response = await postSignal(
      "traces",
      proxiedUiRequest({ body: "{}" }),
    )
    expect(response.status).toBe(200)
    expect(upstreamPosts).toBe(1)
  })

  it("rejects a request with no Origin", async () => {
    const response = await postSignal(
      "traces",
      new Request("https://app.example/.otel/v1/traces", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "2",
          referer: "https://app.example/org/chat",
        },
        body: "{}",
      }),
    )
    expect(response.status).toBe(403)
    expect(upstreamPosts).toBe(0)
  })

  it("rejects a foreign origin even when the forwarded host is the public site", async () => {
    const response = await postSignal(
      "traces",
      proxiedUiRequest({
        headers: { Origin: "https://evil.example" },
        body: "{}",
      }),
    )
    expect(response.status).toBe(403)
    expect(upstreamPosts).toBe(0)
  })

  it("rejects the private UI origin when the forwarded host is the public site", async () => {
    const response = await postSignal(
      "traces",
      proxiedUiRequest({
        headers: { Origin: "http://ui.railway.internal:3002" },
        body: "{}",
      }),
    )
    expect(response.status).toBe(403)
    expect(upstreamPosts).toBe(0)
  })

  it("404s a signal other than traces or logs", async () => {
    const response = await postSignal(
      "metrics",
      sameOriginRequest("https://app.example/.otel/v1/metrics", { body: "{}" }),
    )
    expect(response.status).toBe(404)
    expect(upstreamPosts).toBe(0)
  })

  it("413s a declared body over 1 MiB", async () => {
    const response = await postSignal(
      "traces",
      sameOriginRequest("https://app.example/.otel/v1/traces", {
        headers: { "content-length": String(1024 * 1024 + 1) },
        body: "{}",
      }),
    )
    expect(response.status).toBe(413)
    expect(upstreamPosts).toBe(0)
  })

  it("411s a body with no Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"))
        controller.close()
      },
    })
    const response = await postSignal(
      "traces",
      sameOriginRequest("https://app.example/.otel/v1/traces", {
        body: stream,
        duplex: "half",
      } as RequestInit),
    )
    expect(response.status).toBe(411)
    expect(upstreamPosts).toBe(0)
  })

  it("415s an encoded body", async () => {
    const response = await postSignal(
      "traces",
      sameOriginRequest("https://app.example/.otel/v1/traces", {
        headers: { "content-encoding": "gzip" },
        body: "{}",
      }),
    )
    expect(response.status).toBe(415)
    expect(upstreamPosts).toBe(0)
  })

  it("415s a non-JSON body", async () => {
    const response = await postSignal(
      "traces",
      sameOriginRequest("https://app.example/.otel/v1/traces", {
        headers: { "content-type": "application/x-protobuf" },
        body: new Uint8Array([1, 2, 3]),
      }),
    )
    expect(response.status).toBe(415)
    expect(upstreamPosts).toBe(0)
  })

  it("400s malformed JSON", async () => {
    const response = await postSignal(
      "traces",
      sameOriginRequest("https://app.example/.otel/v1/traces", { body: "{" }),
    )
    expect(response.status).toBe(400)
    expect(upstreamPosts).toBe(0)
  })

  it("204s an empty JSON body without calling upstream", async () => {
    const response = await postSignal(
      "traces",
      sameOriginRequest("https://app.example/.otel/v1/traces"),
    )
    expect(response.status).toBe(204)
    expect(upstreamPosts).toBe(0)
  })

  it("502s when the collector connection fails", async () => {
    server.use(http.post("http://127.0.0.1:9/*", () => HttpResponse.error()))
    const response = await postSignal(
      "traces",
      sameOriginRequest("https://app.example/.otel/v1/traces", { body: "{}" }),
    )
    expect(response.status).toBe(502)
  })

  it("prefers RAILWAY_ENVIRONMENT_NAME, then the resource attribute, then NODE_ENV", async () => {
    const cases = [
      ["pr-343", "deployment.environment=staging", "test", "pr-343"],
      [
        "",
        "service.namespace=ctxpipe,deployment.environment=staging",
        "test",
        "staging",
      ],
      ["", "", "production", "production"],
      ["", "", "test", "development"],
    ] as const
    for (const [railway, attributes, nodeEnv, want] of cases) {
      vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", railway)
      vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", attributes)
      vi.stubEnv("NODE_ENV", nodeEnv)
      const response = await postSignal(
        "traces",
        sameOriginRequest("https://app.example/.otel/v1/traces", {
          body: JSON.stringify({ resourceSpans: [{}] }),
        }),
      )
      expect(response.status).toBe(200)
      expect(deploymentOf(captured?.body)).toBe(want)
    }
  })
})

function deploymentOf(body: unknown): string | undefined {
  const attributes = (
    body as {
      resourceSpans?: Array<{
        resource?: {
          attributes?: Array<{
            key: string
            value?: { stringValue?: string }
          }>
        }
      }>
    }
  ).resourceSpans?.[0]?.resource?.attributes
  return attributes?.find((item) => item.key === "deployment.environment")
    ?.value?.stringValue
}
