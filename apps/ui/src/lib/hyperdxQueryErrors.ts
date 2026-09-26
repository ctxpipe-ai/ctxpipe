import HyperDX from "@hyperdx/browser"
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query"

/** First query/mutation key segment when it is a string. */
export function hyperDxQueryKeyName(
  key: readonly unknown[] | undefined,
): string | undefined {
  const first = key?.[0]
  return typeof first === "string" ? first : undefined
}

function httpStatus(error: object): string | undefined {
  const status = (error as { status?: unknown }).status
  if (typeof status === "number" && status >= 100 && status <= 599) {
    return String(status)
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
