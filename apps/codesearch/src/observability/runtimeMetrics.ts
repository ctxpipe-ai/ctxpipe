import * as v8 from "node:v8"
import { metrics } from "@opentelemetry/api"

/**
 * Bun 1.3.11 throws from `v8.getHeapSpaceStatistics` and does not emit `gc`
 * PerformanceObserver entries, so runtime-node's per-space heap gauges and
 * `v8js.gc.duration` stay empty there. `v8.getHeapStatistics` works. Node
 * (openworkflow) still records space and GC metrics through runtime-node.
 */
export function heapSpaceStatisticsAvailable(): boolean {
  try {
    v8.getHeapSpaceStatistics()
    return true
  } catch {
    return false
  }
}

/** Replace the missing Bun API so runtime-node's heap-space callback does not throw. */
export function guardUnimplementedHeapSpaceStatistics(): void {
  if (heapSpaceStatisticsAvailable()) return
  const heap = v8 as {
    getHeapSpaceStatistics: typeof v8.getHeapSpaceStatistics
  }
  heap.getHeapSpaceStatistics = () => []
}

/** Process-level heap used and limit. Call only when heap-space stats are unavailable. */
export function installProcessHeapGauges(): void {
  const meter = metrics.getMeter("ctxpipe-runtime")
  const used = meter.createObservableGauge("v8js.memory.heap.used", {
    description:
      "Used heap size from v8.getHeapStatistics. Process total, not per space.",
    unit: "By",
  })
  const limit = meter.createObservableGauge("v8js.memory.heap.limit", {
    description: "Heap size limit from v8.getHeapStatistics.",
    unit: "By",
  })
  used.addCallback((result) => {
    result.observe(v8.getHeapStatistics().used_heap_size)
  })
  limit.addCallback((result) => {
    result.observe(v8.getHeapStatistics().heap_size_limit)
  })
}
