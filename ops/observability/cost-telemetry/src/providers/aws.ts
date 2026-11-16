import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer"
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers"
import { FetchHttpHandler } from "@smithy/fetch-http-handler"
import { ProviderError } from "../http"
import { sumRows, type CostRow } from "../rows"

/** The name of each account of the organization (billing.account). An account that is not here keeps its id as its name. */
const ACCOUNT_NAMES: Record<string, string> = {
  "213102790567": "production",
  "134416647419": "factory",
  "787752212265": "selfhost-sandbox",
  "115673809568": "archive",
  "573018602187": "preview",
  "007664619564": "management",
}

/**
 * AWS Cost Explorer of the management account: the payer view of every account of the organization.
 *
 * Assumptions (official GetCostAndUsage:
 * https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html):
 * - TimePeriod start is inclusive, end is exclusive. The shared 3-day window becomes
 *   Start=first day, End=day after last day.
 * - GroupBy takes at most two keys: LINKED_ACCOUNT and SERVICE. sku is the service, scope is
 *   `{account}/{service}`, and billing.account is the account's name from ACCOUNT_NAMES.
 * - NetUnblendedCost is a documented metric (cost after discounts). UnblendedCost is
 *   requested too so a group that omits NetUnblendedCost still has a cost figure.
 * - source is always `reported`. Cost Explorer sets Estimated=true for the current
 *   month until the bill finalizes; that is still the provider figure.
 * - Negative Amounts (credits, refunds) are emitted as-is so they reduce the daily total.
 * - A group with no finite cost (neither metric) throws.
 * - usage is 0 and unit is empty: a service sums usage types of different units (hours,
 *   GB-months, requests), so its UsageQuantity is no quantity. UsageQuantity is not requested.
 * - Auth: the SDK default credential chain (the ECS task role) assumes ctxpipe-cost-explorer-read
 *   (a read-only ce:GetCostAndUsage role in the management account) through STS. The STS client
 *   takes the region and the HTTP handler of the Cost Explorer client. This package does not
 *   create credentials or IAM.
 * - Cost Explorer API: $0.01 per paginated request (AWS Cost Explorer pricing). The run calls it only when `due`.
 * - HTTP uses official FetchHttpHandler (not Node HTTPS) so Bun and MSW see the
 *   call. customFetch buffers the body first: an MSW/Bun ReadableStream is empty
 *   by the time the SDK streamCollector runs. maxAttempts is 1 so retries do not
 *   multiply the $0.01-per-page charge.
 */
export async function rows(days: string[]): Promise<CostRow[]> {
  const first = days[0]
  const last = days[days.length - 1]
  if (!first || !last) return []
  const wanted = new Set(days)
  const start = first
  const end = exclusiveEnd(last)
  const client = new CostExplorerClient({
    region: "us-east-1",
    // A constant, not an env var: the factory policy pack forbids another account's ARN in the task definition.
    credentials: fromTemporaryCredentials({
      params: { RoleArn: "arn:aws:iam::007664619564:role/ctxpipe-cost-explorer-read", RoleSessionName: "ctxpipe-cost-telemetry" },
    }),
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
          Metrics: ["NetUnblendedCost", "UnblendedCost"],
          GroupBy: [
            { Type: "DIMENSION", Key: "LINKED_ACCOUNT" },
            { Type: "DIMENSION", Key: "SERVICE" },
          ],
          NextPageToken: nextPageToken,
        }),
      )
      if (!Array.isArray(response.ResultsByTime)) throw new ProviderError("parse", "Cost Explorer response was missing ResultsByTime")
      for (const result of response.ResultsByTime) {
        const day = result.TimePeriod?.Start
        if (!day) throw new ProviderError("parse", "Cost Explorer result was missing TimePeriod.Start")
        if (!wanted.has(day)) continue
        for (const group of result.Groups ?? []) {
          const account = group.Keys?.[0]
          const service = group.Keys?.[1]
          if (!account || !service) throw new ProviderError("parse", "Cost Explorer group was missing LINKED_ACCOUNT or SERVICE")
          const costUsd = metricAmount(group.Metrics, "NetUnblendedCost") ?? metricAmount(group.Metrics, "UnblendedCost")
          if (costUsd === undefined) {
            throw new ProviderError("parse", `Cost Explorer group ${account}/${service} on ${day} was missing NetUnblendedCost and UnblendedCost`)
          }
          mapped.push({
            day,
            provider: "aws",
            sku: service,
            scope: `${account}/${service}`,
            usage: 0,
            unit: "",
            costUsd,
            source: "reported",
            account: ACCOUNT_NAMES[account] ?? account,
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

function metricAmount(metrics: Record<string, { Amount?: string } | undefined> | undefined, name: string): number | undefined {
  const amount = metrics?.[name]?.Amount
  if (typeof amount !== "string" || amount.trim() === "") return undefined
  const value = Number(amount)
  return Number.isFinite(value) ? value : undefined
}

/** Cost Explorer is billed per paginated request and updates at least daily, so the hourly run calls it only at 12:17 UTC. */
export function due(now: Date): boolean {
  return now.getUTCHours() === 12
}
