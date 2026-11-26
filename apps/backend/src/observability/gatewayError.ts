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

/**
 * The kinds of an error message that the cause of a failed gateway answer
 * can name, in the order of the check. Only the label goes into the cause,
 * never the text of the message.
 */
const MESSAGE_KINDS: [string, RegExp][] = [
  [
    "context_length",
    /context (length|window)|too many tokens|token limit|maximum .*tokens/i,
  ],
  ["too_large", /too large|payload|request entity/i],
  ["invalid_json", /\bjson\b/i],
  [
    "invalid_request",
    /invalid|validation|required|expected|unrecognized|not allowed|must /i,
  ],
]

const causeBody = z.object({
  error: z.object({
    code: z.unknown().optional(),
    message: z.unknown().optional(),
    metadata: z.object({ provider_name: z.unknown().optional() }).optional(),
  }),
})

/**
 * The cause of a failed gateway answer, with no text of the answer: an error
 * body can quote the input (customer content). The cause is
 * `<source>.<kind>`:
 * - `source`: `provider` when the body names the provider that answered,
 *   else `gateway`. The cause keeps no name.
 * - `kind`: the error code of the body when it is a snake_case identifier,
 *   else the kind of the message (`MESSAGE_KINDS`), else `unknown`. A body
 *   that is not JSON gives `not_json`.
 */
export function gatewayErrorCause(body: string): string {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return "gateway.not_json"
  }
  const error = causeBody.safeParse(json).data?.error
  const provider = error?.metadata?.provider_name
  const source =
    typeof provider === "string" && provider ? "provider" : "gateway"
  const { code, message } = error ?? {}
  const kind =
    typeof code === "string" && /^[a-z][a-z0-9_]{0,47}$/.test(code)
      ? code
      : typeof message === "string"
        ? MESSAGE_KINDS.find(([, pattern]) => pattern.test(message))?.[0]
        : undefined
  return `${source}.${kind ?? "unknown"}`
}
