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
  it("reports whether heap-space statistics can be collected", () => {
    expect(typeof heapSpaceStatisticsAvailable()).toBe("boolean")
  })

  it("records used and limit from v8.getHeapStatistics", async () => {
    const exporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    )
    const provider = new MeterProvider({
      readers: [new FlushOnDemandMetricReader(exporter)],
    })
    metrics.setGlobalMeterProvider(provider)
    installProcessHeapGauges()
    await provider.forceFlush()
    const names = metricNames(exporter)
    expect(names).toContain("v8js.memory.heap.used")
    expect(names).toContain("v8js.memory.heap.limit")
    await provider.shutdown()
  })
})
