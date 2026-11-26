import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
} from "@opentelemetry/sdk-metrics"
import { HttpResponse, http } from "msw"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useMswServer } from "../../test/msw.js"
import { FlushOnDemandMetricReader } from "./flushOnDemandMetricReader.js"
import { backendResource, observeProcessMemory } from "./otel.js"

const metadata = "http://169.254.170.2/v4/0a1b2c3d-container"
const server = useMswServer()

afterEach(() => {
  vi.unstubAllEnvs()
})

async function resourceAttributes() {
  const resource = backendResource()
  await resource.waitForAsyncAttributes?.()
  return resource.attributes
}

describe("service.instance.id", () => {
  it("is the ECS task id from the task metadata endpoint", async () => {
    server.use(
      http.get(`${metadata}/task`, () =>
        HttpResponse.json({
          TaskARN:
            "arn:aws:ecs:us-west-2:000000000000:task/hosted/5f0e7c2a9b1d4e3f8a6b2c1d0e9f8a7b",
        }),
      ),
    )
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", metadata)

    expect((await resourceAttributes())["service.instance.id"]).toBe(
      "5f0e7c2a9b1d4e3f8a6b2c1d0e9f8a7b",
    )
  })

  it("is not set when the metadata endpoint fails", async () => {
    server.use(
      http.get(`${metadata}-down/task`, () =>
        HttpResponse.json({}, { status: 500 }),
      ),
    )
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", `${metadata}-down`)

    expect(await resourceAttributes()).not.toHaveProperty("service.instance.id")
  })

  it("is not set outside ECS", async () => {
    vi.stubEnv("ECS_CONTAINER_METADATA_URI_V4", "")

    expect(await resourceAttributes()).not.toHaveProperty("service.instance.id")
  })
})

it("reports the resident memory of the process as process.memory.usage", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const provider = new MeterProvider({
    readers: [new FlushOnDemandMetricReader(exporter)],
  })
  observeProcessMemory(provider.getMeter("test"))

  await provider.forceFlush()
  const metric = exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .find((m) => m.descriptor.name === "process.memory.usage")
  await provider.shutdown()

  expect(metric?.descriptor.unit).toBe("By")
  expect(metric?.dataPoints[0]?.value).toBeGreaterThan(10 * 1024 * 1024)
})
