import type { z } from "zod"

import { McpToolError } from "../../mcp/framework/tool-errors.js"
import type { getRelatedInputShape } from "../../mcp/tools/get-related.js"
import type { StatusRule } from "../../retrieval/jev/disagreement.js"

/*
 * The result types of `get_related` (ADR-051 section 6). The knowledge plane
 * ranks the results (`plane-reader.ts`).
 */

/** The arguments of `get_related`, after the tool parsed them. */
export type RelatedInput = z.infer<z.ZodObject<typeof getRelatedInputShape>>

/** One result of `get_related`, with its best path from a seed. */
export type RelatedResult = {
  ref: string
  title: string | null
  kind: string | null
  source: string
  updatedAt: string
  summary?: string
  score: number
  depth: number
  path?: { from: string; to: string; predicate: string; weight: number }[]
}

/**
 * One position of the disagreement step (ADR-068 decision 4): the results
 * that agree, the status of their claim, the reason of the status, and the
 * positions (by index) that it contradicts or updates. Only the knowledge
 * plane gives positions.
 */
export type RelatedPosition = {
  refs: string[]
  status: "current" | "superseded" | "disputed" | "scoped"
  /** The rule of the disagreement step that gave the status. */
  reason: { by: "tie-break"; rule: StatusRule }
  against: { position: number; label: "contradicts" | "updates" }[]
}

/** The ranking of one call, before paging. */
export type Ranking = {
  results: RelatedResult[]
  positions?: RelatedPosition[]
  explored: { nodes: number; edges: number }
  partial: boolean
  partialReason?: string
  cappedHubs: string[]
}

/** Results that one ranking keeps. A page takes at most 50 of them. */
export const RANKED_LIMIT = 100

/** A score or a weight of a result. */
export function round(value: number): number {
  return Number(value.toPrecision(3))
}

/** The error for seed refs that name no knowledge unit. */
export function unknownRefError(unknown: readonly string[]): McpToolError {
  return new McpToolError(
    "unknown_ref",
    `No knowledge unit for: ${unknown.join(", ")}. Use paths from search_knowledge or an earlier result.`,
  )
}
