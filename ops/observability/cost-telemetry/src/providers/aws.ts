import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type Expression,
} from "@aws-sdk/client-cost-explorer"
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers"

import { fetchHandler, ProviderError } from "../http"
import type { CostRow } from "../rows"

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
 * - The rows are the cost before credits: they do not include records of RECORD_TYPE Credit. A credit record
 *   cancels the usage that it pays, so with credits the daily total is about 0.
 * - GroupBy takes at most two keys, so the run makes two queries with a RECORD_TYPE filter:
 *   1. RECORD_TYPE = Usage, grouped by LINKED_ACCOUNT and SERVICE: sku is the service, scope is
 *      `{account}/{service}`.
 *   2. RECORD_TYPE is not Usage and not Credit (Tax, Support, Refund, Fee, and each other type), grouped by
 *      LINKED_ACCOUNT and RECORD_TYPE: sku is the record type, scope is `{account}/{record type}`.
 *   Together the rows sum to the bill before credits.
 * - billing.account is the account's name from ACCOUNT_NAMES.
 * - NetUnblendedCost is a documented metric (cost after discounts). UnblendedCost is
 *   requested too so a group that omits NetUnblendedCost still has a cost figure.
 * - source is always `reported`. Cost Explorer sets Estimated=true for the current
 *   month until the bill finalizes; that is still the provider figure.
 * - Amounts keep their sign: a refund is negative.
 * - A group with no finite cost (neither metric) throws.
 * - usage is 0 and unit is empty: a service sums usage types of different units (hours,
 *   GB-months, requests), so its UsageQuantity is no quantity. UsageQuantity is not requested.
 * - Auth: the SDK default credential chain (the ECS task role) assumes ctxpipe-cost-explorer-read
 *   (a read-only ce:GetCostAndUsage role in the management account) through STS. The STS client
 *   takes the region and the HTTP handler of the Cost Explorer client. This package does not
 *   create credentials or IAM.
 * - Cost Explorer API: $0.01 per paginated request (AWS Cost Explorer pricing). The run calls it only when `due`.
 * - HTTP uses fetchHandler (src/http.ts), so Bun and MSW see the call. maxAttempts
 *   is 1 so retries do not multiply the $0.01-per-page charge.
 */
export async function rows(days: string[]): Promise<CostRow[]> {
  const first = days[0]
  const last = days[days.length - 1]
  if (!first || !last) return []
  const window: Window = {
    start: first,
    end: exclusiveEnd(last),
    days: new Set(days),
  }
  const client = new CostExplorerClient({
    region: "us-east-1",
    // A constant, not an env var: the factory policy pack forbids another account's ARN in the task definition.
    credentials: fromTemporaryCredentials({
      params: {
        RoleArn: "arn:aws:iam::007664619564:role/ctxpipe-cost-explorer-read",
        RoleSessionName: "ctxpipe-cost-telemetry",
      },
    }),
    requestHandler: fetchHandler(),
    maxAttempts: 1,
  })
  try {
    const usage = await queryRows(client, window, "SERVICE", {
      Dimensions: { Key: "RECORD_TYPE", Values: ["Usage"] },
    })
    const otherRecordTypes = await queryRows(client, window, "RECORD_TYPE", {
      Not: { Dimensions: { Key: "RECORD_TYPE", Values: ["Usage", "Credit"] } },
    })
    return [...usage, ...otherRecordTypes]
  } finally {
    client.destroy()
  }
}

type Window = { start: string; end: string; days: Set<string> }

/** Every page of one daily query, grouped by LINKED_ACCOUNT and `key`: one row per group and day of the window. */
async function queryRows(
  client: CostExplorerClient,
  window: Window,
  key: "SERVICE" | "RECORD_TYPE",
  filter: Expression,
): Promise<CostRow[]> {
  const mapped: CostRow[] = []
  let nextPageToken: string | undefined
  do {
    const response = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: window.start, End: window.end },
        Granularity: "DAILY",
        Filter: filter,
        Metrics: ["NetUnblendedCost", "UnblendedCost"],
        GroupBy: [
          { Type: "DIMENSION", Key: "LINKED_ACCOUNT" },
          { Type: "DIMENSION", Key: key },
        ],
        NextPageToken: nextPageToken,
      }),
    )
    if (!Array.isArray(response.ResultsByTime))
      throw new ProviderError(
        "parse",
        "Cost Explorer response was missing ResultsByTime",
      )
    for (const result of response.ResultsByTime) {
      const day = result.TimePeriod?.Start
      if (!day)
        throw new ProviderError(
          "parse",
          "Cost Explorer result was missing TimePeriod.Start",
        )
      if (!window.days.has(day)) continue
      for (const group of result.Groups ?? []) {
        const account = group.Keys?.[0]
        const sku = group.Keys?.[1]
        if (!account || !sku)
          throw new ProviderError(
            "parse",
            `Cost Explorer group was missing LINKED_ACCOUNT or ${key}`,
          )
        const costUsd =
          metricAmount(group.Metrics, "NetUnblendedCost") ??
          metricAmount(group.Metrics, "UnblendedCost")
        if (costUsd === undefined) {
          throw new ProviderError(
            "parse",
            `Cost Explorer group ${account}/${sku} on ${day} was missing NetUnblendedCost and UnblendedCost`,
          )
        }
        mapped.push({
          day,
          provider: "aws",
          sku,
          scope: `${account}/${sku}`,
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
  return mapped
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

/** Cost Explorer is billed per paginated request and updates at least daily, so the hourly run calls it only at 12:17 UTC. */
export function due(now: Date): boolean {
  return now.getUTCHours() === 12
}
