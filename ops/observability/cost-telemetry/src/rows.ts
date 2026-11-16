export type CostRow = {
  day: string
  provider: "openrouter" | "github" | "blacksmith" | "cloudflare" | "aws" | "linear"
  sku: string
  scope: string
  usage: number
  unit: string
  costUsd: number
  /** README "Sources": reported by the provider, or derived from a plan and a committed price. */
  source: "reported" | "derived"
  /** The name of the AWS account (billing.account). */
  account?: string
}

type FxSample = { rate: number; timeUnixNano: string }
/** The result of one provider entry of a run: `error` is the class of its failure, absent on success. */
export type ProviderStatus = { provider: string; error?: string }

type OtlpAttribute = { key: string; value: { stringValue: string } }
type OtlpDataPoint = { asDouble: number; timeUnixNano: string; attributes: OtlpAttribute[] }
type OtlpMetric = { name: string; unit: string; gauge: { dataPoints: OtlpDataPoint[] } }

export type OtlpMetricsRequest = {
  resourceMetrics: { resource: { attributes: OtlpAttribute[] }; scopeMetrics: { scope: { name: string }; metrics: OtlpMetric[] }[] }[]
}

export function sumRows(rows: CostRow[]): CostRow[] {
  const byKey = new Map<string, CostRow>()
  for (const row of rows) {
    const key = `${row.day}\0${row.provider}\0${row.sku}\0${row.scope}\0${row.source}\0${row.unit}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { ...row })
      continue
    }
    existing.usage += row.usage
    existing.costUsd += row.costUsd
  }
  return [...byKey.values()]
}

/**
 * Derived rows of a seat plan: for each day, `seats` × the monthly seat price spread over the days of that day's
 * month. Every day of the window takes today's seat count.
 */
export function seatRows(
  days: string[],
  plan: Pick<CostRow, "provider" | "sku" | "scope">,
  seats: number,
  usdPerSeatMonth: number,
): CostRow[] {
  return days.map((day) => {
    const daysInMonth = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate()
    return { day, ...plan, usage: seats, unit: "seats", costUsd: (seats * usdPerSeatMonth) / daysInMonth, source: "derived" }
  })
}

/** Last `count` UTC days ending on the UTC calendar day of `nowMs`. */
export function utcDays(nowMs: number, count: number): string[] {
  const start = new Date(nowMs)
  const year = start.getUTCFullYear()
  const month = start.getUTCMonth()
  const date = start.getUTCDate()
  const days: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    days.push(new Date(Date.UTC(year, month, date - i)).toISOString().slice(0, 10))
  }
  return days
}

/** `observedAtMs` is the time of the run: the observed_at of each point and the time of each status point. */
export function mapRowsToOtlp(rows: CostRow[], fx?: FxSample, statuses: ProviderStatus[] = [], observedAtMs = Date.now()): OtlpMetricsRequest {
  const observedAtUnixMs = String(observedAtMs)
  const metrics: OtlpMetric[] = []
  if (rows.length > 0) {
    metrics.push({
      name: "billing.cost",
      unit: "USD",
      gauge: { dataPoints: rows.map((row) => dataPoint(row, row.costUsd, observedAtUnixMs)) },
    })
    metrics.push({
      name: "billing.usage",
      unit: "1",
      gauge: { dataPoints: rows.map((row) => dataPoint(row, row.usage, observedAtUnixMs)) },
    })
  }
  if (fx) {
    metrics.push({
      name: "billing.fx_rate",
      unit: "1",
      gauge: {
        dataPoints: [{ asDouble: fx.rate, timeUnixNano: fx.timeUnixNano, attributes: [attr("billing.pair", "USD/AUD")] }],
      },
    })
  }
  if (statuses.length > 0) {
    const timeUnixNano = (BigInt(observedAtUnixMs) * 1_000_000n).toString()
    metrics.push({
      name: "billing.provider_status",
      unit: "1",
      gauge: {
        dataPoints: statuses.map((status) => ({
          asDouble: status.error === undefined ? 1 : 0,
          timeUnixNano,
          attributes: [
            attr("billing.provider", status.provider),
            attr("billing.observed_at_unix_ms", observedAtUnixMs),
            ...(status.error === undefined ? [] : [attr("billing.error", status.error)]),
          ],
        })),
      },
    })
  }
  if (metrics.length === 0) return { resourceMetrics: [] }
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            attr("service.name", "cost-telemetry"),
            attr("service.namespace", "ctxpipe"),
            attr("deployment.environment", "observability"),
          ],
        },
        scopeMetrics: [{ scope: { name: "cost-telemetry" }, metrics }],
      },
    ],
  }
}

function dataPoint(row: CostRow, value: number, observedAtUnixMs: string): OtlpDataPoint {
  return {
    asDouble: value,
    timeUnixNano: (BigInt(Date.parse(`${row.day}T00:00:00.000Z`)) * 1_000_000n).toString(),
    attributes: [
      attr("billing.provider", row.provider),
      attr("billing.sku", row.sku),
      attr("billing.scope", row.scope),
      attr("billing.source", row.source),
      attr("billing.unit", row.unit),
      attr("billing.observed_at_unix_ms", observedAtUnixMs),
      ...(row.account === undefined ? [] : [attr("billing.account", row.account)]),
    ],
  }
}

function attr(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } }
}
