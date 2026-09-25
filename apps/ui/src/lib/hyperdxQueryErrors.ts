import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query"
import { recordHyperDxException } from "@/lib/hyperdxBrowser"

let exceptionRecordingEnabled = false

/** Browser RUM is off until the root loader's server config says it is on. */
export function setHyperDxExceptionRecordingEnabled(enabled: boolean): void {
  exceptionRecordingEnabled = enabled
}

const STATIC_KEY = /^[a-z][a-z0-9._:/-]{0,63}$/i
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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

export function hyperDxHttpStatus(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const direct = Reflect.get(error, "status") ?? Reflect.get(error, "statusCode")
  if (typeof direct === "number" && direct >= 100 && direct <= 599) {
    return String(direct)
  }
  const response = Reflect.get(error, "response")
  if (!response || typeof response !== "object") return undefined
  const nested = Reflect.get(response, "status")
  if (typeof nested === "number" && nested >= 100 && nested <= 599) {
    return String(nested)
  }
  return undefined
}

export function isHyperDxAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const name = Reflect.get(error, "name")
  return name === "AbortError" || name === "CancelledError"
}

export function recordHyperDxQueryError(input: {
  source: "query" | "mutation"
  error: unknown
  key: readonly unknown[] | undefined
}): void {
  if (!exceptionRecordingEnabled) return
  if (isHyperDxAbortError(input.error)) return
  const attributes: Record<string, string> = {
    "ctxpipe.ui.source": input.source,
  }
  const keyName = hyperDxQueryKeyName(input.key)
  if (keyName) attributes["ctxpipe.ui.key"] = keyName
  const status = hyperDxHttpStatus(input.error)
  if (status) attributes["ctxpipe.ui.http_status"] = status
  recordHyperDxException(input.error, attributes)
}

export function createHyperDxQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        recordHyperDxQueryError({
          source: "query",
          error,
          key: query.queryKey,
        })
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        recordHyperDxQueryError({
          source: "mutation",
          error,
          key: mutation.options.mutationKey,
        })
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 60_000,
      },
    },
  })
}
