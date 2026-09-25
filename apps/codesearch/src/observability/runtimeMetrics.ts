import * as v8 from "node:v8"
import type { Meter } from "@opentelemetry/api"
import { log } from "evlog"

const reportedSetupErrors = new Set<string>()

/**
 * Bun 1.3.11 throws from `v8.getHeapSpaceStatistics`, and Bun 1.2 rejects
 * assigning over that export. Do not patch `node:v8`. Per-space gauges and
 * `v8js.gc.duration` stay on Node (openworkflow) via runtime-node. Bun records
 * process used/limit from `v8.getHeapStatistics` instead. Bun does not emit
 * `gc` PerformanceObserver entries, so GC duration is not synthesized here.
 */
export function reportTelemetrySetupError(error: unknown): void {
  const name = error instanceof Error ? error.name : "Error"
  const message = error instanceof Error ? error.message : String(error)
  const key = `${name}:${message}`
  if (reportedSetupErrors.has(key)) return
  reportedSetupErrors.add(key)
  log.warn({
    step: "otel.setup",
    message,
    error: name,
  })
}

let readHeapSpaceStatistics: () => void = () => {
  v8.getHeapSpaceStatistics()
}

export function heapSpaceStatisticsAvailable(): boolean {
  try {
    readHeapSpaceStatistics()
    return true
  } catch {
    return false
  }
}

/** Test hook. Production calls `v8.getHeapSpaceStatistics` and never assigns it. */
export function useHeapSpaceStatisticsReaderForTests(
  read: (() => void) | undefined,
): void {
  readHeapSpaceStatistics =
    read ??
    (() => {
      v8.getHeapSpaceStatistics()
    })
}

/** Drop the heap-space collector. Does not mutate `node:v8`. */
export function omitUnimplementedHeapSpaceCollector(
  instrumentation: object,
): void {
  if (heapSpaceStatisticsAvailable()) return
  const host = instrumentation as {
    _collectors?: Array<{ constructor: { name: string } }>
  }
  if (!host._collectors) return
  host._collectors = host._collectors.filter(
    (collector) =>
      collector.constructor.name !== "HeapSpacesSizeAndUsedCollector",
  )
}

/** Process-level heap used and limit. Callbacks never throw. */
export function installProcessHeapGauges(meter: Meter): void {
  const used = meter.createObservableGauge("v8js.memory.heap.used", {
    description:
      "Used heap size from v8.getHeapStatistics. Process total, not per space.",
    unit: "By",
  })
  const limit = meter.createObservableGauge("v8js.memory.heap.limit", {
    description: "Heap size limit from v8.getHeapStatistics.",
    unit: "By",
  })
  const observe = (
    result: { observe(value: number): void },
    pick: (stats: ReturnType<typeof v8.getHeapStatistics>) => number,
  ) => {
    try {
      const value = pick(v8.getHeapStatistics())
      if (typeof value === "number" && Number.isFinite(value)) {
        result.observe(value)
      }
    } catch {
      /* collection must not fail the flush */
    }
  }
  used.addCallback((result) => {
    observe(result, (stats) => stats.used_heap_size)
  })
  limit.addCallback((result) => {
    observe(result, (stats) => stats.heap_size_limit)
  })
}
