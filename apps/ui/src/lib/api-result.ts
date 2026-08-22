export type ApiErrorBody = {
  error?: string
  message?: string
  code?: string
  why?: string
}

export class ApiError extends Error {
  readonly status: number
  readonly body: ApiErrorBody

  constructor(
    message: string,
    status: number,
    options?: { cause?: unknown; body?: ApiErrorBody },
  ) {
    super(message, options)
    this.name = "ApiError"
    this.status = status
    this.body = options?.body ?? {}
  }
}

export const API_FETCH_TIMEOUT_SSR_MS = 10_000
export const API_FETCH_TIMEOUT_BROWSER_MS = 30_000

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
  init?: RequestInit,
): Promise<Response> {
  const signal = mergeSignals(init?.signal, defaultTimeoutMs())
  try {
    return await fetch(input, { ...init, signal })
  } catch (error) {
    throw new ApiError(
      error instanceof Error ? error.message : "Network request failed",
      0,
      { cause: error },
    )
  }
}

export async function readApiJson<T>(
  res: Response,
  opts?: { emptyOn?: number[]; empty?: T; message?: string },
): Promise<T> {
  if (opts?.emptyOn?.includes(res.status)) {
    return opts.empty as T
  }
  if (res.ok) {
    if (res.status === 204) return undefined as T
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }
  const body = (await res.json().catch(() => ({}))) as ApiErrorBody
  throw new ApiError(
    body.error ??
      body.message ??
      opts?.message ??
      `Request failed (${res.status})`,
    res.status,
    { body },
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
