import { syncBuiltinESMExports } from "node:module"

import { type ProxyTracerProvider, trace } from "@opentelemetry/api"
import { logs } from "@opentelemetry/api-logs"
import type { LoggerProvider } from "@opentelemetry/sdk-logs"
import type { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import {
  scrubServerErrorText,
  serverTelemetryEndpoints,
  startServerTelemetry,
  traceServerRequest,
} from "@/lib/serverTelemetry"

type AnyValue = { stringValue?: string; intValue?: number | string }
type KeyValue = { key: string; value: AnyValue }
type OtlpSpan = {
  name: string
  kind: number
  traceId: string
  status: { code?: number }
  attributes: KeyValue[]
  events: { name: string; attributes: KeyValue[] }[]
}
type OtlpLog = {
  severityNumber: number
  severityText: string
  traceId: string
  body: AnyValue
  attributes: KeyValue[]
}

const collector = "http://collector.test:4318"
const spans: OtlpSpan[] = []
const records: OtlpLog[] = []
const resources: KeyValue[][] = []

const server = setupServer(
  http.post(`${collector}/v1/traces`, async ({ request }) => {
    const body = (await request.json()) as {
      resourceSpans: {
        resource: { attributes: KeyValue[] }
        scopeSpans: { spans: OtlpSpan[] }[]
      }[]
    }
    for (const resourceSpans of body.resourceSpans) {
      resources.push(resourceSpans.resource.attributes)
      for (const scope of resourceSpans.scopeSpans) spans.push(...scope.spans)
    }
    return HttpResponse.json({})
  }),
  http.post(`${collector}/v1/logs`, async ({ request }) => {
    const body = (await request.json()) as {
      resourceLogs: { scopeLogs: { logRecords: OtlpLog[] }[] }[]
    }
    for (const resourceLogs of body.resourceLogs) {
      for (const scope of resourceLogs.scopeLogs)
        records.push(...scope.logRecords)
    }
    return HttpResponse.json({})
  }),
)

function attributes(list: KeyValue[]): Record<string, unknown> {
  return Object.fromEntries(
    list.map(({ key, value }) => [
      key,
      value.stringValue ?? Number(value.intValue),
    ]),
  )
}

async function flush(): Promise<void> {
  const tracer = trace.getTracerProvider() as ProxyTracerProvider
  await (tracer.getDelegate() as NodeTracerProvider).forceFlush()
  await (logs.getLoggerProvider() as LoggerProvider).forceFlush()
}

function spanAt(path: string): OtlpSpan {
  const span = spans.find(
    (candidate) => attributes(candidate.attributes)["url.path"] === path,
  )
  if (!span) throw new Error(`no span for ${path}`)
  return span
}

function errorLogOf(span: OtlpSpan): OtlpLog {
  const record = records.find((candidate) => candidate.traceId === span.traceId)
  if (!record) throw new Error("no log in the trace of the span")
  return record
}

describe("serverTelemetryEndpoints", () => {
  it("does not start without an OTLP traces or logs endpoint", () => {
    expect(serverTelemetryEndpoints({})).toBeUndefined()
    expect(
      serverTelemetryEndpoints({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "  ",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${collector}/v1/metrics`,
      }),
    ).toBeUndefined()
  })

  it("starts with each endpoint that is set", () => {
    expect(
      serverTelemetryEndpoints({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: ` ${collector}/v1/traces `,
      }),
    ).toEqual({ traces: `${collector}/v1/traces`, logs: undefined })
    expect(
      serverTelemetryEndpoints({
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${collector}/v1/logs`,
      }),
    ).toEqual({ traces: undefined, logs: `${collector}/v1/logs` })
  })
})

describe("scrubServerErrorText", () => {
  it.each([
    ["Unauthorized", "Unauthorized"],
    ["Error in renderToReadableStream:", "Error in renderToReadableStream"],
    ["Request failed (404)", "Request failed (404)"],
    ["ECONNRESET: The socket connection was closed unexpectedly", "ECONNRESET"],
    [
      "Minified React error #418; visit https://react.dev/errors/418?args[]=s3cr3t for the full message",
      "Minified React error #418",
    ],
    ["Forbidden: you are not a member of acme", "Forbidden"],
  ])("keeps an approved head: %s", (text, head) => {
    expect(scrubServerErrorText(text)).toBe(head)
  })

  it.each([
    "prompt: confidential question",
    "Invalid prompt confidential question",
    "Failed to summarize confidential acquisition plan",
    "Could not stop thinking about the plan",
    "Hello",
    "sk_test_privatevalue",
    "EXCELLENT",
    "Unexpected token 'h', \"here is my secret plan\" is not valid JSON",
    "Parse error on line 2:\nthe secret plan diagram",
    "Cannot read properties of undefined (reading 'name')",
    "request to https://api.test/v1/x?token=abc failed for jane@example.test",
    "a".repeat(5_000),
  ])("replaces any other text: %s", (text) => {
    expect(scrubServerErrorText(text)).toBe("{redacted}")
  })
})

describe("startServerTelemetry", () => {
  // The OTLP exporter takes `request` from `import("http")`. That named
  // export keeps the original function until it is synced with the
  // `http.request` that msw patched.
  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" })
    syncBuiltinESMExports()
  })
  afterAll(() => {
    server.close()
    syncBuiltinESMExports()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("does not start and leaves console.error as it is without an endpoint", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
    vi.stubEnv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "")
    const before = console.error
    expect(startServerTelemetry()).toBe(false)
    expect(console.error).toBe(before)
  })

  it("exports each server error as an Error span with an exception event and as an ERROR log in its trace", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", `${collector}/v1/traces`)
    vi.stubEnv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", `${collector}/v1/logs`)
    vi.stubEnv("OTEL_SERVICE_NAME", "ui")
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "pr-7")
    vi.spyOn(console, "error").mockImplementation(() => {})
    expect(startServerTelemetry()).toBe(true)

    // A render error that React reports with console.error.
    const render = await traceServerRequest(
      new Request("http://ui.test/missing-page?invite=abc#frag", {
        headers: { cookie: "session=s3cr3t" },
      }),
      async () => {
        const error = new Error(
          "Unauthorized: the prompt text for jane@example.test\n    at cookie: session=s3cr3t",
        )
        error.name = "ApiError"
        console.error("Error in renderToReadableStream:", error, {
          componentStack: "\n    at OrgScopedLayout",
        })
        return new Response("<html>error</html>", { status: 500 })
      },
    )
    expect(await render.text()).toBe("<html>error</html>")

    // A stream that fails after the response started.
    const streamed = await traceServerRequest(
      new Request("http://ui.test/streamed"),
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new TypeError("stream broke: s3cr3t"))
            },
          }),
        ),
    )
    await expect(streamed.text()).rejects.toThrow("stream broke")

    // A handler that rejects.
    await expect(
      traceServerRequest(new Request("http://ui.test/rejected"), async () => {
        // An ApiError of the UI API client, with a fixed text.
        throw Object.assign(new Error("Failed to load s3cr3t"), {
          name: "ApiError",
          status: 404,
        })
      }),
    ).rejects.toThrow("Failed to load")

    await traceServerRequest(
      new Request("http://ui.test/.otel/v1/traces", { method: "POST" }),
      async () => new Response(null, { status: 204 }),
    )
    await flush()

    expect(spans).toHaveLength(3)
    const renderSpan = spanAt("/missing-page")
    expect(renderSpan.name).toBe("GET")
    expect(renderSpan.kind).toBe(2)
    expect(renderSpan.status.code).toBe(2)
    expect(attributes(renderSpan.attributes)).toEqual({
      "http.request.method": "GET",
      "url.path": "/missing-page",
      "http.response.status_code": 500,
    })
    expect(renderSpan.events.map((event) => event.name)).toEqual(["exception"])
    const exception = attributes(renderSpan.events[0]?.attributes ?? [])
    expect(exception["exception.type"]).toBe("ApiError")
    expect(exception["exception.message"]).toBe("Unauthorized")
    expect(String(exception["exception.stacktrace"])).toMatch(
      /^ApiError: Unauthorized\n\s+at /,
    )
    expect(attributes(resources[0] ?? [])).toMatchObject({
      "service.name": "ui",
      "service.namespace": "ctxpipe",
      "deployment.environment": "pr-7",
      "telemetry.sdk.language": "nodejs",
    })
    const renderLog = errorLogOf(renderSpan)
    expect(renderLog.severityNumber).toBe(17)
    expect(renderLog.severityText).toBe("ERROR")
    expect(renderLog.body.stringValue).toBe(
      "Error in renderToReadableStream: ApiError: Unauthorized",
    )
    expect(attributes(renderLog.attributes)).toMatchObject({
      "exception.type": "ApiError",
      "exception.message": "Unauthorized",
    })

    for (const [path, type, message] of [
      ["/streamed", "TypeError", "{redacted}"],
      ["/rejected", "ApiError", "Request failed (404)"],
    ] as const) {
      const span = spanAt(path)
      expect(span.status.code).toBe(2)
      expect(attributes(span.events[0]?.attributes ?? [])).toMatchObject({
        "exception.type": type,
        "exception.message": message,
      })
      expect(errorLogOf(span).body.stringValue).toBe(`${type}: ${message}`)
    }
    expect(records).toHaveLength(3)

    const exported = JSON.stringify({ spans, records })
    for (const secret of [
      "s3cr3t",
      "prompt text",
      "invite=abc",
      "frag",
      "jane@example",
    ]) {
      expect(exported).not.toContain(secret)
    }
  })
})
