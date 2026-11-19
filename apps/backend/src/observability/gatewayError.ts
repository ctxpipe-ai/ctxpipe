import { z } from "zod"

/**
 * The complete routing messages of OpenRouter that an error may keep. The
 * gateway writes them before the request reaches a provider. They name only
 * the routing settings, never the input. A message must match one template
 * from start to end, so a message with more text (that can echo the input)
 * does not match. "No endpoints found for MODEL." is kept only with the model
 * of the request (see `gatewayRoutingError`).
 */
const ROUTING_MESSAGES = [
  /^No endpoints found that can handle the requested parameters\.$/,
  /^No endpoints (found|available) matching your (guardrail restrictions and )?data policy( \((Zero data retention|Free model publication|Paid model training)\))?\.?( Configure: https:\/\/openrouter\.ai\/settings\/privacy)?$/,
  /^No allowed providers are available for the selected model\.$/,
]

const errorBody = z.object({ error: z.object({ message: z.string() }) })

/**
 * The routing message of a failed gateway answer to a request for `model`,
 * when it is one of `ROUTING_MESSAGES` or "No endpoints found for `model`.".
 * An error and a span can keep it. Any other error text can echo the input
 * (customer content), so the result is then undefined.
 */
export function gatewayRoutingError(
  body: string,
  model: string,
): string | undefined {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return undefined
  }
  const message = errorBody.safeParse(json).data?.error.message
  return message &&
    (message === `No endpoints found for ${model}.` ||
      ROUTING_MESSAGES.some((template) => template.test(message)))
    ? message
    : undefined
}
