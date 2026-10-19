import type { ClientResponse } from "hono/client"
import type { SuccessStatusCode } from "hono/utils/http-status"

type ApiErrorBody = {
  error?: string
  message?: string
  code?: string
  why?: string
  worktreeVersion?: string
}

export class ApiError extends Error {
  readonly status: number
  readonly body: ApiErrorBody
  /** The backend `x-request-id` of the failed response, when there was one. */
  readonly requestId: string | undefined

  constructor(
    message: string,
    status: number,
    options?: { cause?: unknown; body?: ApiErrorBody; requestId?: string },
  ) {
    super(message, options)
    this.name = "ApiError"
    this.status = status
    this.body = options?.body ?? {}
    this.requestId = options?.requestId
  }
}

export const API_FETCH_TIMEOUT_SSR_MS = 10_000
const API_FETCH_TIMEOUT_BROWSER_MS = 30_000

type ApiFetchInit = RequestInit & {
  /** `null` skips the default timeout (long-lived SSE). */
  timeoutMs?: number | null
}

function defaultTimeoutMs(): number {
  return import.meta.env.SSR
    ? API_FETCH_TIMEOUT_SSR_MS
    : API_FETCH_TIMEOUT_BROWSER_MS
}

function mergeSignals(
  caller: AbortSignal | null | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!caller) return timeout
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([caller, timeout])
  }
  return timeout
}

/** Product fetch: committed timeout, network/abort → ApiError status 0. */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: ApiFetchInit,
): Promise<Response> {
  const { timeoutMs, ...fetchInit } = init ?? {}
  const signal =
    timeoutMs === null
      ? fetchInit.signal
      : mergeSignals(fetchInit.signal, timeoutMs ?? defaultTimeoutMs())
  try {
    return await fetch(input, { ...fetchInit, signal })
  } catch (error) {
    throw new ApiError(
      error instanceof Error ? error.message : "Network request failed",
      0,
      { cause: error },
    )
  }
}

/** The JSON body types of the success responses (2xx) of a Hono client call. */
type ApiOkJson<R> =
  R extends ClientResponse<
    infer T,
    infer S extends number,
    // biome-ignore lint/suspicious/noExplicitAny: the response format does not matter here
    any
  >
    ? number extends S
      ? unknown // a plain `Response`: narrow the body where you use it
      : S extends SuccessStatusCode
        ? T
        : never
    : never

/**
 * Read the JSON body of a Hono client response. The type comes from the route,
 * so a changed backend response fails to compile here.
 */
export async function readApiJson<
  // biome-ignore lint/suspicious/noExplicitAny: any ClientResponse
  R extends ClientResponse<any, any, any> | Response,
  E = never,
>(
  res: R,
  opts?: { emptyOn?: number[]; empty?: E; message?: string },
): Promise<ApiOkJson<R> | E> {
  return readJson(res as Response, opts) as Promise<ApiOkJson<R> | E>
}

async function readJson(
  res: Response,
  opts?: { emptyOn?: number[]; empty?: unknown; message?: string },
): Promise<unknown> {
  if (opts?.emptyOn?.includes(res.status)) {
    return opts.empty
  }
  if (res.ok) {
    if (res.status === 204) return undefined
    const text = await res.text()
    if (!text) return undefined
    return JSON.parse(text)
  }
  const body = (await res.json().catch(() => ({}))) as ApiErrorBody
  throw new ApiError(
    body.error ??
      body.message ??
      opts?.message ??
      `Request failed (${res.status})`,
    res.status,
    { body, requestId: res.headers.get("x-request-id") ?? undefined },
  )
}

/** One retry for network/5xx only. Never retry 4xx. */
export function retryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false
  const status = error instanceof ApiError ? error.status : 0
  return status === 0 || status >= 500
}

export function pollWhileOk(intervalMs: number) {
  return (query: { state: { status: string } }) =>
    query.state.status === "error" ? false : intervalMs
}
