import { ValueType } from "@opentelemetry/api"
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
} from "@opentelemetry/sdk-metrics"
import { log } from "evlog"
import { describe, expect, it, vi } from "vitest"
import { FlushOnDemandMetricReader } from "./flushOnDemandMetricReader.js"

function metricNames(exporter: InMemoryMetricExporter): string[] {
  return exporter
    .getMetrics()
    .flatMap((resourceMetrics) =>
      resourceMetrics.scopeMetrics.flatMap((scope) =>
        scope.metrics.map((metric) => metric.descriptor.name),
      ),
    )
}

describe("FlushOnDemandMetricReader", () => {
  it("exports metrics collected when another observable callback throws", async () => {
    const exporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    )
    const provider = new MeterProvider({
      readers: [new FlushOnDemandMetricReader(exporter)],
    })
    const meter = provider.getMeter("flush-test")
    meter
      .createObservableGauge("broken.heap", { valueType: ValueType.INT })
      .addCallback(() => {
        throw new Error("codesearch-heap-space")
      })
    meter.createCounter("good.requests").add(3)

    await provider.forceFlush()

    expect(metricNames(exporter)).toContain("good.requests")
    await provider.shutdown()
  })

  it("logs each observable callback failure once", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {})
    const exporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    )
    const provider = new MeterProvider({
      readers: [new FlushOnDemandMetricReader(exporter)],
    })
    const meter = provider.getMeter("flush-log")
    meter
      .createObservableGauge("broken.once", { valueType: ValueType.INT })
      .addCallback(() => {
        throw new Error("codesearch-callback-once")
      })
    meter.createCounter("still.exported").add(1)

    await provider.forceFlush()
    await provider.forceFlush()

    const warnings = warn.mock.calls.filter((call) =>
      JSON.stringify(call[0]).includes("codesearch-callback-once"),
    )
    expect(warnings).toHaveLength(1)
    warn.mockRestore()
    await provider.shutdown()
  })
})
