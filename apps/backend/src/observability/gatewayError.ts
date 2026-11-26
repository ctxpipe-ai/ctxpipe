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
 * The kinds of an error text that the cause of a failed gateway answer can
 * name, in the order of the check. Each pattern also matches the snake_case
 * code of the same kind (for example `context_length_exceeded` in a raw
 * provider error). Only the label goes into the cause, never the text.
 */
const MESSAGE_KINDS: [string, RegExp][] = [
  [
    "context_length",
    /context[ _](length|window)|too[ _]many[ _]tokens|token[ _]limit|maximum .*tokens/i,
  ],
  ["too_large", /too[ _]large|payload|request[ _]entity/i],
  ["invalid_json", /(\b|_)json(\b|_)/i],
  [
    "invalid_request",
    /invalid|validation|required|expected|unrecognized|not[ _]allowed|must /i,
  ],
]

const text = z.string().optional().catch(undefined)
const causeBody = z.object({
  error: z.object({
    message: text,
    metadata: z
      .object({
        provider_name: text,
        // The error body of the provider, as text or as JSON.
        raw: z
          .unknown()
          .transform((raw) =>
            typeof raw === "string" ? raw : JSON.stringify(raw),
          )
          .optional(),
      })
      .optional()
      .catch(undefined),
  }),
})

/**
 * The cause of a failed gateway answer, with no text of the answer: an error
 * body can quote the input (customer content). The cause is
 * `<source>.<kind>`:
 * - `source`: `provider` when the body names the provider that answered,
 *   else `gateway`. The cause keeps no name.
 * - `kind`: the first `MESSAGE_KINDS` label that the message matches, else
 *   the first that the raw error of the provider (`metadata.raw`) matches,
 *   else `unknown`. OpenRouter gives a generic message ("Provider returned
 *   error") when the provider refused, and puts the refusal in the raw
 *   error. A body that is not JSON gives `not_json`. No code of the body
 *   goes into the cause: a code can also hold content.
 */
export function gatewayErrorCause(body: string): string {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return "gateway.not_json"
  }
  const error = causeBody.safeParse(json).data?.error
  const source = error?.metadata?.provider_name ? "provider" : "gateway"
  const kindOf = (value: string | undefined) =>
    value === undefined
      ? undefined
      : MESSAGE_KINDS.find(([, pattern]) => pattern.test(value))?.[0]
  const kind = kindOf(error?.message) ?? kindOf(error?.metadata?.raw)
  return `${source}.${kind ?? "unknown"}`
}
