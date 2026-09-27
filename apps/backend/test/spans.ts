import type { Attributes } from "@opentelemetry/api"
import { SpanKind, trace } from "@opentelemetry/api"
import { resourceFromAttributes } from "@opentelemetry/resources"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeEach } from "vitest"

export type RecordedSpans = {
  reset: () => void
  finishedSpans: () => ReadableSpan[]
  spanNamed: (name: string) => ReadableSpan | undefined
  serverSpan: () => ReadableSpan | undefined
  /** Public attributes of a finished span. Defaults to the latest server span. */
  attributes: (span?: ReadableSpan) => Attributes
}

let installed = false
let exporter: InMemorySpanExporter | null = null

function lastSpan(
  spans: readonly ReadableSpan[],
  match: (span: ReadableSpan) => boolean,
): ReadableSpan | undefined {
  for (let index = spans.length - 1; index >= 0; index--) {
    const span = spans[index]
    if (span && match(span)) return span
  }
  return undefined
}

/**
 * Register one in-memory tracer provider for this test file.
 * Call at file scope. `beforeEach` clears finished spans.
 */
export function recordSpans(): RecordedSpans {
  if (!installed || !exporter) {
    // A reused vitest worker keeps the previous file's global provider.
    // Drop it so this file's exporter is the one that receives spans.
    trace.disable()
    const created = new InMemorySpanExporter()
    exporter = created
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({ "service.name": "ctxpipe-test" }),
      spanProcessors: [new SimpleSpanProcessor(created)],
    })
    provider.register()
    beforeEach(() => {
      created.reset()
    })
    afterAll(async () => {
      await provider.forceFlush()
      // Release the global provider so the next file in a reused vitest
      // worker can register its own.
      trace.disable()
      installed = false
      exporter = null
    })
    installed = true
  }

  const current = exporter
  if (!current) {
    throw new Error("span exporter was not installed")
  }
  return {
    reset: () => current.reset(),
    finishedSpans: () => current.getFinishedSpans().slice(),
    spanNamed: (name) =>
      lastSpan(current.getFinishedSpans(), (span) => span.name === name),
    serverSpan: () =>
      lastSpan(
        current.getFinishedSpans(),
        (span) => span.kind === SpanKind.SERVER,
      ),
    attributes: (span) => {
      const target =
        span ??
        lastSpan(
          current.getFinishedSpans(),
          (item) => item.kind === SpanKind.SERVER,
        )
      return target ? target.attributes : {}
    },
  }
}
