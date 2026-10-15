import HyperDX from "@hyperdx/browser"
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query"
import { retryQuery } from "./api-result"

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

/**
 * A state the product expects: a 409 while a sandbox starts or a turn runs,
 * and a 404 on the turn changes of a new conversation that has no turns yet.
 */
function isExpectedState(error: unknown, keyName: string | undefined): boolean {
  if (!error || typeof error !== "object") return false
  const status = httpStatus(error)
  if (status === "409") return true
  return status === "404" && keyName === "conversation-turn-changes"
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
    const requestId = (error as { requestId?: unknown }).requestId
    if (typeof requestId === "string" && requestId) {
      attributes["request.id"] = requestId
    }
  }
  // An expected state is an action, not an Error span.
  if (isExpectedState(error, keyName)) {
    HyperDX.addAction("ui_expected_state", attributes)
    return
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
        retry: retryQuery,
      },
    },
  })
}
