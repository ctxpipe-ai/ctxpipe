// Relative imports only: the Nitro plugin bundles this file without the `@/` alias.
import {
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import { logs, SeverityNumber } from "@opentelemetry/api-logs"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import {
  defaultResource,
  detectResources,
  envDetector,
  resourceFromAttributes,
} from "@opentelemetry/resources"
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs"
import {
  BatchSpanProcessor,
  NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node"

import { scrubTelemetryString } from "./otelBrowserScrub"
import { deploymentName } from "./otelEnv"

/**
 * OpenTelemetry for the UI server (SSR, server functions, server routes).
 *
 * The Nitro plugin `serverTelemetryNitroPlugin.ts` starts the SDK before
 * Bun.serve takes a request. Nitro bundles that plugin apart from the SSR
 * bundle, so this module has two copies at run time. They share only the
 * global OpenTelemetry API, never module state.
 *
 * The UI server does not log through evlog. Its errors come from React and
 * TanStack Start as `console.error` calls, for example "Error in
 * renderToReadableStream". Thus the SDK copies each `console.error` to the
 * active request span (status Error and an exception event) and to an OTLP
 * log record with severity ERROR. Stdout stays as it was.
 */

const SCOPE = "ctxpipe-ui-server"
const MAX_MESSAGE = 300

type ServerTelemetryEndpoints = { traces?: string; logs?: string }

/**
 * The OTLP endpoints of the UI server. Undefined when neither is set (local
 * dev, tests, a self-host without OTel): then the SDK does not start.
 */
export function serverTelemetryEndpoints(
  env: Record<string, string | undefined>,
): ServerTelemetryEndpoints | undefined {
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() || undefined
  const logs = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim() || undefined
  return traces || logs ? { traces, logs } : undefined
}

/**
 * Start the trace and log SDK from the `OTEL_*` environment. The exporters
 * also read `OTEL_EXPORTER_OTLP_HEADERS`. Returns false when no endpoint is
 * set and nothing started.
 */
export function startServerTelemetry(): boolean {
  const endpoints = serverTelemetryEndpoints(process.env)
  if (!endpoints) return false
  // `telemetry.sdk.language` (nodejs here, webjs from the browser) tells
  // these spans from the browser spans, which share the service name.
  const resource = defaultResource()
    .merge(detectResources({ detectors: [envDetector] }))
    .merge(
      resourceFromAttributes({
        "service.name": process.env.OTEL_SERVICE_NAME?.trim() || "ui",
        "service.namespace": "ctxpipe",
        "deployment.environment": deploymentName(),
      }),
    )
  if (endpoints.traces) {
    const exporter = new OTLPTraceExporter({
      url: endpoints.traces,
      timeoutMillis: 2_000,
    })
    new NodeTracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor(exporter, { exportTimeoutMillis: 2_000 }),
      ],
    }).register()
  }
  if (endpoints.logs) {
    const exporter = new OTLPLogExporter({
      url: endpoints.logs,
      timeoutMillis: 2_000,
    })
    logs.setGlobalLoggerProvider(
      new LoggerProvider({
        resource,
        processors: [
          new BatchLogRecordProcessor(exporter, { exportTimeoutMillis: 2_000 }),
        ],
      }),
    )
  }
  const consoleError = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    consoleError(...args)
    try {
      reportServerError(args)
    } catch {
      // Telemetry must never break the caller.
    }
  }
  return true
}

/**
 * One server span for each request, active while the handler runs and open
 * until the response body ends, so that an error of the streamed render
 * also lands on it. No span for the browser OTLP relay (`/.otel/*`) and
 * none when the SDK did not start.
 */
export async function traceServerRequest(
  request: Request,
  handle: () => Promise<Response>,
): Promise<Response> {
  const path = new URL(request.url).pathname
  if (path.startsWith("/.otel/")) return handle()
  const method = request.method.toUpperCase()
  const span = trace.getTracer(SCOPE).startSpan(method, {
    kind: SpanKind.SERVER,
    attributes: {
      "http.request.method": method,
      "url.path": scrubTelemetryString(path),
    },
  })
  if (!span.isRecording()) return handle()
  return context.with(trace.setSpan(context.active(), span), async () => {
    let response: Response
    try {
      response = await handle()
    } catch (error) {
      if (error instanceof Error) span.recordException(scrubbedError(error))
      span.setStatus({ code: SpanStatusCode.ERROR })
      span.end()
      throw error
    }
    span.setAttribute("http.response.status_code", response.status)
    if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR })
    return endSpanAfterBody(response, span)
  })
}

function endSpanAfterBody(response: Response, span: Span): Response {
  const body = response.body
  if (!body) {
    span.end()
    return response
  }
  const reader = body.getReader()
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (!done) {
          controller.enqueue(value)
          return
        }
        span.end()
        controller.close()
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR })
        span.end()
        controller.error(error)
      }
    },
    cancel(reason) {
      span.end()
      return reader.cancel(reason)
    },
  })
  return new Response(stream, response)
}

function reportServerError(args: unknown[]): void {
  const error = args.find((arg): arg is Error => arg instanceof Error)
  const exception = error ? scrubbedError(error) : undefined
  const text = args.filter((arg) => typeof arg === "string").join(" ")
  const body = scrubServerErrorText(
    exception ? `${text} ${exception.name}: ${exception.message}` : text,
  )
  const span = trace.getActiveSpan()
  if (span) {
    if (exception) span.recordException(exception)
    span.setStatus({ code: SpanStatusCode.ERROR })
  }
  logs.getLogger(SCOPE).emit({
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    body,
    attributes: exception
      ? {
          "exception.type": exception.name,
          "exception.message": exception.message,
          "exception.stacktrace": exception.stack,
        }
      : {},
  })
}

/**
 * Name, scrubbed message, and stack frames only. The copy drops the other
 * fields of the error (a response body, a request, a cause), and the stack
 * gets the scrubbed message in place of the original one.
 */
function scrubbedError(error: Error): Error {
  const message = scrubServerErrorText(error.message)
  const copy = new Error(message)
  copy.name = error.name || "Error"
  const frames = (error.stack ?? "")
    .split("\n")
    .filter((line) => /^\s+at\s/.test(line))
    .map(scrubTelemetryString)
  copy.stack = [`${copy.name}: ${message}`, ...frames].join("\n")
  return copy
}

/**
 * Remove credentials and personal data from error text before export: URL
 * queries and fragments, token path segments, emails (`otelBrowserScrub`),
 * header values of `cookie`, `authorization` and API keys, and bearer or
 * basic tokens. The length limit keeps long user input, such as a prompt
 * that an error message repeats, out of the telemetry.
 */
export function scrubServerErrorText(text: string): string {
  return scrubTelemetryString(text)
    .replace(
      /\b(set-cookie|cookie|authorization|x-api-key)(["']?\s*[:=]\s*["']?)[^\r\n"']*/gi,
      "$1$2{redacted}",
    )
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]+/gi, "$1 {redacted}")
    .trim()
    .slice(0, MAX_MESSAGE)
}
