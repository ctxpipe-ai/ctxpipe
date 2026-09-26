import HyperDX from "@hyperdx/browser"
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query"

const STATIC_KEY = /^[a-z][a-z0-9._:/-]{0,63}$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_PREFIX = /^(?:conv|inv|user|org|con|tok|key|sk|pk)_/i

/**
 * First query/mutation key segment when it is a static name.
 * Drops ids, emails, tokens, and free text.
 */
export function hyperDxQueryKeyName(
  key: readonly unknown[] | undefined,
): string | undefined {
  const first = key?.[0]
  if (typeof first !== "string") return undefined
  if (!STATIC_KEY.test(first)) return undefined
  if (first.includes("@")) return undefined
  if (UUID.test(first) || ID_PREFIX.test(first)) return undefined
  return first
}

function httpStatus(error: object): string | undefined {
  const record = error as {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
  }
  const direct = record.status ?? record.statusCode
  if (typeof direct === "number" && direct >= 100 && direct <= 599) {
    return String(direct)
  }
  const nested = record.response?.status
  if (typeof nested === "number" && nested >= 100 && nested <= 599) {
    return String(nested)
  }
  return undefined
}

function isCancellation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const name = (error as { name?: unknown }).name
  return name === "AbortError" || name === "CancelledError"
}

function recordUiException(
  source: "query" | "mutation",
  error: unknown,
  key: readonly unknown[] | undefined,
): void {
  if (isCancellation(error)) return
  const attributes: Record<string, string> = { "ctxpipe.ui.source": source }
  const keyName = hyperDxQueryKeyName(key)
  if (keyName) attributes["ctxpipe.ui.key"] = keyName
  if (error && typeof error === "object") {
    const status = httpStatus(error)
    if (status) attributes["ctxpipe.ui.http_status"] = status
  }
  // Before init the SDK drops this. Recording without identity is acceptable.
  HyperDX.recordException(error, attributes)
}

export function createHyperDxQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        recordUiException("query", error, query.queryKey)
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        recordUiException("mutation", error, mutation.options.mutationKey)
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 60_000,
      },
    },
  })
}
