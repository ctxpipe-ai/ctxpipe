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

import { deploymentName } from "./otelEnv"
import { scrubTelemetryString } from "./otelScrub"

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
  const providers: { shutdown(): Promise<void> }[] = []
  if (endpoints.traces) {
    const exporter = new OTLPTraceExporter({
      url: endpoints.traces,
      timeoutMillis: 2_000,
    })
    const tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor(exporter, { exportTimeoutMillis: 2_000 }),
      ],
    })
    tracerProvider.register()
    providers.push(tracerProvider)
  }
  if (endpoints.logs) {
    const exporter = new OTLPLogExporter({
      url: endpoints.logs,
      timeoutMillis: 2_000,
    })
    const loggerProvider = new LoggerProvider({
      resource,
      processors: [
        new BatchLogRecordProcessor(exporter, { exportTimeoutMillis: 2_000 }),
      ],
    })
    logs.setGlobalLoggerProvider(loggerProvider)
    providers.push(loggerProvider)
  }
  // The Bun preset of Nitro has no shutdown hook. On SIGTERM (an ECS task
  // stop), send the queued spans and logs, then stop as the default action
  // of the signal does.
  process.once("SIGTERM", () => {
    void Promise.allSettled(
      providers.map((provider) => provider.shutdown()),
    ).finally(() => process.kill(process.pid, "SIGTERM"))
  })
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
      reportError(span, error)
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
        reportError(span, error)
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

/** A `console.error` call: the error goes to the active request span. */
function reportServerError(args: unknown[]): void {
  const error = args.find((arg) => arg instanceof Error)
  const label = args.filter((arg) => typeof arg === "string").join(" ")
  reportError(trace.getActiveSpan(), error, label)
}

/**
 * Set the span to Error with an exception event, and write an ERROR log in
 * the trace of the span.
 */
function reportError(span: Span | undefined, error: unknown, label = ""): void {
  const exception = error instanceof Error ? scrubbedError(error) : undefined
  if (span) {
    if (exception) span.recordException(exception)
    span.setStatus({ code: SpanStatusCode.ERROR })
  }
  const body = [
    scrubServerErrorText(label),
    exception && `${exception.name}: ${exception.message}`,
  ]
    .filter(Boolean)
    .join(": ")
  logs.getLogger(SCOPE).emit({
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    body: body || "Server error",
    context: span ? trace.setSpan(context.active(), span) : undefined,
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
 * fields of the error (a response body, a request, a cause). The stack
 * starts with the original message, which can have more than one line, so
 * the frames are the lines after it. A stack that does not contain the
 * message gives no frames.
 */
function scrubbedError(error: Error): Error {
  const name = /^[\w.$-]{1,64}$/.test(error.name) ? error.name : "Error"
  // An API error that has no approved text still gives its HTTP status.
  const status = (error as { status?: unknown }).status
  const text = scrubServerErrorText(error.message)
  const message =
    text === "{redacted}" && typeof status === "number" && status > 0
      ? `Request failed (${status})`
      : text
  const copy = new Error(message)
  copy.name = name
  const stack = error.stack ?? ""
  const start = error.message
    ? stack.indexOf(error.message)
    : stack.indexOf("\n")
  const frames =
    start < 0
      ? []
      : stack
          .slice(start + error.message.length)
          .split("\n")
          .filter((line) => /^\s+at\s/.test(line))
          .map(scrubCredentials)
  copy.stack = [`${name}: ${message}`, ...frames].join("\n")
  return copy
}

/**
 * The exported form of an error text: its head when that is an approved
 * diagnostic text, else "{redacted}". The head is the first line up to the
 * first ": ". Any other text, such as a value, a request body, or a prompt
 * that an error repeats, does not leave the server. The exception type and
 * the stack frames give the rest of the diagnosis.
 */
export function scrubServerErrorText(text: string): string {
  const head = (text.split(/\r?\n|:(?:\s|$)/, 1)[0] ?? "").trim()
  if (!head) return ""
  const approved = new Set([
    // The SSR labels of TanStack Start.
    "Error in renderToReadableStream",
    "Error in renderToPipeableStream",
    // HTTP reasons that the backend and Better Auth send as `error`.
    "Bad Request",
    "Unauthorized",
    "Forbidden",
    "Not Found",
    "Conflict",
    "Too Many Requests",
    "Internal Server Error",
    "Bad gateway",
    "Bad Gateway",
    "Service Unavailable",
    "Gateway Timeout",
    // Network and abort errors of fetch in Bun and Node.
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EPIPE",
    "fetch failed",
    "signal timed out",
    "Network request failed",
    "The operation was aborted.",
    "The operation timed out.",
  ])
  if (approved.has(head)) return head
  const shaped = /^(Request failed \(\d{3}\)|Minified React error #\d+)/.exec(
    head,
  )
  return shaped?.[0] ?? "{redacted}"
}

/**
 * URL queries and fragments, token path segments and emails
 * (`otelScrub`), the values of `cookie` and `authorization` headers,
 * of keys that end in token, secret, password or API key, and bearer or
 * basic credentials.
 */
function scrubCredentials(text: string): string {
  return scrubTelemetryString(text)
    .replace(
      /\b(set-cookie|cookie|proxy-authorization|authorization)(["']?\s*[:=]\s*["']?)[^\r\n"']*/gi,
      "$1$2{redacted}",
    )
    .replace(
      /\b([\w.-]*(?:token|secret|password|passwd|api[_-]?key))(["']?\s*[:=]\s*["']?)[^\s"'&;,}]+/gi,
      "$1$2{redacted}",
    )
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]+/gi, "$1 {redacted}")
}
