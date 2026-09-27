import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer"
import { FetchHttpHandler } from "@smithy/fetch-http-handler"
import { requiredEnv } from "../http"
import { sumRows, type CostRow } from "../rows"

/** ctxpipe-sandbox (`~/.aws/config` profile). Hardcoded so another account cannot leak into this dashboard. */
const LINKED_ACCOUNT = "007664619564"
/** Cost Explorer is billed per paginated request and updates at least daily; the hourly cron only calls at 12:17 UTC. */
const FETCH_HOUR_UTC = 12

/**
 * AWS Cost Explorer for the ctxpipe-sandbox account.
 *
 * Assumptions (official GetCostAndUsage:
 * https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html):
 * - TimePeriod start is inclusive, end is exclusive. The shared 3-day window becomes
 *   Start=first day, End=day after last day.
 * - NetUnblendedCost is a documented metric (cost after discounts). UnblendedCost is
 *   requested too so a group that omits NetUnblendedCost still has a cost figure.
 * - source is always `reported`. Cost Explorer sets Estimated=true for the current
 *   month until the bill finalizes; that is still the provider figure.
 * - Negative Amounts (credits, refunds) are emitted as-is so they reduce the daily total.
 * - A group with no finite cost (neither metric) throws. Missing/invalid UsageQuantity
 *   becomes usage=0 so a real cost row is not dropped. Unit "N/A" or empty is not meaningful.
 * - sku is USAGE_TYPE, scope is `{account}/{SERVICE}`. One point per day+sku+scope (sumRows).
 * - LINKED_ACCOUNT is this sandbox id, not an env var: it is a fixed internal test
 *   account (root AGENTS.md: no new env for values that do not differ by environment).
 * - Auth is the standard AWS env keys on Railway for a read-only ce:GetCostAndUsage
 *   principal. This package does not create credentials or IAM.
 * - Cost Explorer API: $0.01 per paginated request (AWS Cost Explorer pricing).
 * - HTTP uses official FetchHttpHandler (not Node HTTPS) so Bun and MSW see the
 *   call. customFetch buffers the body first: an MSW/Bun ReadableStream is empty
 *   by the time the SDK streamCollector runs. maxAttempts is 1 so retries do not
 *   multiply the $0.01-per-page charge.
 */
export async function rows(days: string[]): Promise<CostRow[]> {
  if (new Date().getUTCHours() !== FETCH_HOUR_UTC) return []
  const first = days[0]
  const last = days[days.length - 1]
  if (!first || !last) return []
  const accessKeyId = requiredEnv("AWS_ACCESS_KEY_ID")
  const secretAccessKey = requiredEnv("AWS_SECRET_ACCESS_KEY")
  const sessionToken = process.env.AWS_SESSION_TOKEN?.trim() || undefined
  const wanted = new Set(days)
  const start = first
  const end = exclusiveEnd(last)
  const client = new CostExplorerClient({
    region: "us-east-1",
    credentials: { accessKeyId, secretAccessKey, sessionToken },
    requestHandler: new FetchHttpHandler({
      requestTimeout: 30_000,
      customFetch: (async (input, init) => {
        const response = await fetch(input, init)
        return new Response(await response.arrayBuffer(), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }) as typeof fetch,
    }),
    maxAttempts: 1,
  })
  try {
    const mapped: CostRow[] = []
    let nextPageToken: string | undefined
    do {
      const response = await client.send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: start, End: end },
          Granularity: "DAILY",
          Metrics: ["NetUnblendedCost", "UnblendedCost", "UsageQuantity"],
          GroupBy: [
            { Type: "DIMENSION", Key: "SERVICE" },
            { Type: "DIMENSION", Key: "USAGE_TYPE" },
          ],
          Filter: { Dimensions: { Key: "LINKED_ACCOUNT", Values: [LINKED_ACCOUNT] } },
          NextPageToken: nextPageToken,
        }),
      )
      if (!Array.isArray(response.ResultsByTime)) throw new Error("Cost Explorer response was missing ResultsByTime")
      for (const result of response.ResultsByTime) {
        const day = result.TimePeriod?.Start
        if (!day) throw new Error("Cost Explorer result was missing TimePeriod.Start")
        if (!wanted.has(day)) continue
        for (const group of result.Groups ?? []) {
          const service = group.Keys?.[0]
          const usageType = group.Keys?.[1]
          if (!service || !usageType) throw new Error("Cost Explorer group was missing SERVICE or USAGE_TYPE")
          const costUsd = metricAmount(group.Metrics, "NetUnblendedCost") ?? metricAmount(group.Metrics, "UnblendedCost")
          if (costUsd === undefined) {
            throw new Error(`Cost Explorer group ${service}/${usageType} on ${day} was missing NetUnblendedCost and UnblendedCost`)
          }
          const usageMetric = group.Metrics?.UsageQuantity
          const usage = metricAmount({ UsageQuantity: usageMetric }, "UsageQuantity") ?? 0
          mapped.push({
            day,
            provider: "aws",
            sku: usageType,
            scope: `${LINKED_ACCOUNT}/${service}`,
            usage,
            unit: meaningfulUnit(usageMetric?.Unit),
            costUsd,
            source: "reported",
          })
        }
      }
      nextPageToken = response.NextPageToken
    } while (nextPageToken)
    return sumRows(mapped)
  } finally {
    client.destroy()
  }
}

function exclusiveEnd(lastDay: string): string {
  const startMs = Date.parse(`${lastDay}T00:00:00.000Z`)
  if (!Number.isFinite(startMs)) throw new Error(`invalid day ${lastDay}`)
  return new Date(startMs + 86_400_000).toISOString().slice(0, 10)
}

function metricAmount(
  metrics: Record<string, { Amount?: string } | undefined> | undefined,
  name: string,
): number | undefined {
  const amount = metrics?.[name]?.Amount
  if (typeof amount !== "string" || amount.trim() === "") return undefined
  const value = Number(amount)
  return Number.isFinite(value) ? value : undefined
}

function meaningfulUnit(unit: string | undefined): string {
  if (typeof unit !== "string") return ""
  const trimmed = unit.trim()
  if (!trimmed || trimmed.toUpperCase() === "N/A") return ""
  return trimmed
}
