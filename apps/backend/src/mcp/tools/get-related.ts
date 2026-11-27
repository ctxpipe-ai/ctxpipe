import { createHash } from "node:crypto"

import { z } from "zod"

import { RELEVANCE_INTENTS } from "../../domain/workspaces/graph-relevance.js"
import type { Ranking } from "../../domain/workspaces/related-ranking.js"
import { servedKnowledgeHead } from "../../knowledge-reader/knowledge-reader.js"
import { planeKnowledgeReader } from "../../knowledge-reader/plane-reader.js"
import { knowledgeViewKey } from "../../models/knowledge-state.js"
import { STATUS_RULES } from "../../retrieval/jev/disagreement.js"
import { fitPage } from "../framework/budget.js"
import {
  requireServed,
  resolveCallWorkspace,
} from "../framework/call-workspace.js"
import { decodeCursorWithAnchor, encodeCursor } from "../framework/cursor.js"
import {
  knowledgeNoticesSchema,
  legacyKnowledgeNotices,
  withNotices,
} from "../framework/legacy-knowledge.js"
import {
  branchArgument,
  servedSchema,
  workspaceArgument,
} from "../framework/schemas.js"
import { McpToolError } from "../framework/tool-errors.js"
import { defineMcpReadTool, scoredResult } from "../framework/tool-registry.js"

const instant = z.iso.datetime({ offset: true })
const name = z.string().min(1).max(64)

/** The arguments of `get_related`, with their bounds (ADR-051 §6). */
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
      "Relations that one document expands, 5 to 200: the most confident relations first. Default 50.",
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
    "Use it after search_knowledge to find owners, dependencies, decisions, incidents and changes. Finds knowledge related to seed refs AND relevant to your query: a walk of the relations of the seeds, ranked by how well each result answers the question. The ranking does not use age. Set intent (why, ownership, change, dependencies, structure, provenance) or give the question as query. Each intent walks its own edges first and puts its answer kinds first; with few results, a second walk follows all edges. No walk of all edges follows FROM_SOURCE; the provenance intent walks it, to find the sources a unit came from. Each result can explain why: the path of predicates from a seed. With positions, the top results are grouped by the claim they make, each with a status (current, superseded, disputed, scoped) and the positions it contradicts or updates: prefer a current position. Without positions, compare the updatedAt of the results and read the newest source. Filter by predicates, kinds, direction, depth and time. For plain neighbors, set maxDepth 1 and no query. Send independent calls in parallel.",
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
    notices: knowledgeNoticesSchema,
  }),
  describeResult: ({ results }) => scoredResult(results),
  async run(input, { org }) {
    if (input.validAt && input.validBetween) {
      throw new McpToolError(
        "invalid_argument",
        "Give validAt or validBetween, not both.",
      )
    }
    const workspace = await resolveCallWorkspace(org, input.workspace)
    const published = requireServed(workspace)
    const head = await servedKnowledgeHead(org.id, workspace.id, input.branch)
    const reader = planeKnowledgeReader({
      heads: new Map([[workspace.id, head]]),
    })
    // The plane serves the SHA of its last full run of the branch.
    const served = {
      branch: input.branch ?? published.branch,
      sha: head.sha,
    }
    const viewKey = knowledgeViewKey(head)
    // The main-era knowledge that the plane does not rank (CTX-1715).
    const notices = legacyKnowledgeNotices([workspace])
    const { cursor, ...parameters } = input
    const { limit, maxTokens, explain, ...rankParameters } = parameters
    const binding = {
      orgId: org.id,
      workspaceId: workspace.id,
      scope: JSON.stringify(["get_related", parameters]),
      sha: viewKey,
    }
    const decoded = cursor ? decodeCursorWithAnchor(cursor, binding) : null
    const offset = decoded?.offset ?? 0
    // A page after the first ranks as of the time of the first page.
    const now = decoded?.anchor ?? Date.now()
    const key = createHash("sha256")
      .update(
        JSON.stringify([org.id, workspace.id, viewKey, rankParameters, now]),
      )
      .digest("hex")
    let ranking = cachedRanking(key)
    if (!ranking) {
      try {
        ranking = await reader.related({
          org,
          workspace,
          input,
          now: new Date(now),
        })
      } catch (error) {
        // A seed can be a main-era unit that the plane does not hold.
        throw error instanceof McpToolError && error.code === "unknown_ref"
          ? withNotices(error, notices)
          : error
      }
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
      ...(notices.length ? { notices } : {}),
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
