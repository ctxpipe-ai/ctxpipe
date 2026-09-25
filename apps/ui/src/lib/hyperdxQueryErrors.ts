import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query"
import { recordHyperDxException } from "@/lib/hyperdxBrowser"

let exceptionRecordingEnabled = false

type DeferredQueryError = {
  error: unknown
  attributes: Record<string, string>
  recordedAt: number
}

let sessionIdentity: "pending" | "signed-in" | "signed-out" = "pending"
const deferredQueryErrors: DeferredQueryError[] = []
let deferredFlushTimer: ReturnType<typeof setTimeout> | undefined
const queuedBoundaryErrors: unknown[] = []
let sdkReady = false
const ORG_HOLD_MS = 10_000
const MAX_DEFER_MS = 20_000

/** Browser RUM is off until the root loader's server config says it is on. */
export function setHyperDxExceptionRecordingEnabled(enabled: boolean): void {
  exceptionRecordingEnabled = enabled
}

/**
 * Session globals are applied in `setHyperDxGlobalAttributes` /
 * `clearHyperDxGlobalAttributes`. Buffered failures flush at that moment.
 */
export function noteHyperDxSessionIdentity(
  identity: "signed-in" | "signed-out",
  detail?: { teamId?: string; activeOrganizationId?: string },
): void {
  if (identity === "signed-out") {
    sessionIdentity = "signed-out"
    flushDeferredQueryErrors()
    return
  }
  const teamId = detail?.teamId ?? ""
  const activeOrganizationId = detail?.activeOrganizationId ?? ""
  if (!teamId && activeOrganizationId) {
    sessionIdentity = "pending"
    scheduleDeferredFlush(ORG_HOLD_MS)
    return
  }
  sessionIdentity = "signed-in"
  flushDeferredQueryErrors()
}

/** Records after HyperDX.init. Errors that arrive first are queued. */
export function recordHyperDxBoundaryError(error: unknown): void {
  if (sdkReady && exceptionRecordingEnabled) {
    recordHyperDxException(error)
    return
  }
  if (queuedBoundaryErrors.length === 20) queuedBoundaryErrors.shift()
  queuedBoundaryErrors.push(error)
}

export function markHyperDxSdkReady(): void {
  sdkReady = true
  if (!exceptionRecordingEnabled) {
    queuedBoundaryErrors.length = 0
    return
  }
  const pending = queuedBoundaryErrors.splice(0, queuedBoundaryErrors.length)
  for (const error of pending) recordHyperDxException(error)
}

/** Page hide should not drop failures that are still waiting on the session. */
export function flushHyperDxDeferredExceptions(): void {
  flushDeferredQueryErrors()
}

/** Test isolation. Production session changes go through `noteHyperDxSessionIdentity`. */
export function resetHyperDxDeferredQueryErrorsForTests(): void {
  sessionIdentity = "pending"
  deferredQueryErrors.length = 0
  queuedBoundaryErrors.length = 0
  sdkReady = false
  if (deferredFlushTimer !== undefined) {
    clearTimeout(deferredFlushTimer)
    deferredFlushTimer = undefined
  }
}

function scheduleDeferredFlush(delayMs: number): void {
  if (deferredFlushTimer !== undefined) {
    clearTimeout(deferredFlushTimer)
    deferredFlushTimer = undefined
  }
  const oldest = deferredQueryErrors[0]?.recordedAt ?? Date.now()
  const remaining = Math.max(0, oldest + MAX_DEFER_MS - Date.now())
  const wait = Math.min(delayMs, remaining)
  if (wait === 0) {
    flushDeferredQueryErrors()
    return
  }
  deferredFlushTimer = setTimeout(() => {
    deferredFlushTimer = undefined
    flushDeferredQueryErrors()
  }, wait)
}

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

export function hyperDxHttpStatus(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const direct =
    Reflect.get(error, "status") ?? Reflect.get(error, "statusCode")
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

function queryErrorAttributes(input: {
  source: "query" | "mutation"
  error: unknown
  key: readonly unknown[] | undefined
}): Record<string, string> {
  const attributes: Record<string, string> = {
    "ctxpipe.ui.source": input.source,
  }
  const keyName = hyperDxQueryKeyName(input.key)
  if (keyName) attributes["ctxpipe.ui.key"] = keyName
  const status = hyperDxHttpStatus(input.error)
  if (status) attributes["ctxpipe.ui.http_status"] = status
  return attributes
}

function flushDeferredQueryErrors(): void {
  if (deferredFlushTimer !== undefined) {
    clearTimeout(deferredFlushTimer)
    deferredFlushTimer = undefined
  }
  const pending = deferredQueryErrors.splice(0, deferredQueryErrors.length)
  const flushedAt = Date.now()
  for (const item of pending) {
    recordHyperDxException(item.error, {
      ...item.attributes,
      "ctxpipe.ui.deferred_ms": String(flushedAt - item.recordedAt),
    })
  }
}

export function recordHyperDxQueryError(input: {
  source: "query" | "mutation"
  error: unknown
  key: readonly unknown[] | undefined
}): void {
  if (!exceptionRecordingEnabled) return
  if (isHyperDxAbortError(input.error)) return
  const attributes = queryErrorAttributes(input)
  if (sessionIdentity !== "pending") {
    recordHyperDxException(input.error, attributes)
    return
  }
  if (deferredQueryErrors.length === 20) deferredQueryErrors.shift()
  deferredQueryErrors.push({
    error: input.error,
    attributes,
    recordedAt: Date.now(),
  })
  if (deferredFlushTimer !== undefined) return
  scheduleDeferredFlush(10_000)
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
