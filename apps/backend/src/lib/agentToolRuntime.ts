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
    process.env.CODESEARCH_URL?.replace(/\/$/, "") ??
    "http://codesearch:3001"
  )
}

export function toToon(data: unknown): string {
  return encode(data)
}
