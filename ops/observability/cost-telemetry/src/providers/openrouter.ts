import { getJson, isRecord, requiredEnv } from "../http"
import { sumRows, utcDays, type CostRow } from "../rows"

export async function rows(days: string[]): Promise<CostRow[]> {
  const key = requiredEnv("OPENROUTER_MANAGEMENT_KEY")
  const last = days[days.length - 1]
  if (!last) return []
  // OpenRouter only serves completed UTC days, so shift one day back from the shared window.
  const completed = utcDays(Date.parse(`${last}T00:00:00.000Z`) - 86_400_000, days.length)
  const batches = await Promise.all(completed.map((day) => fetchDay(day, key)))
  return sumRows(batches.flat())
}

async function fetchDay(day: string, key: string): Promise<CostRow[]> {
  const body = await getJson(
    `https://openrouter.ai/api/v1/activity?date=${day}`,
    { headers: { Authorization: `Bearer ${key}` } },
    "OpenRouter activity",
  )
  if (!isRecord(body) || !Array.isArray(body.data)) throw new Error("OpenRouter activity response was missing data")
  const mapped: CostRow[] = []
  for (const item of body.data) {
    if (!isRecord(item)) continue
    if (typeof item.date !== "string" || typeof item.model !== "string" || typeof item.provider_name !== "string") continue
    if (typeof item.prompt_tokens !== "number" || !Number.isFinite(item.prompt_tokens)) continue
    if (typeof item.completion_tokens !== "number" || !Number.isFinite(item.completion_tokens)) continue
    if (typeof item.usage !== "number" || !Number.isFinite(item.usage)) continue
    mapped.push({
      day: item.date,
      provider: "openrouter",
      sku: item.model,
      scope: item.provider_name,
      usage: item.prompt_tokens + item.completion_tokens,
      unit: "tokens",
      costUsd: item.usage,
      source: "reported",
    })
  }
  return mapped
}
