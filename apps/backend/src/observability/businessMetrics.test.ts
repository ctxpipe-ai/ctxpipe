import { metrics } from "@opentelemetry/api"
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  recordEnqueuedWorkflow,
  recordTerminalConnectorSync,
} from "./businessMetrics.js"

const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
const reader = new PeriodicExportingMetricReader({
  exporter,
  exportIntervalMillis: 60_000,
})
const provider = new MeterProvider({ readers: [reader] })

beforeAll(() => {
  metrics.setGlobalMeterProvider(provider)
})

afterAll(async () => {
  await provider.shutdown()
})

async function pointsNamed(
  name: string,
): Promise<{ value: number; attributes: Record<string, string> }[]> {
  const points: { value: number; attributes: Record<string, string> }[] = []
  for (const resource of exporter.getMetrics()) {
    for (const scope of resource.scopeMetrics) {
      for (const metric of scope.metrics) {
        if (metric.descriptor.name !== name) continue
        if (metric.dataPointType !== DataPointType.SUM) continue
        for (const point of metric.dataPoints) {
          points.push({
            value: point.value,
            attributes: Object.fromEntries(
              Object.entries(point.attributes).map(([key, value]) => [
                key,
                String(value),
              ]),
            ),
          })
        }
      }
    }
  }
  return points
}

describe("connector sync metrics", () => {
  it("counts a connector sync from the definition's connector type", async () => {
    recordEnqueuedWorkflow("linear-sync-config", { orgId: "org_1" })
    recordEnqueuedWorkflow("repository-ingestion", { orgId: "org_1" })
    recordTerminalConnectorSync(undefined, { orgId: "org_1" }, "success")
    recordTerminalConnectorSync("linear", { orgId: "org_1" }, "success")
    recordTerminalConnectorSync("linear", { orgId: "org_1" }, "failure")
    await reader.forceFlush()
    const points = await pointsNamed("ctxpipe.connector.syncs")
    expect(points).toEqual(
      expect.arrayContaining([
        {
          value: 1,
          attributes: {
            "ctxpipe.org.id": "org_1",
            "ctxpipe.connector.type": "linear",
            outcome: "success",
          },
        },
        {
          value: 1,
          attributes: {
            "ctxpipe.org.id": "org_1",
            "ctxpipe.connector.type": "linear",
            outcome: "failure",
          },
        },
      ]),
    )
    expect(points).toHaveLength(2)
    const ingestion = await pointsNamed("ctxpipe.ingestion.jobs")
    expect(ingestion).toEqual([
      { value: 1, attributes: { "ctxpipe.org.id": "org_1" } },
    ])
  })
})
