/** Hard cap on the text of one tool result (ADR-051 §5). */
export const HARD_CAP_CHARS = 24_000

/** About four characters for each token: cheap, and close for English and code. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * One page of `items` from `offset`, at most `limit` items and about
 * `maxTokens` tokens. A page always has one item when one remains, so a
 * cursor walk makes progress; the tool cuts that item if it is too large.
 */
export function pageWithinBudget<T>(
  items: readonly T[],
  options: {
    offset?: number
    limit: number
    maxTokens: number
    measure: (item: T) => string
  },
): { page: T[]; nextOffset: number | null; truncated: boolean } {
  const start = options.offset ?? 0
  const page: T[] = []
  let used = 0
  let truncated = false
  for (let index = start; index < items.length; index += 1) {
    if (page.length >= options.limit) break
    const item = items[index] as T
    const cost = estimateTokens(options.measure(item))
    if (page.length > 0 && used + cost > options.maxTokens) {
      truncated = true
      break
    }
    page.push(item)
    used += cost
  }
  const next = start + page.length
  return {
    page,
    nextOffset: next < items.length ? next : null,
    truncated,
  }
}

/** Cut `text` to at most `maxChars` characters, with a marker when cut. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}
