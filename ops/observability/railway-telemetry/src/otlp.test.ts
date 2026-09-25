import { describe, expect, test } from "bun:test"
import {
  countMetricPoints,
  dedupeSamples,
  gbToBytes,
  mapLogsToOtlp,
  mapMetricsToOtlp,
  mapSeverity,
  metricWindow,
  parseOtlpHeaders,
  rfc3339ToUnixNano,
  selfHealthLog,
  type MetricSeries,
  type RailwayLogLine,
} from "./otlp"
import {
  deploymentEnvironment,
  includeEnvironment,
  OBSERVABILITY_PROJECT_ID,
  PRODUCT_PROJECT_ID,
} from "./targets"

const WINDOW = { startUnix: 1_800_000_000, endUnix: 1_800_000_300 }

function attr(attributes: { key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean } }[], key: string) {
  return attributes.find((attribute) => attribute.key === key)?.value
}

const GAUGE_UNITS: Record<string, string> = {
  "railway.cpu.usage": "{cpu}",
  "railway.cpu.limit": "{cpu}",
  "railway.memory.usage": "By",
  "railway.memory.limit": "By",
  "railway.network.rx": "By",
  "railway.network.tx": "By",
  "railway.disk.usage": "By",
}

describe("units", () => {
  test("converts GB to bytes with the CLI's 1024-based gigabyte", () => {
    expect(gbToBytes(1)).toBe(1024 ** 3)
    expect(gbToBytes(0.25)).toBe(1024 ** 3 / 4)
    expect(gbToBytes(0)).toBe(0)
  })

  test("leaves CPU cores unchanged and converts memory", () => {
    const payload = mapMetricsToOtlp({
      projectId: PRODUCT_PROJECT_ID,
      projectName: "ctxpipe",
      environmentId: "env-prod",
      railwayEnvironmentName: "production",
      serviceNames: { svc: "backend" },
      window: WINDOW,
      series: [
        { measurement: "CPU_USAGE", serviceId: "svc", region: null, values: [{ ts: WINDOW.startUnix, value: 0.5 }] },
        {
          measurement: "MEMORY_USAGE_GB",
          serviceId: "svc",
          region: null,
          values: [{ ts: WINDOW.startUnix, value: 0.25 }],
        },
      ],
    })
    const metrics = payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? []
    expect(metrics.find((metric) => metric.name === "railway.cpu.usage")).toEqual({
      name: "railway.cpu.usage",
      unit: "{cpu}",
      gauge: { dataPoints: [{ asDouble: 0.5, timeUnixNano: `${WINDOW.startUnix}000000000` }] },
    })
    expect(metrics.find((metric) => metric.name === "railway.memory.usage")?.gauge.dataPoints[0]?.asDouble).toBe(
      gbToBytes(0.25),
    )
    expect(metrics.find((metric) => metric.name === "railway.memory.usage")?.unit).toBe("By")
  })

  test("maps every Railway measurement onto the contract gauge", () => {
    const series: MetricSeries[] = [
      ["CPU_USAGE", 0.2],
      ["CPU_LIMIT", 8],
      ["MEMORY_USAGE_GB", 0.5],
      ["MEMORY_LIMIT_GB", 8],
      ["NETWORK_RX_GB", 0.01],
      ["NETWORK_TX_GB", 0.02],
      ["DISK_USAGE_GB", 1],
      ["BACKUP_USAGE_GB", 4],
    ].map(([measurement, value]) => ({
      measurement: measurement as string,
      serviceId: "svc",
      region: null,
      values: [{ ts: WINDOW.startUnix, value: value as number }],
    }))
    const payload = mapMetricsToOtlp({
      projectId: PRODUCT_PROJECT_ID,
      projectName: "ctxpipe",
      environmentId: "env-prod",
      railwayEnvironmentName: "production",
      serviceNames: { svc: "backend" },
      window: WINDOW,
      series,
    })
    const metrics = payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? []
    expect(metrics.map((metric) => metric.name).sort()).toEqual(Object.keys(GAUGE_UNITS).sort())
    for (const metric of metrics) expect(metric.unit).toBe(GAUGE_UNITS[metric.name])
    expect(countMetricPoints(payload)).toBe(7)
  })
})

describe("window", () => {
  test("floors the end to the 5-minute boundary and samples every 60s", () => {
    const inside = metricWindow(Date.parse("2026-09-25T12:07:30.000Z"))
    expect(new Date(inside.startUnix * 1000).toISOString()).toBe("2026-09-25T12:00:00.000Z")
    expect(new Date(inside.endUnix * 1000).toISOString()).toBe("2026-09-25T12:05:00.000Z")
    expect(inside.sampleRateSeconds).toBe(60)
    expect(inside.endUnix - inside.startUnix).toBe(300)

    const onBoundary = metricWindow(Date.parse("2026-09-25T12:05:00.000Z"))
    expect(new Date(onBoundary.endUnix * 1000).toISOString()).toBe("2026-09-25T12:05:00.000Z")
    expect(new Date(onBoundary.startUnix * 1000).toISOString()).toBe("2026-09-25T12:00:00.000Z")

    const justAfter = metricWindow(Date.parse("2026-09-25T12:05:00.001Z"))
    expect(new Date(justAfter.endUnix * 1000).toISOString()).toBe("2026-09-25T12:05:00.000Z")
    expect(new Date(justAfter.startUnix * 1000).toISOString()).toBe("2026-09-25T12:00:00.000Z")

    const next = metricWindow(Date.parse("2026-09-25T12:10:00.000Z"))
    expect(new Date(next.startUnix * 1000).toISOString()).toBe("2026-09-25T12:05:00.000Z")
    expect(new Date(next.endUnix * 1000).toISOString()).toBe("2026-09-25T12:10:00.000Z")
  })
})

describe("sample timestamps", () => {
  test("keeps the last value at a timestamp and drops the exclusive end", () => {
    const samples = dedupeSamples(
      [
        { ts: WINDOW.startUnix - 60, value: 9 },
        { ts: WINDOW.startUnix, value: 1 },
        { ts: WINDOW.startUnix, value: 4 },
        { ts: WINDOW.startUnix + 60, value: 2 },
        { ts: WINDOW.endUnix, value: 8 },
      ],
      WINDOW,
    )
    expect(samples).toEqual([
      { ts: WINDOW.startUnix, value: 4 },
      { ts: WINDOW.startUnix + 60, value: 2 },
    ])
  })

  test("network samples stay per-bucket gauges instead of cumulative deltas", () => {
    const series: MetricSeries = {
      measurement: "NETWORK_RX_GB",
      serviceId: "svc",
      region: "us-east4-eqdc4a",
      values: [
        { ts: WINDOW.startUnix, value: 1 },
        { ts: WINDOW.startUnix, value: 1 },
        { ts: WINDOW.startUnix + 60, value: 3 },
        { ts: WINDOW.startUnix + 120, value: 6 },
      ],
    }
    const payload = mapMetricsToOtlp({
      projectId: PRODUCT_PROJECT_ID,
      projectName: "ctxpipe",
      environmentId: "env-prod",
      railwayEnvironmentName: "production",
      serviceNames: { svc: "backend" },
      window: WINDOW,
      series: [series],
    })
    const points = payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.gauge.dataPoints ?? []
    expect(points.map((point) => point.asDouble)).toEqual([gbToBytes(1), gbToBytes(3), gbToBytes(6)])
    expect(countMetricPoints(payload)).toBe(3)
  })
})

describe("resource attributes", () => {
  test("maps the observability production env onto deployment.environment=observability", () => {
    expect(deploymentEnvironment(OBSERVABILITY_PROJECT_ID, "production")).toBe("observability")
    expect(includeEnvironment(OBSERVABILITY_PROJECT_ID, "production")).toBe(true)
    expect(includeEnvironment(OBSERVABILITY_PROJECT_ID, "pr-1")).toBe(false)

    const payload = mapMetricsToOtlp({
      projectId: OBSERVABILITY_PROJECT_ID,
      projectName: "ctxpipe-observability",
      environmentId: "env-obs",
      railwayEnvironmentName: "production",
      serviceNames: { ch: "clickhouse" },
      window: WINDOW,
      series: [
        {
          measurement: "DISK_USAGE_GB",
          serviceId: "ch",
          region: "us-east4-eqdc4a",
          values: [{ ts: WINDOW.startUnix, value: 2 }],
        },
      ],
    })
    const attributes = payload.resourceMetrics[0]?.resource.attributes ?? []
    expect(attr(attributes, "service.name")).toEqual({ stringValue: "clickhouse" })
    expect(attr(attributes, "service.namespace")).toEqual({ stringValue: "ctxpipe" })
    expect(attr(attributes, "deployment.environment")).toEqual({ stringValue: "observability" })
    expect(attr(attributes, "railway.project")).toEqual({ stringValue: "ctxpipe-observability" })
    expect(attr(attributes, "railway.project.id")).toEqual({ stringValue: OBSERVABILITY_PROJECT_ID })
    expect(attr(attributes, "railway.service.id")).toEqual({ stringValue: "ch" })
    expect(attr(attributes, "railway.environment.id")).toEqual({ stringValue: "env-obs" })
    expect(attr(attributes, "railway.region")).toEqual({ stringValue: "us-east4-eqdc4a" })
    expect(payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.name).toBe("railway.disk.usage")
  })

  test("keeps product pr env names and omits region when Railway did not group by it", () => {
    expect(deploymentEnvironment(PRODUCT_PROJECT_ID, "pr-343")).toBe("pr-343")
    expect(includeEnvironment(PRODUCT_PROJECT_ID, "pr-343")).toBe(true)
    expect(includeEnvironment(PRODUCT_PROJECT_ID, "production")).toBe(true)
    expect(includeEnvironment(PRODUCT_PROJECT_ID, "staging")).toBe(false)

    const payload = mapMetricsToOtlp({
      projectId: PRODUCT_PROJECT_ID,
      projectName: "ctxpipe",
      environmentId: "env-pr",
      railwayEnvironmentName: "pr-343",
      serviceNames: { ui: "ui" },
      window: WINDOW,
      series: [
        {
          measurement: "CPU_LIMIT",
          serviceId: "ui",
          region: null,
          values: [{ ts: WINDOW.startUnix, value: 8 }],
        },
      ],
    })
    const attributes = payload.resourceMetrics[0]?.resource.attributes ?? []
    expect(attr(attributes, "deployment.environment")).toEqual({ stringValue: "pr-343" })
    expect(attr(attributes, "service.name")).toEqual({ stringValue: "ui" })
    expect(attributes.some((attribute) => attribute.key === "railway.region")).toBe(false)
    expect(payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]).toMatchObject({
      name: "railway.cpu.limit",
      unit: "{cpu}",
      gauge: { dataPoints: [{ asDouble: 8 }] },
    })
  })

  test("keeps a separate resource per region instead of summing them", () => {
    const payload = mapMetricsToOtlp({
      projectId: PRODUCT_PROJECT_ID,
      projectName: "ctxpipe",
      environmentId: "env-prod",
      railwayEnvironmentName: "production",
      serviceNames: { svc: "backend" },
      window: WINDOW,
      series: [
        {
          measurement: "CPU_USAGE",
          serviceId: "svc",
          region: "us-east4-eqdc4a",
          values: [{ ts: WINDOW.startUnix, value: 1 }],
        },
        {
          measurement: "CPU_USAGE",
          serviceId: "svc",
          region: "europe-west4-drams3a",
          values: [{ ts: WINDOW.startUnix, value: 2 }],
        },
      ],
    })
    expect(payload.resourceMetrics).toHaveLength(2)
    const byRegion = Object.fromEntries(
      payload.resourceMetrics.map((resource) => [
        attr(resource.resource.attributes, "railway.region")?.stringValue,
        resource.scopeMetrics[0]?.metrics[0]?.gauge?.dataPoints[0]?.asDouble,
      ]),
    )
    expect(byRegion).toEqual({
      "us-east4-eqdc4a": 1,
      "europe-west4-drams3a": 2,
    })
  })
})

describe("logs", () => {
  const logs: RailwayLogLine[] = [
    {
      timestamp: "2027-01-15T08:00:01.123456789Z",
      message: "ready",
      severity: "Error",
      attributes: [
        { key: "request.id", value: "req-1" },
        { key: "request.id", value: "dup" },
      ],
      serviceId: "col",
      deploymentId: "dep-1",
    },
    {
      timestamp: "2027-01-15T08:00:02Z",
      message: "cron stdout",
      severity: "info",
      attributes: [],
      serviceId: "self",
      deploymentId: "dep-self",
    },
    {
      timestamp: "2027-01-15T08:05:00Z",
      message: "at exclusive end",
      severity: "warn",
      attributes: [],
      serviceId: "col",
      deploymentId: null,
    },
  ]

  const logWindow = metricWindow(Date.parse("2027-01-15T08:07:00.000Z"))

  test("maps severity, body, attributes, and skips this job", () => {
    expect(mapSeverity("debug")).toEqual({ severityNumber: 5, severityText: "DEBUG" })
    expect(mapSeverity("WARN")).toEqual({ severityNumber: 13, severityText: "WARN" })
    expect(mapSeverity("warning")).toEqual({ severityNumber: 13, severityText: "WARN" })
    expect(mapSeverity("err")).toEqual({ severityNumber: 17, severityText: "ERROR" })
    expect(mapSeverity("fatal")).toEqual({ severityNumber: 21, severityText: "FATAL" })
    expect(mapSeverity(null)).toEqual({ severityNumber: 9, severityText: "INFO" })
    expect(mapSeverity("notice")).toEqual({ severityNumber: 9, severityText: "INFO" })
    expect(rfc3339ToUnixNano("2027-01-15T08:00:01.123456789Z")).toBe(
      `${BigInt(Date.parse("2027-01-15T08:00:01Z")) * 1_000_000n + 123456789n}`,
    )

    const payload = mapLogsToOtlp({
      projectId: OBSERVABILITY_PROJECT_ID,
      projectName: "ctxpipe-observability",
      environmentId: "env-obs",
      railwayEnvironmentName: "production",
      serviceNames: { col: "collector", self: "railway-telemetry" },
      logs,
      window: logWindow,
      skipServiceName: "railway-telemetry",
    })
    expect(payload.resourceLogs).toHaveLength(1)
    const record = payload.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]
    expect(record?.body).toEqual({ stringValue: "ready" })
    expect(record?.severityNumber).toBe(17)
    expect(record?.severityText).toBe("ERROR")
    expect(record?.attributes).toEqual([
      { key: "request.id", value: { stringValue: "req-1" } },
      { key: "railway.deployment.id", value: { stringValue: "dep-1" } },
    ])
    expect(attr(payload.resourceLogs[0]?.resource.attributes ?? [], "service.name")).toEqual({
      stringValue: "collector",
    })
    expect(attr(payload.resourceLogs[0]?.resource.attributes ?? [], "deployment.environment")).toEqual({
      stringValue: "observability",
    })
  })

  test("self log uses railway-telemetry in the observability environment", () => {
    const payload = selfHealthLog({
      timeUnixNano: "1000",
      metricPoints: 4,
      logRecords: 2,
      environments: 3,
      logsCapped: true,
      redisWarning: null,
      windowStartIso: "2026-09-25T12:00:00.000Z",
      windowEndIso: "2026-09-25T12:05:00.000Z",
    })
    const attributes = payload.resourceLogs[0]?.resource.attributes ?? []
    expect(attr(attributes, "service.name")).toEqual({ stringValue: "railway-telemetry" })
    expect(attr(attributes, "service.namespace")).toEqual({ stringValue: "ctxpipe" })
    expect(attr(attributes, "deployment.environment")).toEqual({ stringValue: "observability" })
    const record = payload.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]
    expect(record?.severityText).toBe("INFO")
    expect(record?.attributes).toContainEqual({ key: "railway.telemetry.metric_points", value: { intValue: "4" } })
    expect(record?.attributes).toContainEqual({ key: "railway.telemetry.logs_capped", value: { boolValue: true } })
    expect(record?.attributes).toContainEqual({ key: "railway.telemetry.redis_ok", value: { boolValue: true } })
    expect(record?.body.stringValue).toContain("metric_points=4")
    expect(record?.body.stringValue).toContain("logs_capped=true")
    expect(record?.body.stringValue).toContain("redis=ok")
  })

  test("self log warns when Redis collection fails and still records the Railway counts", () => {
    const payload = selfHealthLog({
      timeUnixNano: "1000",
      metricPoints: 4,
      logRecords: 0,
      environments: 1,
      logsCapped: false,
      redisWarning: "redis INFO failed: connection refused",
      windowStartIso: "2026-09-25T12:00:00.000Z",
      windowEndIso: "2026-09-25T12:05:00.000Z",
    })
    const record = payload.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]
    expect(record?.severityNumber).toBe(13)
    expect(record?.severityText).toBe("WARN")
    expect(record?.attributes).toContainEqual({ key: "railway.telemetry.redis_ok", value: { boolValue: false } })
    expect(record?.attributes).toContainEqual({
      key: "railway.telemetry.redis_error",
      value: { stringValue: "redis INFO failed: connection refused" },
    })
    expect(record?.body.stringValue).toContain("metric_points=4")
    expect(record?.body.stringValue).toContain("redis_error=redis INFO failed: connection refused")
  })
})

describe("otlp headers", () => {
  test("parses the standard comma-separated header list", () => {
    expect(parseOtlpHeaders("authorization=secret, x-extra=a%2Fb")).toEqual({
      authorization: "secret",
      "x-extra": "a/b",
    })
    expect(parseOtlpHeaders(undefined)).toEqual({})
  })
})
