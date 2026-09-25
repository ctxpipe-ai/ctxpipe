import { describe, expect, test } from "bun:test"
import { parseEnvironmentLogsPayload, parseMetricsPayload } from "./railway"

const metricsBody = JSON.parse(`{
  "data": {
    "metrics": [
      {
        "measurement": "CPU_USAGE",
        "tags": { "serviceId": "11111111-1111-1111-1111-111111111111", "region": "us-east4-eqdc16a" },
        "values": [
          { "ts": 1800000000, "value": 0.25 },
          { "ts": "1800000060", "value": 0.5 },
          { "ts": 1800000120, "value": null },
          { "ts": "not-a-timestamp", "value": 1 }
        ]
      },
      {
        "measurement": "DISK_USAGE_GB",
        "tags": { "serviceId": "22222222-2222-2222-2222-222222222222", "region": "asia-southeast1-eqsg3a" },
        "values": [
          { "ts": 1800000000, "value": 1.5 }
        ]
      },
      {
        "measurement": "MEMORY_USAGE_GB",
        "tags": { "serviceId": null, "region": "us-east4" },
        "values": [{ "ts": 1800000000, "value": 0.1 }]
      }
    ]
  }
}`) as {
  data: {
    metrics: {
      measurement: string
      tags: { serviceId: string | null; region: string | null }
      values: { ts: number | string | null; value: number | null }[]
    }[]
  }
}

const logsBody = JSON.parse(`{
  "data": {
    "environmentLogs": [
      {
        "timestamp": "2026-09-25T12:00:01.123456789Z",
        "message": "ready",
        "severity": "info",
        "attributes": [
          { "key": "level", "value": "\\"info\\"" },
          { "key": "", "value": "skip" }
        ],
        "tags": { "serviceId": "11111111-1111-1111-1111-111111111111", "deploymentId": "dep-made-up" }
      },
      {
        "timestamp": "2026-09-25T12:00:02Z",
        "message": null,
        "severity": null,
        "attributes": null,
        "tags": null
      }
    ]
  }
}`) as {
  data: {
    environmentLogs: {
      timestamp: string
      message: string | null
      severity: string | null
      attributes: { key: string; value: string }[] | null
      tags: { serviceId: string; deploymentId: string } | null
    }[]
  }
}

describe("parseMetricsPayload", () => {
  test("reads a GraphQL metrics payload, keeps unix-second ts, and drops bad samples", () => {
    const series = parseMetricsPayload(metricsBody.data.metrics)
    expect(series).toEqual([
      {
        measurement: "CPU_USAGE",
        serviceId: "11111111-1111-1111-1111-111111111111",
        region: "us-east4-eqdc16a",
        values: [
          { ts: 1800000000, value: 0.25 },
          { ts: 1800000060, value: 0.5 },
        ],
      },
      {
        measurement: "DISK_USAGE_GB",
        serviceId: "22222222-2222-2222-2222-222222222222",
        region: "asia-southeast1-eqsg3a",
        values: [{ ts: 1800000000, value: 1.5 }],
      },
      {
        measurement: "MEMORY_USAGE_GB",
        serviceId: null,
        region: "us-east4",
        values: [{ ts: 1800000000, value: 0.1 }],
      },
    ])
    const withNonFinite = parseMetricsPayload([
      {
        measurement: "CPU_USAGE",
        tags: { serviceId: "svc", region: "us-east4" },
        values: [
          { ts: 1.5, value: 1 },
          { ts: 1800000000, value: Number.NaN },
          { ts: 1800000060, value: Number.POSITIVE_INFINITY },
        ],
      },
    ])
    expect(withNonFinite[0]?.values).toEqual([])
  })
})

describe("parseEnvironmentLogsPayload", () => {
  test("reads environmentLogs rows and marks the cap when the page is full", () => {
    const parsed = parseEnvironmentLogsPayload(logsBody.data.environmentLogs, 5000)
    expect(parsed.capped).toBe(false)
    expect(parsed.logs).toEqual([
      {
        timestamp: "2026-09-25T12:00:01.123456789Z",
        message: "ready",
        severity: "info",
        attributes: [{ key: "level", value: '"info"' }],
        serviceId: "11111111-1111-1111-1111-111111111111",
        deploymentId: "dep-made-up",
      },
      {
        timestamp: "2026-09-25T12:00:02Z",
        message: "",
        severity: null,
        attributes: [],
        serviceId: null,
        deploymentId: null,
      },
    ])
    expect(parseEnvironmentLogsPayload(logsBody.data.environmentLogs, 2).capped).toBe(true)
    expect(parseEnvironmentLogsPayload(logsBody.data.environmentLogs, 3).capped).toBe(false)
  })
})
