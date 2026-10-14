import { encode } from "@toon-format/toon"
import {
  estimateTokens,
  HARD_CAP_CHARS,
  truncateText,
} from "../framework/budget.js"
import type {
  CodeRepository,
  SkippedRepository,
} from "../framework/org-code.js"
import { formatRef } from "../framework/refs.js"
import { McpToolError } from "../framework/tool-errors.js"

/** Remove the private codesearch checkout prefix from a result path. */
export function codeFileRef(repository: CodeRepository, path: string): string {
  if (path.startsWith("/")) {
    const prefix = `/${repository.repositoryId}/checkouts/default/`
    const at = path.indexOf(prefix)
    if (at < 0)
      throw new Error("Codesearch returned a path outside the checkout")
    path = path.slice(at + prefix.length)
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

/** Bound the public result after refs and revision metadata have been added. */
export function boundCodeResults<T extends Record<string, unknown>>(
  answer: {
    results: T[]
    excluded: string[]
    skipped: SkippedRepository[]
    truncated: boolean
    hint?: string
  },
  maxTokens: number,
) {
  const result = {
    ...answer,
    results: answer.results.map((item) => {
      if (typeof item.snippet !== "string") return item
      const snippet = truncateText(item.snippet, 4000)
      if (snippet !== item.snippet) answer.truncated = true
      return { ...item, snippet }
    }),
  }
  result.truncated = answer.truncated
  while (true) {
    const text = encode(result)
    const chars = JSON.stringify({
      content: [{ type: "text", text }],
      structuredContent: result,
    }).length
    if (estimateTokens(text) <= maxTokens && chars <= HARD_CAP_CHARS)
      return result
    if (result.results.length === 0) {
      throw new McpToolError(
        "response_too_large",
        "The repository list is too large. Narrow the call with repositories or workspace.",
      )
    }
    result.results.pop()
    result.truncated = true
  }
}
