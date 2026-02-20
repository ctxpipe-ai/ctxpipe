import { encode } from "@toon-format/toon"
import { z } from "zod/v3"

export const repositoryIdSchema = z
  .string()
  .regex(/^repo_[A-Z2-7]+$/)
  .describe("Repository id with prefix repo_")

export function codesearchBaseUrl(): string {
  return process.env.CODESEARCH_URL?.replace(/\/$/, "") ?? "http://codesearch-bun:3001"
}

export function toToon(data: unknown): string {
  return encode(data)
}
