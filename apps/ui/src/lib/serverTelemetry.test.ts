import { syncBuiltinESMExports } from "node:module"

import { trace } from "@opentelemetry/api"
import { logs } from "@opentelemetry/api-logs"
import type { LoggerProvider } from "@opentelemetry/sdk-logs"
import type { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

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
  const tracer = trace.getTracerProvider() as unknown as {
    getDelegate(): NodeTracerProvider
  }
  await tracer.getDelegate().forceFlush()
  await (logs.getLoggerProvider() as LoggerProvider).forceFlush()
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
  it("removes credentials, URL queries, token paths, and emails", () => {
    const text = scrubServerErrorText(
      [
        "fetch https://api.test/v1/x?token=abc#frag failed for jane@example.test",
        "cookie: better-auth.session_token=s3cr3t; theme=dark",
        '{"authorization":"Bearer abc.def"}',
        "x-api-key=k3y",
        "sent Bearer eyJhbGciOi.payload.sig",
        "/reset-password/rst-token",
      ].join("\n"),
    )
    for (const secret of [
      "token=abc",
      "frag",
      "jane@example.test",
      "s3cr3t",
      "dark",
      "abc.def",
      "k3y",
      "eyJhbGciOi",
      "rst-token",
    ]) {
      expect(text).not.toContain(secret)
    }
    expect(text).toContain("https://api.test/v1/x")
    expect(text).toContain("/reset-password/{token}")
  })

  it("cuts long text, such as a prompt that an error repeats", () => {
    expect(scrubServerErrorText("a".repeat(5_000))).toHaveLength(300)
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

  it("does not start and leaves console.error as it is without an endpoint", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
    vi.stubEnv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "")
    const before = console.error
    expect(startServerTelemetry()).toBe(false)
    expect(console.error).toBe(before)
    vi.unstubAllEnvs()
  })

  it("exports a render error as an Error span with an exception event and as an ERROR log", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", `${collector}/v1/traces`)
    vi.stubEnv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", `${collector}/v1/logs`)
    vi.stubEnv("OTEL_SERVICE_NAME", "ui")
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "pr-7")
    vi.spyOn(console, "error").mockImplementation(() => {})
    expect(startServerTelemetry()).toBe(true)

    const request = new Request("http://ui.test/missing-page?invite=abc#frag", {
      headers: { cookie: "session=s3cr3t" },
    })
    const response = await traceServerRequest(request, async () => {
      const error = new Error(
        "Unauthorized: cookie: session=s3cr3t for jane@example.test",
      )
      error.name = "ApiError"
      console.error("Error in renderToReadableStream:", error, {
        componentStack: "\n    at OrgScopedLayout",
      })
      return new Response("<html>error</html>", { status: 500 })
    })
    expect(await response.text()).toBe("<html>error</html>")
    await traceServerRequest(
      new Request("http://ui.test/.otel/v1/traces", { method: "POST" }),
      async () => new Response(null, { status: 204 }),
    )
    await flush()

    expect(spans).toHaveLength(1)
    const [span] = spans
    expect(span?.name).toBe("GET")
    expect(span?.kind).toBe(2)
    expect(span?.status.code).toBe(2)
    expect(attributes(span?.attributes ?? [])).toEqual({
      "http.request.method": "GET",
      "url.path": "/missing-page",
      "http.response.status_code": 500,
    })
    expect(span?.events.map((event) => event.name)).toEqual(["exception"])
    const exception = attributes(span?.events[0]?.attributes ?? [])
    expect(exception["exception.type"]).toBe("ApiError")
    expect(exception["exception.message"]).toBe(
      "Unauthorized: cookie: {redacted}",
    )
    expect(String(exception["exception.stacktrace"])).toMatch(
      /^ApiError: Unauthorized: cookie: \{redacted\}\n\s+at /,
    )
    expect(attributes(resources[0] ?? [])).toMatchObject({
      "service.name": "ui",
      "service.namespace": "ctxpipe",
      "deployment.environment": "pr-7",
      "telemetry.sdk.language": "nodejs",
    })

    expect(records).toHaveLength(1)
    const [record] = records
    expect(record?.severityNumber).toBe(17)
    expect(record?.severityText).toBe("ERROR")
    expect(record?.traceId).toBe(span?.traceId)
    expect(record?.body.stringValue).toBe(
      "Error in renderToReadableStream: ApiError: Unauthorized: cookie: {redacted}",
    )
    expect(attributes(record?.attributes ?? [])).toMatchObject({
      "exception.type": "ApiError",
      "exception.message": "Unauthorized: cookie: {redacted}",
    })

    const exported = JSON.stringify({ spans, records })
    for (const secret of ["s3cr3t", "invite=abc", "frag", "jane@example"]) {
      expect(exported).not.toContain(secret)
    }
  })
})
