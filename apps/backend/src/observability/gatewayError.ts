import { z } from "zod"

/**
 * The complete routing messages of OpenRouter that an error may keep. The
 * gateway writes them before the request reaches a provider. They name only a
 * model id and the routing settings, never the input. A message must match one
 * template from start to end, so a message with more text (that can echo the
 * input) does not match.
 */
const ROUTING_MESSAGES = [
  /^No endpoints found for [a-z0-9~][\w.:-]*\/[\w.:-]+\.$/,
  /^No endpoints found that can handle the requested parameters\.$/,
  /^No endpoints (found|available) matching your (guardrail restrictions and )?data policy( \((Zero data retention|Free model publication|Paid model training)\))?\.?( Configure: https:\/\/openrouter\.ai\/settings\/privacy)?$/,
  /^No allowed providers are available for the selected model\.$/,
]

const errorBody = z.object({ error: z.object({ message: z.string() }) })

/**
 * The routing message of a failed gateway answer, when it matches one of
 * `ROUTING_MESSAGES`. An error and a span can keep it. Any other error text
 * can echo the input (customer content), so the result is then undefined.
 */
export function gatewayRoutingError(body: string): string | undefined {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return undefined
  }
  const message = errorBody.safeParse(json).data?.error.message
  return message && ROUTING_MESSAGES.some((template) => template.test(message))
    ? message
    : undefined
}
