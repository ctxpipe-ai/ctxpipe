import { ValueType } from "@opentelemetry/api"
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
} from "@opentelemetry/sdk-metrics"
import { describe, expect, it } from "vitest"
import { FlushOnDemandMetricReader } from "./flushOnDemandMetricReader.js"

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
        throw new Error("observable failed")
      })
    meter.createCounter("good.requests").add(3)

    await provider.forceFlush()

    const names = exporter
      .getMetrics()
      .flatMap((resourceMetrics) =>
        resourceMetrics.scopeMetrics.flatMap((scope) =>
          scope.metrics.map((metric) => metric.descriptor.name),
        ),
      )
    expect(names).toContain("good.requests")
    await provider.shutdown()
  })
})
