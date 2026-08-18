/** User-visible copy when an indexer child or the task is OOM-killed. */
export const CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY =
  "Codebase didn't fit available memory"

const MEMORY_FIT_MESSAGE_RE =
  /exit code 137\b|\bENOMEM\b|codebase didn't fit available memory/i

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
    if (errorCode(item) === "ENOMEM") return true
  }
  return false
}

export function userFacingIndexingError(
  error: unknown,
  fallback = "Indexing failed",
): string {
  if (isMemoryFitFailure(error)) return CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  if (typeof error === "string" && error.trim()) return error.trim()
  return fallback
}

export function errorFromIndexerExit(params: {
  exitCode: number
  stderr: string
  stdout: string
  headline: string
}): Error {
  if (params.exitCode === 137) {
    return new Error(CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY)
  }
  return new Error(
    [
      params.headline,
      params.stderr.trim() ? `stderr: ${params.stderr.trim()}` : "",
      params.stdout.trim() ? `stdout: ${params.stdout.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  )
}
