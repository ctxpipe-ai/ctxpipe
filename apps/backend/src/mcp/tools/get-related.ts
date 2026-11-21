import { createHash } from "node:crypto"

import { z } from "zod"

import { RELEVANCE_INTENTS } from "../../domain/workspaces/graph-relevance.js"
import type { Ranking } from "../../domain/workspaces/related-ranking.js"
import { selectKnowledgeReader } from "../../knowledge-reader/knowledge-reader.js"
import { knowledgeViewKey } from "../../models/knowledge-state.js"
import { STATUS_RULES } from "../../retrieval/jev/disagreement.js"
import { fitPage } from "../framework/budget.js"
import {
  requireServed,
  resolveCallWorkspace,
} from "../framework/call-workspace.js"
import { decodeCursorWithAnchor, encodeCursor } from "../framework/cursor.js"
import {
  branchArgument,
  servedSchema,
  workspaceArgument,
} from "../framework/schemas.js"
import { McpToolError } from "../framework/tool-errors.js"
import { defineMcpReadTool } from "../framework/tool-registry.js"

export { rankWorkspaceRelated } from "../../domain/workspaces/related-ranking.js"

const instant = z.iso.datetime({ offset: true })
const name = z.string().min(1).max(64)

/**
 * The arguments of `get_related`. Each bound is the bound that `rankRelated`
 * and `expandWorkspaceGraph` check, so a call that passes here never makes
 * either function throw (ADR-051 §6).
 */
export const getRelatedInputShape = {
  workspace: workspaceArgument,
  branch: branchArgument,
  seeds: z
    .array(z.string().min(1).max(1_024))
    .min(1)
    .max(10)
    .describe("Start units: paths from search_knowledge or an earlier result."),
  query: z
    .string()
    .trim()
    .min(1)
    .max(4_000)
    .optional()
    .describe(
      "What you look for. It biases the ranking toward matching units.",
    ),
  intent: z
    .enum(RELEVANCE_INTENTS)
    .default("general")
    .describe(
      "The kind of question: why (decisions), ownership, change (recent changes), dependencies, structure, provenance (the sources that a unit came from), or general. Set it, or give the question as query: with neither, one page must serve every kind of question.",
    ),
  predicates: z
    .array(name)
    .min(1)
    .max(50)
    .optional()
    .describe(
      "Walk only edges with these predicates. Not case-sensitive. Default: the edges of the intent and the link edges, then all edges only with fewer than limit results or no answer kind (all edges for general). Only provenance or these predicates walk FROM_SOURCE.",
    ),
  excludePredicates: z
    .array(name)
    .min(1)
    .max(50)
    .optional()
    .describe(
      "Never walk edges with these predicates. Not case-sensitive. Applies to every walk.",
    ),
  predicateWeights: z
    .record(name, z.number().min(0))
    .refine((weights) => Object.keys(weights).length <= 50, {
      message: "At most 50 predicate weights.",
    })
    .optional()
    .describe("Replaces the weight of single predicates. 0 removes the edges."),
  kinds: z
    .array(name)
    .max(50)
    .optional()
    .describe(
      "Only results of these kinds. The walk still passes through other kinds.",
    ),
  excludeKinds: z
    .array(name)
    .max(50)
    .optional()
    .describe("No results of these kinds. The walk still passes through them."),
  direction: z
    .enum(["out", "in", "both"])
    .default("both")
    .describe("Edge direction from the seeds. Default both."),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(4)
    .default(2)
    .describe("Hops from a seed. Default 2."),
  maxFanOut: z
    .number()
    .int()
    .min(5)
    .max(200)
    .default(50)
    .describe(
      "Edges that one unit expands, 5 to 200: the strongest edge of each predicate first, then the next of each. Default 50.",
    ),
  minConfidence: z
    .number()
    .min(0)
    .max(1)
    .default(0.2)
    .describe("Stored confidence below which an edge is not walked."),
  validAt: instant
    .optional()
    .describe("Only edges valid at this time (ISO 8601). Default now."),
  validBetween: z
    .object({ from: instant, to: instant })
    .refine((window) => Date.parse(window.from) <= Date.parse(window.to), {
      message: "validBetween must end after it starts.",
    })
    .optional()
    .describe(
      "Instead of validAt: edges valid at some time in this window, ended edges included.",
    ),
  recencyHalfLifeDays: z
    .number()
    .positive()
    .optional()
    .describe("Half-life of a change edge in days. Default 90."),
  restart: z
    .number()
    .gt(0)
    .lt(1)
    .optional()
    .describe(
      "Restart probability of the walk, above 0 and below 1. Higher stays closer to the seeds. Default 0.15.",
    ),
  queryWeight: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Share of the query against graph proximity. Default 0.5."),
  hubPenalty: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Exponent of the hub penalty degree^-x, 0 to 1. The intent sets the default.",
    ),
  diversity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "0 ranks by score only; higher spreads results over kinds and neighbors. Default 0.5 for general, else 0.3.",
    ),
  maxPerKind: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("At most this many results of one kind."),
  explain: z
    .boolean()
    .default(true)
    .describe("Give the best path from a seed for each result."),
  includeSeeds: z
    .boolean()
    .default(false)
    .describe("Return the seeds as results too."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Results in one page. Default 10."),
  cursor: z
    .string()
    .max(2_048)
    .optional()
    .describe("The cursor of the last result, for the next page."),
  maxTokens: z
    .number()
    .int()
    .min(500)
    .max(8_000)
    .default(3_000)
    .describe("Token budget of the page. Default 3000."),
}

const stepSchema = z.object({
  from: z.string(),
  to: z.string(),
  predicate: z.string(),
  weight: z.number(),
})

const resultSchema = z.object({
  ref: z.string(),
  title: z.string().nullable(),
  kind: z.string().nullable(),
  source: z.string(),
  updatedAt: z.string(),
  summary: z.string().optional(),
  score: z.number(),
  queryMatch: z.number().optional(),
  depth: z.number().int(),
  path: z.array(stepSchema).optional(),
})
type RelatedResult = z.infer<typeof resultSchema>

const positionSchema = z.object({
  refs: z.array(z.string()).describe("The results that make one claim."),
  status: z
    .enum(["current", "superseded", "disputed", "scoped"])
    .describe(
      "current: true now. superseded: replaced, or not valid now. disputed: contradicted, and no side wins. scoped: true only for a part of the question.",
    ),
  reason: z
    .object({ by: z.literal("tie-break"), rule: z.enum(STATUS_RULES) })
    .describe("The rule of the disagreement step that gave the status."),
  against: z
    .array(
      z.object({
        position: z.number().int(),
        label: z.enum(["contradicts", "updates"]),
      }),
    )
    .describe(
      "The positions (index in positions) that this one contradicts or updates.",
    ),
})

/**
 * Rankings by revision, parameters and ranking time, so that page 2 needs no
 * graph query. An entry ends 10 minutes after it was set. A page after that
 * ranks again as of the time in its cursor and gives the same order.
 */
const rankings = new Map<string, { ranking: Ranking; expires: number }>()

function cachedRanking(key: string): Ranking | undefined {
  const entry = rankings.get(key)
  if (!entry) return undefined
  if (entry.expires > Date.now()) return entry.ranking
  rankings.delete(key)
  return undefined
}

function cacheRanking(key: string, ranking: Ranking): void {
  const now = Date.now()
  for (const [oldKey, entry] of rankings) {
    if (entry.expires <= now || rankings.size >= 200) rankings.delete(oldKey)
    else break
  }
  rankings.set(key, { ranking, expires: now + 10 * 60_000 })
}

/** Register this tool at the seven-tool cutover (ADR-051). */
export const getRelatedTool = defineMcpReadTool({
  name: "get_related",
  title: "Get related knowledge",
  description:
    "Use it after search_knowledge to find owners, dependencies, decisions, incidents and changes. Finds knowledge related to seed refs AND relevant to your query, ranked by graph proximity, edge confidence, recency and query match. Set intent (why, ownership, change, dependencies, structure, provenance) or give the question as query. Each intent walks its own edges first and puts its answer kinds first; with few results, a second walk follows all edges. No walk of all edges follows FROM_SOURCE; the provenance intent walks it, to find the sources a unit came from. Each result can explain why: the path of predicates from a seed. With positions, the top results are grouped by the claim they make, each with a status (current, superseded, disputed, scoped) and the positions it contradicts or updates: prefer a current position. Filter by predicates, kinds, direction, depth and time. For plain neighbors, set maxDepth 1 and no query. Send independent calls in parallel.",
  org: "required",
  inputShape: getRelatedInputShape,
  outputSchema: z.object({
    workspace: z.string(),
    served: servedSchema,
    explored: z.object({ nodes: z.number().int(), edges: z.number().int() }),
    partial: z.boolean(),
    partialReason: z.string().optional(),
    cappedHubs: z.array(z.string()).optional(),
    results: z.array(resultSchema),
    positions: z
      .array(positionSchema)
      .optional()
      .describe("The disagreement positions of the top results."),
    cursor: z.string().optional(),
    truncated: z.boolean().optional(),
  }),
  async run(input, { org }) {
    if (input.validAt && input.validBetween) {
      throw new McpToolError(
        "invalid_argument",
        "Give validAt or validBetween, not both.",
      )
    }
    const workspace = await resolveCallWorkspace(org, input.workspace)
    const legacyServed = requireServed(workspace)
    const { reader, planeHeads } = await selectKnowledgeReader(
      org.id,
      [workspace.id],
      input.branch,
    )
    // The plane serves the SHA of its last full run of the branch.
    const planeHead = planeHeads.get(workspace.id)
    const served = {
      branch: input.branch ?? legacyServed.branch,
      sha: planeHead?.sha ?? legacyServed.sha,
    }
    const viewKey = planeHead ? knowledgeViewKey(planeHead) : served.sha
    const { cursor, ...parameters } = input
    const { limit, maxTokens, explain, ...rankParameters } = parameters
    const binding = {
      orgId: org.id,
      workspaceId: workspace.id,
      scope: JSON.stringify(["get_related", parameters]),
      sha: viewKey,
      stack: reader.stack,
    }
    const decoded = cursor ? decodeCursorWithAnchor(cursor, binding) : null
    const offset = decoded?.offset ?? 0
    // A page after the first ranks as of the time of the first page.
    const now = decoded?.anchor ?? Date.now()
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          reader.stack,
          org.id,
          workspace.id,
          viewKey,
          rankParameters,
          now,
        ]),
      )
      .digest("hex")
    let ranking = cachedRanking(key)
    if (!ranking) {
      ranking = await reader.related({
        org,
        workspace,
        sha: served.sha,
        input,
        now: new Date(now),
      })
      cacheRanking(key, ranking)
    }
    const { results, ...header } = ranking
    const items: RelatedResult[] = explain
      ? results
      : results.map(({ path: _path, ...rest }) => rest)
    const build = (page: RelatedResult[]) => ({
      workspace: workspace.slug,
      served,
      explored: header.explored,
      partial: header.partial,
      ...(header.partialReason ? { partialReason: header.partialReason } : {}),
      ...(header.cappedHubs.length ? { cappedHubs: header.cappedHubs } : {}),
      results: page,
      ...(header.positions ? { positions: header.positions } : {}),
    })
    const { page, nextOffset, truncated } = fitPage(items, {
      offset,
      limit,
      maxTokens,
      result: build,
    })
    return {
      ...build(page),
      ...(nextOffset === null
        ? {}
        : {
            cursor: encodeCursor({
              ...binding,
              offset: nextOffset,
              anchor: now,
            }),
          }),
      ...(truncated ? { truncated: true } : {}),
    }
  },
})
