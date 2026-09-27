import { getJson, isRecord } from "./http"

export async function usdAudRate(): Promise<number> {
  // providers=ecb pins the European Central Bank; v2's default blends all sources.
  const body = await getJson("https://api.frankfurter.dev/v2/rates?base=USD&quotes=AUD&providers=ecb", {}, "Frankfurter")
  if (!Array.isArray(body)) throw new Error("Frankfurter response was missing rates")
  for (const item of body) {
    if (!isRecord(item)) continue
    if (typeof item.rate !== "number" || !Number.isFinite(item.rate)) continue
    return item.rate
  }
  throw new Error("Frankfurter USD/AUD rate is not finite")
}
