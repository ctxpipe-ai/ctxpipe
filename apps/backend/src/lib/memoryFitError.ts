/** User-visible copy when codesearch ingest hits a cgroup/OOM kill. */
export const CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY =
  "Codebase didn't fit available memory"

const MEMORY_FIT_MESSAGE_RE =
  /exit code 137\b|fetch failed|\bENOMEM\b|codebase didn't fit available memory/i

const MEMORY_FIT_ERRNOS = new Set(["ECONNRESET", "EPIPE", "ENOMEM"])

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === "string" ? code : undefined
}

function collectErrors(error: unknown): unknown[] {
  const out: unknown[] = []
  const queue: unknown[] = [error]
  const seen = new Set<unknown>()
  while (queue.length > 0) {
    const current = queue.shift()
    if (current == null || seen.has(current)) continue
    seen.add(current)
    out.push(current)
    if (current && typeof current === "object" && "cause" in current) {
      queue.push((current as { cause: unknown }).cause)
    }
  }
  return out
}

export function isMemoryFitFailure(error: unknown): boolean {
  for (const item of collectErrors(error)) {
    if (typeof item === "string" && MEMORY_FIT_MESSAGE_RE.test(item)) {
      return true
    }
    if (item instanceof Error && MEMORY_FIT_MESSAGE_RE.test(item.message)) {
      return true
    }
    const code = errorCode(item)
    if (code && MEMORY_FIT_ERRNOS.has(code)) return true
  }
  return false
}

export function userFacingIndexingError(
  error: unknown,
  fallback = "Repository ingestion failed",
): string {
  if (isMemoryFitFailure(error)) return CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  if (typeof error === "string" && error.trim()) return error.trim()
  return fallback
}

export function memoryFitLogFields(error: unknown): {
  errno?: string
  cause?: string
} {
  const fields: { errno?: string; cause?: string } = {}
  for (const item of collectErrors(error)) {
    const code = errorCode(item)
    if (code && fields.errno == null) fields.errno = code
    if (item instanceof Error && item !== error && fields.cause == null) {
      fields.cause = item.message
    }
  }
  return fields
}
