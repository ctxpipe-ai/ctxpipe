import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { mapRowsToOtlp, utcDays, type CostRow } from "./rows"

const ROW: CostRow = {
  day: "2026-09-25",
  provider: "openrouter",
  sku: "openai/gpt-4.1",
  scope: "OpenAI",
  usage: 5,
  unit: "requests",
  costUsd: 0.015,
  source: "reported",
}

function attr(attributes: { key: string; value: { stringValue: string } }[], key: string) {
  return attributes.find((attribute) => attribute.key === key)?.value.stringValue
}

describe("utcDays", () => {
  test("returns the last count UTC days ending today", () => {
    expect(utcDays(Date.parse("2026-09-26T23:59:59.999Z"), 3)).toEqual(["2026-09-24", "2026-09-25", "2026-09-26"])
    expect(utcDays(Date.parse("2026-09-26T00:00:00.000Z"), 1)).toEqual(["2026-09-26"])
  })

  test("crosses a month boundary", () => {
    expect(utcDays(Date.parse("2026-03-01T12:00:00.000Z"), 3)).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"])
  })
})

describe("mapRowsToOtlp", () => {
  afterEach(() => {
    setSystemTime()
  })

  test("maps cost and usage gauges with resource attributes and day timestamps", () => {
    setSystemTime(new Date("2026-09-27T10:40:00.000Z"))
    const observedAt = String(Date.now())
    const payload = mapRowsToOtlp([ROW])
    const resource = payload.resourceMetrics[0]
    expect(attr(resource?.resource.attributes ?? [], "service.name")).toBe("cost-telemetry")
    expect(attr(resource?.resource.attributes ?? [], "service.namespace")).toBe("ctxpipe")
    expect(attr(resource?.resource.attributes ?? [], "deployment.environment")).toBe("observability")
    expect(resource?.scopeMetrics[0]?.scope.name).toBe("cost-telemetry")

    const metrics = Object.fromEntries((resource?.scopeMetrics[0]?.metrics ?? []).map((metric) => [metric.name, metric]))
    expect(metrics["billing.fx_rate"]).toBeUndefined()
    expect(metrics["billing.cost"]).toEqual({
      name: "billing.cost",
      unit: "USD",
      gauge: {
        dataPoints: [
          {
            asDouble: 0.015,
            timeUnixNano: `${BigInt(Date.parse("2026-09-25T00:00:00.000Z")) * 1_000_000n}`,
            attributes: [
              { key: "billing.provider", value: { stringValue: "openrouter" } },
              { key: "billing.sku", value: { stringValue: "openai/gpt-4.1" } },
              { key: "billing.scope", value: { stringValue: "OpenAI" } },
              { key: "billing.source", value: { stringValue: "reported" } },
              { key: "billing.unit", value: { stringValue: "requests" } },
              { key: "billing.observed_at_unix_ms", value: { stringValue: observedAt } },
            ],
          },
        ],
      },
    })
    expect(metrics["billing.usage"]).toEqual({
      name: "billing.usage",
      unit: "1",
      gauge: {
        dataPoints: [
          {
            asDouble: 5,
            timeUnixNano: `${BigInt(Date.parse("2026-09-25T00:00:00.000Z")) * 1_000_000n}`,
            attributes: [
              { key: "billing.provider", value: { stringValue: "openrouter" } },
              { key: "billing.sku", value: { stringValue: "openai/gpt-4.1" } },
              { key: "billing.scope", value: { stringValue: "OpenAI" } },
              { key: "billing.source", value: { stringValue: "reported" } },
              { key: "billing.unit", value: { stringValue: "requests" } },
              { key: "billing.observed_at_unix_ms", value: { stringValue: observedAt } },
            ],
          },
        ],
      },
    })
  })

  test("keeps TimeUnix on the billing day and stamps one later observed_at so a downward revision is the latest row", () => {
    const first = Date.parse("2026-09-26T12:00:00.000Z")
    const second = Date.parse("2026-09-26T18:00:00.000Z")
    setSystemTime(new Date(first))
    const earlier = mapRowsToOtlp([ROW])
    setSystemTime(new Date(second))
    const later = mapRowsToOtlp([{ ...ROW, costUsd: -0.5, usage: 0 }])

    const earlierCost = earlier.resourceMetrics[0]?.scopeMetrics[0]?.metrics.find((metric) => metric.name === "billing.cost")?.gauge.dataPoints[0]
    const laterCost = later.resourceMetrics[0]?.scopeMetrics[0]?.metrics.find((metric) => metric.name === "billing.cost")?.gauge.dataPoints[0]
    const laterUsage = later.resourceMetrics[0]?.scopeMetrics[0]?.metrics.find((metric) => metric.name === "billing.usage")?.gauge.dataPoints[0]
    const dayUnix = `${BigInt(Date.parse("2026-09-25T00:00:00.000Z")) * 1_000_000n}`
    expect(earlierCost?.timeUnixNano).toBe(dayUnix)
    expect(laterCost?.timeUnixNano).toBe(dayUnix)
    expect(laterUsage?.timeUnixNano).toBe(dayUnix)
    expect(attr(earlierCost?.attributes ?? [], "billing.observed_at_unix_ms")).toBe(String(first))
    expect(attr(laterCost?.attributes ?? [], "billing.observed_at_unix_ms")).toBe(String(second))
    expect(attr(laterUsage?.attributes ?? [], "billing.observed_at_unix_ms")).toBe(String(second))
    expect(laterCost?.asDouble).toBe(-0.5)
    expect(Number(attr(laterCost?.attributes ?? [], "billing.observed_at_unix_ms"))).toBeGreaterThan(
      Number(attr(earlierCost?.attributes ?? [], "billing.observed_at_unix_ms")),
    )
  })

  test("emits one billing.usage metric with unit 1 when row units differ", () => {
    const minutes: CostRow = { ...ROW, provider: "github", sku: "actions-linux", unit: "minutes", usage: 12 }
    const payload = mapRowsToOtlp([ROW, minutes])
    const usage = (payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? []).filter((metric) => metric.name === "billing.usage")
    expect(usage).toHaveLength(1)
    expect(usage[0]?.unit).toBe("1")
    expect(usage[0]?.gauge.dataPoints.map((point) => attr(point.attributes, "billing.unit"))).toEqual(["requests", "minutes"])
    expect(usage[0]?.gauge.dataPoints.map((point) => point.asDouble)).toEqual([5, 12])
  })

  test("adds billing.fx_rate when an fx sample is given", () => {
    const payload = mapRowsToOtlp([ROW], { rate: 1.4224, timeUnixNano: "123" })
    const fx = payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics.find((metric) => metric.name === "billing.fx_rate")
    expect(fx).toEqual({
      name: "billing.fx_rate",
      unit: "1",
      gauge: {
        dataPoints: [{ asDouble: 1.4224, timeUnixNano: "123", attributes: [{ key: "billing.pair", value: { stringValue: "USD/AUD" } }] }],
      },
    })
  })

  test("omits gauges when there are no rows and no fx", () => {
    expect(mapRowsToOtlp([])).toEqual({ resourceMetrics: [] })
  })
})
