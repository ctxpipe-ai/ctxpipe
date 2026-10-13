import { McpToolError } from "./tool-errors.js"

/**
 * Tool calls that one principal can have in flight in this process (ADR-051
 * consequences). Agents send parallel calls in one turn, so the limit allows
 * a burst of 8; codesearch keeps its own ADR-027 budgets.
 */
export const MAX_IN_FLIGHT_PER_PRINCIPAL = 8

const inFlight = new Map<string, number>()

export async function withInFlightLimit<T>(
  principal: string,
  fn: () => Promise<T>,
  limit = MAX_IN_FLIGHT_PER_PRINCIPAL,
): Promise<T> {
  const current = inFlight.get(principal) ?? 0
  if (current >= limit) {
    throw new McpToolError(
      "too_many_requests",
      `More than ${limit} ctxpipe calls run at the same time for this connection. Wait for a result, then send the call again.`,
    )
  }
  inFlight.set(principal, current + 1)
  try {
    return await fn()
  } finally {
    const left = (inFlight.get(principal) ?? 1) - 1
    if (left <= 0) inFlight.delete(principal)
    else inFlight.set(principal, left)
  }
}
