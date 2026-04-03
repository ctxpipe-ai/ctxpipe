import { encode } from "@toon-format/toon"
import { z } from "zod/v3"

export const repositoryIdSchema = z
  .preprocess(
    (value) => (typeof value === "string" ? value.toLowerCase() : value),
    z
      .string()
      .length(31)
      .regex(/^repo_[a-z2-7]+$/),
  )
  .describe("Repository id with prefix repo_")

export function codesearchBaseUrl(): string {
  return (
    process.env.CODESEARCH_URL?.replace(/\/$/, "") ?? "http://codesearch:3001"
  )
}

/**
 * Hard cap on serialized TOON length returned from a single tool call.
 * Prevents pathological Zoekt/API payloads from flooding the model context.
 * (Valid TOON may be truncated; the suffix is plain text for the model.)
 */
const MAX_TOOL_TOON_CHARS = 400_000

export function toToon(data: unknown): string {
  const s = encode(data)
  if (s.length <= MAX_TOOL_TOON_CHARS) return s
  return `${s.slice(0, MAX_TOOL_TOON_CHARS)}\n\n[truncated: tool output exceeded ${MAX_TOOL_TOON_CHARS} chars]`
}
