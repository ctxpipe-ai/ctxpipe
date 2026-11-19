/**
 * The routing message of a failed gateway answer, when it is one that
 * OpenRouter writes before the request reaches a provider: "No endpoints
 * found …" or "No allowed providers …". These messages name only the model
 * and the routing settings, never the input, so an error and a span can keep
 * them. Any other error text can echo the input (customer content), so the
 * result is then undefined.
 */
export function gatewayRoutingError(body: string): string | undefined {
  let message: unknown
  try {
    message = (JSON.parse(body) as { error?: { message?: unknown } }).error
      ?.message
  } catch {
    return undefined
  }
  return typeof message === "string" &&
    message.length <= 300 &&
    /^No (endpoints found|allowed providers)\b[^\n]*$/.test(message)
    ? message
    : undefined
}
