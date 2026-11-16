import { FetchHttpHandler } from "@smithy/fetch-http-handler"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * A provider failure with its class (`billing.error` of `billing.provider_status`): a short word, never a response
 * body, a token, an id or a message text. The message stays in the process only.
 */
export class ProviderError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message)
  }
}

/** The class of a provider failure: ProviderError's kind, a timeout, the HTTP status of an AWS SDK error, else `error`. */
export function errorClass(err: unknown): string {
  if (err instanceof ProviderError) return err.kind
  if (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  )
    return "timeout"
  const status =
    isRecord(err) && isRecord(err.$metadata)
      ? err.$metadata.httpStatusCode
      : undefined
  if (typeof status === "number") return httpClass(status)
  return "error"
}

export function httpClass(status: number): string {
  return status >= 500 ? "http_5xx" : `http_${status}`
}

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new ProviderError("missing_env", `${name} is required`)
  return value
}

export async function getJson(
  url: string,
  init: RequestInit,
  label: string,
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok)
    throw new ProviderError(
      httpClass(response.status),
      `${label} HTTP ${response.status}: ${text.slice(0, 500)}`,
    )
  try {
    const body: unknown = JSON.parse(text)
    return body
  } catch {
    throw new ProviderError(
      "parse",
      `${label} HTTP ${response.status}: ${text.slice(0, 500)}`,
    )
  }
}

/** Throws the messages of a GraphQL `errors` array, if the body has one. */
export function throwGraphqlErrors(
  body: Record<string, unknown>,
  label: string,
): void {
  if (!Array.isArray(body.errors) || body.errors.length === 0) return
  const messages = body.errors.flatMap((error) =>
    isRecord(error) && typeof error.message === "string" ? [error.message] : [],
  )
  throw new ProviderError(
    "graphql",
    messages.join("; ") || `${label} response had errors`,
  )
}

/**
 * The HTTP handler of the AWS SDK clients: the official FetchHttpHandler (not Node HTTPS), so Bun and MSW see each
 * call. customFetch buffers the body first: an MSW/Bun ReadableStream is empty by the time the SDK streamCollector runs.
 */
export function fetchHandler(): FetchHttpHandler {
  return new FetchHttpHandler({
    requestTimeout: 30_000,
    customFetch: (async (input, init) => {
      const response = await fetch(input, init)
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }) as typeof fetch,
  })
}
