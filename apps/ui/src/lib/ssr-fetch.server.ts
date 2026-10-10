import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { deploymentEnvironment } from "./otelBrowserProxy"

const propagator = new W3CTraceContextPropagator()
const headerAccess = {
  get: (carrier: Headers, key: string) => carrier.get(key) ?? undefined,
  set: (carrier: Headers, key: string, value: string) =>
    carrier.set(key, value),
  keys: (carrier: Headers) => [...carrier.keys()],
}

let exportStarted = false

/** Export UI server spans to the same OTLP endpoint as the browser relay. */
function startSpanExport(): void {
  if (exportStarted) return
  exportStarted = true
  const url = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  if (!url) return
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({
      resource: resourceFromAttributes({
        "service.name": "ui",
        "service.namespace": "ctxpipe",
        "deployment.environment": deploymentEnvironment(),
      }),
      spanProcessors: [
        new BatchSpanProcessor(
          // The exporter reads OTEL_EXPORTER_OTLP_HEADERS itself.
          new OTLPTraceExporter({ url, timeoutMillis: 2_000 }),
          { scheduledDelayMillis: 1_000 },
        ),
      ],
    }),
  )
}

/**
 * Server-render fetch to the backend.
 *
 * Each call opens a new connection. Bun keeps idle sockets in a pool, and a
 * proxy (the Railway edge) can drop an idle socket without a FIN. A request
 * on that socket then waits for the whole SSR timeout.
 *
 * Each call is a client span. Its parent is the `traceparent` that the
 * backend sent with the document request.
 */
export async function ssrFetch(
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  startSpanExport()
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url
  const url = URL.canParse(raw) ? new URL(raw) : null
  const method = (
    init.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase()
  const headers = new Headers(init.headers)
  const parent = propagator.extract(context.active(), headers, headerAccess)
  const span = trace.getTracer("ctxpipe-ui").startSpan(
    `HTTP ${method}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.request.method": method,
        "url.path": url?.pathname ?? raw.split("?")[0],
        "server.address": url?.hostname,
      },
    },
    parent,
  )
  propagator.inject(trace.setSpan(parent, span), headers, headerAccess)
  try {
    const response = await fetch(input, {
      ...init,
      headers,
      keepalive: false,
    })
    span.setAttribute("http.response.status_code", response.status)
    if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR })
    return response
  } catch (error) {
    if (error instanceof Error) span.recordException(error)
    span.setStatus({ code: SpanStatusCode.ERROR })
    throw error
  } finally {
    span.end()
  }
}
