import { log } from "../../observability/logger.js"
import { fitPage } from "../framework/budget.js"
import { type CursorBinding, encodeCursor } from "../framework/cursor.js"
import type {
  CodeRepository,
  CodeResults,
  SkippedRepository,
} from "../framework/org-code.js"
import { formatRef } from "../framework/refs.js"

/**
 * Remove the private codesearch checkout prefix (`/<repoId>/checkouts/<key>/`,
 * for example `rev:<sha>`) from a result path.
 */
export function codeFileRef(repository: CodeRepository, path: string): string {
  if (path.startsWith("/")) {
    const marker = `/${repository.repositoryId}/checkouts/`
    const at = path.indexOf(marker)
    if (at < 0)
      throw new Error("Codesearch returned a path outside the checkout")
    const rest = path.slice(at + marker.length)
    const slash = rest.indexOf("/")
    if (slash <= 0)
      throw new Error("Codesearch returned a path outside the checkout")
    path = rest.slice(slash + 1)
  }
  if (
    !path ||
    path.split("/").some((part) => !part || part === ".." || part === ".git") ||
    path.includes("\0")
  ) {
    throw new Error("Codesearch returned an invalid file path")
  }
  return formatRef({ kind: "file", handle: repository.handle, path })
}

/**
 * Maps each item of a code answer. An item that does not map (a path outside
 * the checkout, an unknown shape) is dropped, and its repository is
 * `skipped` as `failed`; the call goes on. `indexes` are the positions of the
 * kept items in `items`.
 */
export function mapCodeItems<I extends { repository: string }, O>(
  items: readonly I[],
  map: (item: I) => O,
): { results: O[]; indexes: number[]; failed: SkippedRepository[] } {
  const results: O[] = []
  const indexes: number[] = []
  const failed = new Map<string, SkippedRepository>()
  items.forEach((item, index) => {
    try {
      results.push(map(item))
      indexes.push(index)
    } catch {
      // The error text can echo a path or a query. Keep it off the event.
      log.warn({ step: "mcp.code_results.item_dropped" })
      failed.set(item.repository, {
        repository: item.repository,
        reason: "failed",
      })
    }
  })
  return { results, indexes, failed: [...failed.values()] }
}

/**
 * The public result of a code tool: one page of the mapped items that fits
 * the budget (ADR-051 §5), with `excluded`, `skipped`, and a `cursor` for the
 * next page. `truncated` is true when more results exist, or when the budget
 * or a cut snippet shortened the page.
 */
export function pageCodeResults<T extends Record<string, unknown>>(input: {
  answer: Pick<
    CodeResults<unknown>,
    "excluded" | "skipped" | "truncated" | "nextOffset" | "hint"
  >
  mapped: { results: T[]; indexes: number[]; failed: SkippedRepository[] }
  offset: number
  binding: CursorBinding
  maxTokens: number
  cutSnippet?: boolean
}) {
  const { answer, mapped } = input
  const skipped = [...answer.skipped]
  for (const entry of mapped.failed) {
    if (
      !skipped.some(
        (known) =>
          known.repository === entry.repository &&
          known.reason === entry.reason,
      )
    ) {
      skipped.push(entry)
    }
  }
  const fixed = {
    excluded: answer.excluded,
    skipped,
    ...(answer.hint ? { hint: answer.hint } : {}),
  }
  const fit = fitPage(mapped.results, {
    limit: mapped.results.length,
    maxTokens: input.maxTokens,
    result: (page) => ({ results: page, ...fixed, truncated: true }),
  })
  const lastKept = mapped.indexes[fit.page.length - 1]
  const nextOffset =
    fit.nextOffset !== null && lastKept !== undefined
      ? input.offset + lastKept + 1
      : answer.nextOffset
  return {
    results: fit.page,
    ...fixed,
    truncated: answer.truncated || fit.truncated || input.cutSnippet === true,
    ...(nextOffset === null
      ? {}
      : { cursor: encodeCursor({ ...input.binding, offset: nextOffset }) }),
  }
}
