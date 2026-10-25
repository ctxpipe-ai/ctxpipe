import { SpanStatusCode, trace } from "@opentelemetry/api"
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base"
import { afterEach, describe, expect, it } from "vitest"

import {
  findBatchSpanProcessor,
  flushSpansOnPageHide,
} from "./hyperdxPageHideFlush"

// The SDK batch span processor and tracer provider are the real classes that
// `@hyperdx/browser` bundles. Only the exporter is a fake: it records each
// export call, as the OTLP fetch exporter makes one request for each call.
function setUp() {
  const exports: string[][] = []
  const exporter: SpanExporter = {
    export(spans: ReadableSpan[], done) {
      exports.push(spans.map((span) => span.name))
      // 0 is `ExportResultCode.SUCCESS`.
      done({ code: 0 })
    },
    shutdown: async () => {},
  }
  const provider = new BasicTracerProvider({
    spanProcessors: [
      // The same batch settings as `@hyperdx/otel-web`.
      new BatchSpanProcessor(exporter, {
        scheduledDelayMillis: 4000,
        maxExportBatchSize: 50,
      }),
    ],
  })
  const tracer = provider.getTracer("test")
  const end = (name: string, scope = tracer) => scope.startSpan(name).end()
  // A first page load: many resource spans end before the document load.
  for (let index = 0; index < 40; index += 1) end("resourceFetch")
  end("documentLoad")
  end("documentFetch")
  end("page_view", provider.getTracer("custom-action"))
  for (let index = 0; index < 5; index += 1) end("console.log")
  const error = provider.getTracer("record-exception").startSpan("Error")
  error.setStatus({ code: SpanStatusCode.ERROR })
  error.end()

  const window = new EventTarget()
  const document = { visibilityState: "visible" as DocumentVisibilityState }
  return { provider, exports, window, document }
}

describe("flushSpansOnPageHide", () => {
  afterEach(() => {
    trace.disable()
  })

  it("finds the batch processor of the global tracer provider", () => {
    const { provider } = setUp()
    trace.setGlobalTracerProvider(provider)
    expect(findBatchSpanProcessor(trace.getTracerProvider())).not.toBeNull()
  })

  it("exports the queued spans on window pagehide, important spans first, in small batches", () => {
    const { provider, exports, window, document } = setUp()
    const processor = findBatchSpanProcessor(provider)
    if (!processor) throw new Error("no batch span processor")
    flushSpansOnPageHide(processor, window, document)

    window.dispatchEvent(new Event("pagehide"))

    // The export starts in the event handler, before the page unloads.
    expect(exports.flat()).toHaveLength(49)
    expect(exports[0]).toEqual([
      "documentLoad",
      "documentFetch",
      "page_view",
      "Error",
      "resourceFetch",
      "resourceFetch",
      "resourceFetch",
      "resourceFetch",
      "resourceFetch",
      "resourceFetch",
    ])
    for (const batch of exports) expect(batch.length).toBeLessThanOrEqual(10)
    // The normal batch size comes back after the flush.
    expect(processor._maxExportBatchSize).toBe(50)
  })

  it("exports on visibilitychange only when the page is hidden", () => {
    const { provider, exports, window, document } = setUp()
    const processor = findBatchSpanProcessor(provider)
    if (!processor) throw new Error("no batch span processor")
    flushSpansOnPageHide(processor, window, document)

    window.dispatchEvent(new Event("visibilitychange"))
    expect(exports).toHaveLength(0)

    document.visibilityState = "hidden"
    window.dispatchEvent(new Event("visibilitychange"))
    expect(exports.flat()).toHaveLength(49)
  })
})
