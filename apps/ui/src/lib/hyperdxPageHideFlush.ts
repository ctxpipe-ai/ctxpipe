import { SpanStatusCode } from "@opentelemetry/api"

/**
 * The part of the SDK batch span processor (`@opentelemetry/sdk-trace`
 * `BatchSpanProcessorBase`, bundled in `@hyperdx/browser`) that this flush uses.
 * The fields are not public API. `hyperdxPageHideFlush.test.ts` runs this flush on
 * the real processor class, so a change in that class makes the test fail.
 */
type BatchProcessor = {
  forceFlush(): Promise<void>
  _finishedSpans: QueuedSpan[]
  _maxExportBatchSize: number
}

type QueuedSpan = {
  name: string
  status?: { code: number }
  instrumentationScope?: { name: string }
}

/**
 * Find the batch span processor of the tracer provider that `HyperDX.init`
 * registered. Returns null when the shape is not the expected one.
 */
export function findBatchSpanProcessor(
  provider: unknown,
): BatchProcessor | null {
  const delegate =
    typeof (provider as { getDelegate?: unknown })?.getDelegate === "function"
      ? (provider as { getDelegate(): unknown }).getDelegate()
      : provider
  const processors = (
    delegate as { _activeSpanProcessor?: { _spanProcessors?: unknown } }
  )?._activeSpanProcessor?._spanProcessors
  if (!Array.isArray(processors)) return null
  for (const candidate of processors) {
    const processor = candidate as Partial<BatchProcessor>
    if (
      typeof processor.forceFlush === "function" &&
      Array.isArray(processor._finishedSpans) &&
      typeof processor._maxExportBatchSize === "number"
    ) {
      return processor as BatchProcessor
    }
  }
  return null
}

/**
 * Send the queued spans while the page goes away.
 *
 * The SDK flush has two gaps that lose all spans of a short visit:
 * - It listens for `pagehide` on `document`, but the browser fires `pagehide`
 *   on `window` only.
 * - It sends batches of 50 spans. The first load of a page makes many resource
 *   spans, so one batch is often more than the 64 KB `keepalive` limit. The
 *   exporter then sends it without `keepalive`, and the browser cancels that
 *   request when the page unloads.
 *
 * This flush runs on `window` `pagehide`, and on `visibilitychange` to hidden
 * in the capture phase, before the SDK listener on `document` empties the
 * queue. It puts the document load, page view, and error spans first and sends
 * small batches, so that each request stays well below the limit. The browser
 * limit is for all open `keepalive` requests together, so the spans that are
 * not important come last and are the ones the browser can drop.
 */
export function flushSpansOnPageHide(
  processor: BatchProcessor,
  target: Pick<Window, "addEventListener">,
  document: Pick<Document, "visibilityState">,
): void {
  const flush = () => {
    const queued = processor._finishedSpans
    if (queued.length === 0) return
    processor._finishedSpans = [
      ...queued.filter(isImportant),
      ...queued.filter((span) => !isImportant(span)),
    ]
    const batchSize = processor._maxExportBatchSize
    // `forceFlush` splits the queue and calls the exporter synchronously, so
    // the smaller batch size applies to this flush only.
    processor._maxExportBatchSize = 10
    try {
      processor.forceFlush().catch(() => {})
    } finally {
      processor._maxExportBatchSize = batchSize
    }
  }
  target.addEventListener("pagehide", flush)
  target.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") flush()
    },
    { capture: true },
  )
}

function isImportant(span: QueuedSpan): boolean {
  if (span.status?.code === SpanStatusCode.ERROR) return true
  if (span.name === "documentLoad" || span.name === "documentFetch") return true
  const scope = span.instrumentationScope?.name
  // `custom-action` holds `page_view`; `record-exception` holds screen errors.
  return scope === "custom-action" || scope === "record-exception"
}
