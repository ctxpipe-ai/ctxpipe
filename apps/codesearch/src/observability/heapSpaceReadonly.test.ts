import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import * as v8 from "node:v8"
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
} from "@opentelemetry/sdk-metrics"
import { afterEach, describe, expect, it } from "vitest"
import type { Env } from "../config/env.js"
import { FlushOnDemandMetricReader } from "./flushOnDemandMetricReader.js"
import {
  attachCodesearchRuntimeMetrics,
  initOtel,
  shutdownOtel,
} from "./otel.js"
import { useHeapSpaceStatisticsReaderForTests } from "./runtimeMetrics.js"

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "test",
    PORT: 3001,
    AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    ...overrides,
  }
}

function throwUnavailable(): void {
  throw new Error(
    "node:v8 getHeapSpaceStatistics is not yet implemented in Bun",
  )
}

describe("heap-space statistics are not patched", () => {
  afterEach(() => {
    useHeapSpaceStatisticsReaderForTests(undefined)
  })

  it("initOtel does not throw or replace getHeapSpaceStatistics", async () => {
    const before = v8.getHeapSpaceStatistics
    useHeapSpaceStatisticsReaderForTests(throwUnavailable)
    const sink = createServer((req, res) => {
      req.resume()
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
      })
    })
    await new Promise<void>((resolve) => {
      sink.listen(0, "127.0.0.1", resolve)
    })
    const port = (sink.address() as AddressInfo).port
    expect(() =>
      initOtel(
        testEnv({
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${port}/v1/metrics`,
        }),
      ),
    ).not.toThrow()
    expect(v8.getHeapSpaceStatistics).toBe(before)
    await shutdownOtel()
    await new Promise<void>((resolve, reject) => {
      sink.close((err) => (err ? reject(err) : resolve()))
    })
  })

  it("records process heap gauges when space statistics throw", async () => {
    useHeapSpaceStatisticsReaderForTests(throwUnavailable)
    const exporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    )
    const provider = new MeterProvider({
      readers: [new FlushOnDemandMetricReader(exporter)],
    })
    expect(() => attachCodesearchRuntimeMetrics(provider)).not.toThrow()
    await provider.forceFlush()
    const names = exporter
      .getMetrics()
      .flatMap((resourceMetrics) =>
        resourceMetrics.scopeMetrics.flatMap((scope) =>
          scope.metrics.map((metric) => metric.descriptor.name),
        ),
      )
    expect(names).toContain("v8js.memory.heap.used")
    expect(names).toContain("v8js.memory.heap.limit")
    await provider.shutdown()
  })
})
