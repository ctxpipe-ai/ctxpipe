import { getJson, isRecord, ProviderError } from "../http"
import { providerInput } from "../secrets"
import { githubUsdPerSeatMonth } from "../rates"
import { seatRows, sumRows, type CostRow } from "../rows"

/** The organization's metered usage (Actions, Packages, and others): netAmount is the real spend, source `reported`. */
export async function rows(days: string[]): Promise<CostRow[]> {
  const token = providerInput("GITHUB_BILLING_TOKEN")
  const batches = await Promise.all(days.map((day) => fetchDay(day, token)))
  return sumRows(batches.flat())
}

/**
 * The organization's plan seats. The billing usage report has only metered products, not the plan's seats, so the
 * rows are `plan.seats` (the paid seats) of GET /orgs/{org} × the committed seat price (src/rates.ts), source
 * `derived`. GitHub shows `plan` only to an organization owner's token; without it this throws.
 */
export async function planRows(days: string[]): Promise<CostRow[]> {
  const token = providerInput("GITHUB_BILLING_TOKEN")
  const body = await getJson("https://api.github.com/orgs/ctxpipe-ai", { headers: headers(token) }, "GitHub organization")
  const plan = isRecord(body) && isRecord(body.plan) ? body.plan : undefined
  if (!plan) throw new ProviderError("no_plan", "GitHub organization response has no plan: the token cannot see the organization's plan")
  if (typeof plan.name !== "string" || typeof plan.seats !== "number" || !Number.isFinite(plan.seats)) {
    throw new ProviderError("parse", "GitHub organization plan was missing name or seats")
  }
  if (plan.name === "free") return []
  const price = githubUsdPerSeatMonth[plan.name]
  if (price === undefined) throw new ProviderError("no_price", `no committed seat price for GitHub plan ${plan.name} (src/rates.ts)`)
  return seatRows(days, { provider: "github", sku: `plan/${plan.name}`, scope: "org" }, plan.seats, price)
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    Accept: "application/vnd.github+json",
  }
}

async function fetchDay(day: string, token: string): Promise<CostRow[]> {
  const [year, month, date] = day.split("-")
  if (!year || !month || !date) throw new Error(`invalid day ${day}`)
  const params = new URLSearchParams({ year, month: String(Number(month)), day: String(Number(date)) })
  const body = await getJson(
    `https://api.github.com/organizations/ctxpipe-ai/settings/billing/usage?${params}`,
    { headers: headers(token) },
    "GitHub billing usage",
  )
  if (!isRecord(body) || !Array.isArray(body.usageItems)) throw new ProviderError("parse", "GitHub billing usage response was missing usageItems")
  const mapped: CostRow[] = []
  for (const item of body.usageItems) {
    if (!isRecord(item)) continue
    if (typeof item.date !== "string" || typeof item.product !== "string" || typeof item.sku !== "string") continue
    if (typeof item.unitType !== "string") continue
    if (typeof item.quantity !== "number" || !Number.isFinite(item.quantity)) continue
    if (typeof item.netAmount !== "number" || !Number.isFinite(item.netAmount)) continue
    const scope = typeof item.repositoryName === "string" && item.repositoryName ? item.repositoryName : "org"
    mapped.push({
      day: item.date.slice(0, 10),
      provider: "github",
      sku: `${item.product}/${item.sku}`,
      scope,
      usage: item.quantity,
      unit: item.unitType,
      costUsd: item.netAmount,
      source: "reported",
    })
  }
  return mapped
}
