/**
 * USD of one gateway call, from its OpenAI-compatible `usage` (OpenRouter
 * reports it). With a bring-your-own-key route, OpenRouter reports in `cost`
 * only its own fee and puts the provider charge in
 * `cost_details.upstream_inference_cost`, so the call costs both.
 */
export function gatewayCost(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined
  const record = usage as Record<string, unknown>
  const cost = nonNegative(record.cost)
  const details =
    record.cost_details && typeof record.cost_details === "object"
      ? (record.cost_details as Record<string, unknown>)
      : {}
  const upstream = nonNegative(details.upstream_inference_cost)
  if (record.is_byok === true && upstream !== undefined)
    return (cost ?? 0) + upstream
  return cost
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}
