import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
} from "@opentelemetry/sdk-metrics"
import { describe, expect, it } from "vitest"
import { FlushOnDemandMetricReader } from "./flushOnDemandMetricReader.js"
import { attachCodesearchRuntimeMetrics } from "./otel.js"

describe("attachCodesearchRuntimeMetrics", () => {
  it("registers runtime instruments on the given meter provider", async () => {
    const exporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    )
    const provider = new MeterProvider({
      readers: [new FlushOnDemandMetricReader(exporter)],
    })
    expect(attachCodesearchRuntimeMetrics(provider)).toContain("runtime-node")
    await provider.forceFlush()
    const names = exporter
      .getMetrics()
      .flatMap((resourceMetrics) =>
        resourceMetrics.scopeMetrics.flatMap((scope) =>
          scope.metrics.map((metric) => metric.descriptor.name),
        ),
      )
    expect(
      names.some(
        (name) =>
          name.startsWith("nodejs.eventloop.") ||
          name.startsWith("v8js.memory.heap."),
      ),
    ).toBe(true)
    await provider.shutdown()
  })
})
