import * as v8 from "node:v8"
import { metrics } from "@opentelemetry/api"
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
} from "@opentelemetry/sdk-metrics"
import { describe, expect, it } from "vitest"
import { FlushOnDemandMetricReader } from "./flushOnDemandMetricReader.js"
import {
  heapSpaceStatisticsAvailable,
  installProcessHeapGauges,
} from "./runtimeMetrics.js"

function metricNames(exporter: InMemoryMetricExporter): string[] {
  return exporter
    .getMetrics()
    .flatMap((resourceMetrics) =>
      resourceMetrics.scopeMetrics.flatMap((scope) =>
        scope.metrics.map((metric) => metric.descriptor.name),
      ),
    )
}

describe("process heap gauges", () => {
  it("does not assign over v8.getHeapSpaceStatistics", () => {
    const before = v8.getHeapSpaceStatistics
    heapSpaceStatisticsAvailable()
    expect(v8.getHeapSpaceStatistics).toBe(before)
  })

  it("records used and limit from v8.getHeapStatistics", async () => {
    const exporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    )
    const provider = new MeterProvider({
      readers: [new FlushOnDemandMetricReader(exporter)],
    })
    metrics.setGlobalMeterProvider(provider)
    installProcessHeapGauges(provider.getMeter("ctxpipe-runtime"))
    await provider.forceFlush()
    const names = metricNames(exporter)
    expect(names).toContain("v8js.memory.heap.used")
    expect(names).toContain("v8js.memory.heap.limit")
    await provider.shutdown()
  })
})
