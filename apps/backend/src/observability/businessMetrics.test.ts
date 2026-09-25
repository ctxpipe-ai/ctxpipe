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
  connectorSyncTypeForEnqueuedWorkflow,
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

async function syncCounts(): Promise<
  { value: number; attributes: Record<string, string> }[]
> {
  await reader.forceFlush()
  const points: { value: number; attributes: Record<string, string> }[] = []
  for (const resource of exporter.getMetrics()) {
    for (const scope of resource.scopeMetrics) {
      for (const metric of scope.metrics) {
        if (metric.descriptor.name !== "ctxpipe.connector.syncs") continue
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
  it("does not count the startup PR-mirror ensure sweep", () => {
    expect(
      connectorSyncTypeForEnqueuedWorkflow("github-ensure-pr-mirror"),
    ).toBeUndefined()
  })

  it("still counts a github content sync and skips ingestion workflows", () => {
    expect(connectorSyncTypeForEnqueuedWorkflow("github-sync-content")).toBe(
      "github",
    )
    expect(
      connectorSyncTypeForEnqueuedWorkflow("repository-ingestion"),
    ).toBeUndefined()
  })

  it("counts a connector sync once when the root workflow finishes", async () => {
    recordEnqueuedWorkflow("linear-sync-config", { orgId: "org_1" })
    recordEnqueuedWorkflow("linear-sync-content", { orgId: "org_1" })
    recordTerminalConnectorSync(
      "linear-sync-content",
      { orgId: "org_1" },
      "success",
    )
    recordTerminalConnectorSync(
      "linear-sync-config",
      { orgId: "org_1" },
      "failure",
    )
    const points = await syncCounts()
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
  })
})
