import { describe, expect, test } from "bun:test"
import { mapLogsToOtlp, mapMetricsToOtlp, queryWindow, type RailwayLogRow, type RailwayMetricRow } from "./otlp"
import { includeEnvironment, OBSERVABILITY_PROJECT_ID, PRODUCT_PROJECT_ID } from "./targets"

const START = Date.parse("2026-09-25T12:00:00.000Z") / 1000
const WINDOW = { startUnix: START, endUnix: START + 360, sampleRateSeconds: 60 }

const metricsResponse = JSON.parse(`{
  "data": {
    "metrics": [
      {
        "measurement": "CPU_USAGE",
        "tags": { "serviceId": "svc", "region": "us-east4-eqdc4a" },
        "values": [
          { "ts": ${START - 60}, "value": 1 },
          { "ts": ${START}, "value": 0.2 },
          { "ts": ${START}, "value": 0.5 },
          { "ts": "${START + 60}", "value": 9 },
          { "ts": ${START + 60}, "value": 0.4 },
          { "ts": 1.5, "value": 1 },
          { "ts": ${START + 120}, "value": null },
          { "ts": ${WINDOW.endUnix}, "value": 3 }
        ]
      },
      {
        "measurement": "MEMORY_USAGE_GB",
        "tags": { "serviceId": "svc", "region": "us-east4-eqdc4a" },
        "values": [{ "ts": ${START}, "value": 0.25 }]
      },
      {
        "measurement": "NETWORK_RX_GB",
        "tags": { "serviceId": "svc", "region": "us-east4-eqdc4a" },
        "values": [
          { "ts": ${START}, "value": 1 },
          { "ts": ${START + 60}, "value": 3 }
        ]
      },
      {
        "measurement": "CPU_USAGE",
        "tags": { "serviceId": "svc", "region": "europe-west4-drams3a" },
        "values": [{ "ts": ${START}, "value": 2 }]
      },
      {
        "measurement": "DISK_USAGE_GB",
        "tags": { "serviceId": "svc", "region": "asia-southeast1-eqsg3a" },
        "values": [{ "ts": ${START}, "value": 4 }]
      },
      {
        "measurement": "DISK_USAGE_GB",
        "tags": { "serviceId": "ch", "region": "us-east4-eqdc16a" },
        "values": [{ "ts": ${START}, "value": 2 }]
      },
      {
        "measurement": "BACKUP_USAGE_GB",
        "tags": { "serviceId": "svc", "region": "us-east4-eqdc4a" },
        "values": [{ "ts": ${START}, "value": 8 }]
      },
      {
        "measurement": "MEMORY_USAGE_GB",
        "tags": { "serviceId": null, "region": "us-east4" },
        "values": [{ "ts": ${START}, "value": 0.1 }]
      },
      {
        "measurement": "DISK_USAGE_GB",
        "tags": { "serviceId": "00000000-0000-0000-0000-000000000000", "region": "us-east4" },
        "values": [{ "ts": ${START}, "value": 0.01 }]
      }
    ]
  }
}`) as { data: { metrics: RailwayMetricRow[] } }

const logsResponse = JSON.parse(`{
  "data": {
    "environmentLogs": [
      {
        "timestamp": "2026-09-25T12:00:01.123456789Z",
        "message": "{\\"level\\":\\"warn\\",\\"message\\":\\"slow\\"}",
        "severity": "info",
        "attributes": [
          { "key": "request.id", "value": "req-1" },
          { "key": "request.id", "value": "dup" },
          { "key": "", "value": "skip" }
        ],
        "tags": { "serviceId": "col", "deploymentId": "dep-1" }
      },
      {
        "timestamp": "2026-09-25T12:00:02.000Z",
        "message": "ready",
        "severity": "Error",
        "attributes": [],
        "tags": { "serviceId": "self", "deploymentId": "dep-self" }
      },
      {
        "timestamp": "2026-09-25T12:00:03.000Z",
        "message": "no severity",
        "severity": null,
        "attributes": null,
        "tags": { "serviceId": "col", "deploymentId": null }
      },
      {
        "timestamp": "2026-09-25T12:06:00.000Z",
        "message": "at exclusive end",
        "severity": "warn",
        "attributes": [],
        "tags": { "serviceId": "col", "deploymentId": null }
      },
      {
        "timestamp": "not-a-timestamp",
        "message": "dropped",
        "severity": "error",
        "attributes": [],
        "tags": { "serviceId": "col", "deploymentId": null }
      },
      {
        "timestamp": "2026-09-25T12:00:04.000Z",
        "message": null,
        "severity": "error",
        "attributes": [],
        "tags": { "serviceId": "col", "deploymentId": null }
      }
    ]
  }
}`) as { data: { environmentLogs: RailwayLogRow[] } }

function attr(attributes: { key: string; value: { stringValue: string } }[], key: string) {
  return attributes.find((attribute) => attribute.key === key)?.value.stringValue
}

describe("queryWindow", () => {
  test("covers the last 6 closed minutes", () => {
    const inside = queryWindow(Date.parse("2026-09-25T12:07:30.000Z"))
    expect(new Date(inside.endUnix * 1000).toISOString()).toBe("2026-09-25T12:07:00.000Z")
    expect(new Date(inside.startUnix * 1000).toISOString()).toBe("2026-09-25T12:01:00.000Z")
    expect(inside.endUnix - inside.startUnix).toBe(360)
    expect(inside.sampleRateSeconds).toBe(60)

    const onMinute = queryWindow(Date.parse("2026-09-25T12:05:00.000Z"))
    expect(new Date(onMinute.endUnix * 1000).toISOString()).toBe("2026-09-25T12:05:00.000Z")
    expect(new Date(onMinute.startUnix * 1000).toISOString()).toBe("2026-09-25T11:59:00.000Z")
  })
})

describe("mapMetricsToOtlp", () => {
  const payload = mapMetricsToOtlp({
    projectId: PRODUCT_PROJECT_ID,
    projectName: "ctxpipe",
    environmentId: "env-prod",
    railwayEnvironmentName: "production",
    serviceNames: { svc: "backend", ch: "clickhouse" },
    metrics: metricsResponse.data.metrics,
    window: WINDOW,
  })

  test("converts a recorded metrics payload and dedupes inside the window", () => {
    const backend = payload.resourceMetrics.find(
      (resource) => attr(resource.resource.attributes, "railway.region") === "us-east4-eqdc4a",
    )
    const metrics = Object.fromEntries(
      (backend?.scopeMetrics[0]?.metrics ?? []).map((metric) => [metric.name, metric]),
    )
    expect(metrics["railway.cpu.usage"]).toEqual({
      name: "railway.cpu.usage",
      unit: "{cpu}",
      gauge: {
        dataPoints: [
          { asDouble: 0.5, timeUnixNano: `${START}000000000` },
          { asDouble: 0.4, timeUnixNano: `${START + 60}000000000` },
        ],
      },
    })
    expect(metrics["railway.memory.usage"]?.gauge.dataPoints[0]?.asDouble).toBe(0.25 * 1024 ** 3)
    expect(metrics["railway.memory.usage"]?.unit).toBe("By")
    expect(metrics["railway.network.rx"]?.gauge.dataPoints.map((point) => point.asDouble)).toEqual([
      1024 ** 3,
      3 * 1024 ** 3,
    ])
    expect(metrics["railway.disk.usage"]).toBeUndefined()
    expect(payload.resourceMetrics.some((resource) => attr(resource.resource.attributes, "service.name") === "00000000-0000-0000-0000-000000000000")).toBe(false)
  })

  test("keeps one resource per live region and a disk series with no cpu or memory", () => {
    const byRegion = Object.fromEntries(
      payload.resourceMetrics.map((resource) => [
        `${attr(resource.resource.attributes, "service.name")}:${attr(resource.resource.attributes, "railway.region")}`,
        resource.scopeMetrics[0]?.metrics.map((metric) => metric.name),
      ]),
    )
    expect(byRegion["backend:europe-west4-drams3a"]).toEqual(["railway.cpu.usage"])
    expect(byRegion["backend:asia-southeast1-eqsg3a"]).toBeUndefined()
    expect(byRegion["clickhouse:us-east4-eqdc16a"]).toEqual(["railway.disk.usage"])
    const clickhouse = payload.resourceMetrics.find(
      (resource) => attr(resource.resource.attributes, "service.name") === "clickhouse",
    )
    expect(clickhouse?.scopeMetrics[0]?.metrics[0]?.gauge.dataPoints[0]?.asDouble).toBe(2 * 1024 ** 3)
  })

  test("maps observability production onto deployment.environment and keeps product preview names", () => {
    expect(includeEnvironment(OBSERVABILITY_PROJECT_ID, "production")).toBe(true)
    expect(includeEnvironment(OBSERVABILITY_PROJECT_ID, "pr-1")).toBe(false)
    expect(includeEnvironment(PRODUCT_PROJECT_ID, "pr-343")).toBe(true)
    expect(includeEnvironment(PRODUCT_PROJECT_ID, "staging")).toBe(false)

    const obs = mapMetricsToOtlp({
      projectId: OBSERVABILITY_PROJECT_ID,
      projectName: "ctxpipe-observability",
      environmentId: "env-obs",
      railwayEnvironmentName: "production",
      serviceNames: { ch: "clickhouse" },
      metrics: [
        {
          measurement: "DISK_USAGE_GB",
          tags: { serviceId: "ch", region: "us-east4-eqdc16a" },
          values: [{ ts: START, value: 1 }],
        },
      ],
      window: WINDOW,
    })
    const attributes = obs.resourceMetrics[0]?.resource.attributes ?? []
    expect(attr(attributes, "service.name")).toBe("clickhouse")
    expect(attr(attributes, "service.namespace")).toBe("ctxpipe")
    expect(attr(attributes, "deployment.environment")).toBe("observability")
    expect(attr(attributes, "railway.project")).toBe("ctxpipe-observability")
    expect(attr(attributes, "railway.project.id")).toBe(OBSERVABILITY_PROJECT_ID)
    expect(attr(attributes, "railway.service.id")).toBe("ch")
    expect(attr(attributes, "railway.environment.id")).toBe("env-obs")
    expect(attr(attributes, "railway.region")).toBe("us-east4-eqdc16a")

    const preview = mapMetricsToOtlp({
      projectId: PRODUCT_PROJECT_ID,
      projectName: "ctxpipe",
      environmentId: "env-pr",
      railwayEnvironmentName: "pr-343",
      serviceNames: { ui: "ui" },
      metrics: [
        { measurement: "CPU_LIMIT", tags: { serviceId: "ui", region: null }, values: [{ ts: START, value: 8 }] },
      ],
      window: WINDOW,
    })
    const previewAttributes = preview.resourceMetrics[0]?.resource.attributes ?? []
    expect(attr(previewAttributes, "deployment.environment")).toBe("pr-343")
    expect(previewAttributes.some((attribute) => attribute.key === "railway.region")).toBe(false)
    expect(preview.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]).toMatchObject({
      name: "railway.cpu.limit",
      unit: "{cpu}",
      gauge: { dataPoints: [{ asDouble: 8 }] },
    })
  })
})

describe("mapLogsToOtlp", () => {
  const payload = mapLogsToOtlp({
    projectId: OBSERVABILITY_PROJECT_ID,
    projectName: "ctxpipe-observability",
    environmentId: "env-obs",
    railwayEnvironmentName: "production",
    serviceNames: { col: "collector", self: "railway-telemetry" },
    logs: logsResponse.data.environmentLogs,
    window: WINDOW,
  })

  test("leaves info unset, maps other Railway severities, and keeps this service", () => {
    const collector = payload.resourceLogs.find(
      (resource) => attr(resource.resource.attributes, "service.name") === "collector",
    )
    const records = collector?.scopeLogs[0]?.logRecords ?? []
    expect(records.map((record) => record.body.stringValue)).toEqual([
      `{"level":"warn","message":"slow"}`,
      "no severity",
    ])
    const info = records[0]
    expect(info?.severityNumber).toBeUndefined()
    expect(info?.severityText).toBeUndefined()
    expect(JSON.parse(JSON.stringify(info)).severityNumber).toBeUndefined()
    expect(info?.timeUnixNano).toBe(`${BigInt(Date.parse("2026-09-25T12:00:01.123456789Z")) * 1_000_000n}`)
    expect(info?.attributes).toEqual([
      { key: "request.id", value: { stringValue: "req-1" } },
      { key: "railway.deployment.id", value: { stringValue: "dep-1" } },
    ])
    expect(attr(collector?.resource.attributes ?? [], "deployment.environment")).toBe("observability")

    const self = payload.resourceLogs.find(
      (resource) => attr(resource.resource.attributes, "service.name") === "railway-telemetry",
    )
    expect(self?.scopeLogs[0]?.logRecords[0]).toMatchObject({
      body: { stringValue: "ready" },
      severityNumber: 17,
      severityText: "ERROR",
    })
  })
})
