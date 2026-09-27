import { getJson, isRecord, requiredEnv } from "../http"
import { sumRows, type CostRow } from "../rows"

export async function rows(days: string[]): Promise<CostRow[]> {
  const token = requiredEnv("GITHUB_BILLING_TOKEN")
  const batches = await Promise.all(days.map((day) => fetchDay(day, token)))
  return sumRows(batches.flat())
}

async function fetchDay(day: string, token: string): Promise<CostRow[]> {
  const [year, month, date] = day.split("-")
  if (!year || !month || !date) throw new Error(`invalid day ${day}`)
  const params = new URLSearchParams({ year, month: String(Number(month)), day: String(Number(date)) })
  const body = await getJson(
    `https://api.github.com/organizations/ctxpipe-ai/settings/billing/usage?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        Accept: "application/vnd.github+json",
      },
    },
    "GitHub billing usage",
  )
  if (!isRecord(body) || !Array.isArray(body.usageItems)) throw new Error("GitHub billing usage response was missing usageItems")
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
