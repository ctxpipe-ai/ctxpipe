import { createHash } from "node:crypto"
import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"
import { withOrgDbContext } from "../../db/client.js"
import {
  workspaceKnowledgeUnits,
  workspaces,
} from "../../db/schema/workspaces.js"
import { expandWorkspaceGraph } from "../../domain/workspaces/graph-expand.js"
import { WorkspaceGraphUnavailableError } from "../../domain/workspaces/graph-projection.js"
import { WorkspaceGraphBuildingError } from "../../domain/workspaces/graph-rebuild.js"
import {
  RELEVANCE_INTENTS,
  rankRelated,
} from "../../domain/workspaces/graph-relevance.js"
import { searchKnowledge } from "../../domain/workspaces/knowledge-search.js"
import { publishedProjection } from "../../domain/workspaces/revision.js"
import { projectionFromWorkspace } from "../../models/workspaces.js"
import { fitPage, truncateText } from "../framework/budget.js"
import {
  requireServed,
  resolveCallWorkspace,
} from "../framework/call-workspace.js"
import { decodeCursor, encodeCursor } from "../framework/cursor.js"
import { checkPath } from "../framework/refs.js"
import { servedSchema, workspaceArgument } from "../framework/schemas.js"
import { McpToolError } from "../framework/tool-errors.js"
import type { CallOrg } from "../framework/tool-org.js"
import { defineMcpReadTool } from "../framework/tool-registry.js"
import { TtlCache } from "../framework/ttl-cache.js"

const instant = z.iso.datetime({ offset: true })

/**
 * The arguments of `get_related`. Each bound is the bound that `rankRelated`
 * and `expandWorkspaceGraph` check, so a call that passes here never makes
 * either function throw (ADR-051 §6).
 */
export const getRelatedInputShape = {
  workspace: workspaceArgument,
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
      "The kind of question: why (decisions), ownership, change (recent changes), dependencies, structure, or general.",
    ),
  predicates: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(50)
    .optional()
    .describe("Walk only edges with these predicates."),
  excludePredicates: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(50)
    .optional()
    .describe("Give these predicates the weight 0 in the ranking."),
  predicateWeights: z
    .record(z.string().min(1).max(64), z.number().min(0))
    .refine((weights) => Object.keys(weights).length <= 50, {
      message: "At most 50 predicate weights.",
    })
    .optional()
    .describe("Replaces the weight of single predicates. 0 removes the edges."),
  kinds: z
    .array(z.string().min(1).max(64))
    .max(50)
    .optional()
    .describe(
      "Only results of these kinds. The walk still passes through other kinds.",
    ),
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
    .min(1)
    .max(1_000)
    .default(50)
    .describe("Edges that one unit expands, the strongest first. Default 50."),
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
    .optional()
    .describe(
      "Exponent of the hub penalty degree^-x. The intent sets the default.",
    ),
  diversity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "0 ranks by score only; higher spreads results over kinds and neighbors. Default 0.3.",
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

/** The ranking of one call, before paging. A revision graph never changes. */
type Ranking = {
  results: RelatedResult[]
  explored: { nodes: number; edges: number }
  partial: boolean
  partialReason?: string
  cappedHubs: string[]
}

/** Results that one ranking keeps. A page takes at most 50 of them. */
const RANKED_LIMIT = 100

/** Rankings by projection and parameters, so that page 2 needs no graph query. */
const rankings = new TtlCache<Ranking>({ ttlMs: 10 * 60_000, maxEntries: 200 })

function round(value: number): number {
  return Number(value.toPrecision(3))
}

async function loadProjection(org: CallOrg, workspaceId: string) {
  const [row] = await withOrgDbContext(org.id, (db) =>
    db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.orgId, org.id), eq(workspaces.id, workspaceId)))
      .limit(1),
  )
  return row ? publishedProjection(projectionFromWorkspace(row)) : null
}

async function resolveSeeds(
  org: CallOrg,
  workspaceId: string,
  sha: string,
  refs: readonly string[],
): Promise<string[]> {
  const paths = [...new Set(refs.map((ref) => checkPath(ref, ref)))]
  const rows = await withOrgDbContext(org.id, (db) =>
    db
      .select({
        id: workspaceKnowledgeUnits.servingId,
        path: workspaceKnowledgeUnits.path,
      })
      .from(workspaceKnowledgeUnits)
      .where(
        and(
          eq(workspaceKnowledgeUnits.orgId, org.id),
          eq(workspaceKnowledgeUnits.workspaceId, workspaceId),
          eq(workspaceKnowledgeUnits.projectionSha, sha),
          inArray(workspaceKnowledgeUnits.path, paths),
        ),
      ),
  )
  const found = new Set(rows.map((row) => row.path))
  const unknown = paths.filter((path) => !found.has(path))
  if (unknown.length > 0) {
    throw new McpToolError(
      "unknown_ref",
      `No knowledge unit for: ${unknown.join(", ")}. Use paths from search_knowledge or an earlier result.`,
    )
  }
  return rows.map((row) => row.id)
}

async function rank(
  org: CallOrg,
  workspace: { id: string; slug: string },
  sha: string,
  input: z.infer<z.ZodObject<typeof getRelatedInputShape>>,
): Promise<Ranking> {
  const notReady = (reason: string) =>
    new McpToolError(
      "workspace_not_ready",
      `The knowledge graph of Workspace "${workspace.slug}" is ${reason}. Try again in a few minutes.`,
    )
  const projection = await loadProjection(org, workspace.id)
  if (projection?.kind !== "active") throw notReady("not ready")
  const seedIds = await resolveSeeds(org, workspace.id, sha, input.seeds)
  const expansion = await expandWorkspaceGraph({
    orgId: org.id,
    orgSlug: org.slug,
    projection,
    seeds: seedIds,
    maxDepth: input.maxDepth,
    direction: input.direction,
    predicates: input.predicates,
    minConfidence: input.minConfidence,
    maxFanOut: input.maxFanOut,
    validAt: input.validAt,
    validBetween: input.validBetween,
  }).catch((error: unknown) => {
    if (error instanceof WorkspaceGraphBuildingError) {
      throw notReady("being built")
    }
    if (error instanceof WorkspaceGraphUnavailableError) {
      throw notReady("not ready")
    }
    throw error
  })
  const queryHits = input.query
    ? (
        await searchKnowledge({
          orgId: org.id,
          workspaceIds: [workspace.id],
          query: input.query,
          unitIds: expansion.nodes.map((node) => node.id),
          limit: 50,
        })
      ).map((hit) => ({ id: hit.unitId, score: hit.score }))
    : []
  const predicateWeights = {
    ...input.predicateWeights,
    ...Object.fromEntries(
      (input.excludePredicates ?? []).map((predicate) => [predicate, 0]),
    ),
  }
  const ranked = rankRelated({
    nodes: expansion.nodes,
    signals: expansion.edges,
    seeds: seedIds,
    queryHits,
    options: {
      intent: input.intent,
      predicateWeights,
      direction: input.direction,
      restart: input.restart,
      queryWeight: input.queryWeight,
      hubPenalty: input.hubPenalty,
      recencyHalfLifeDays: input.recencyHalfLifeDays,
      diversity: input.diversity,
      maxPerKind: input.maxPerKind,
      kinds: input.kinds,
      includeSeeds: input.includeSeeds,
      limit: RANKED_LIMIT,
      now: input.validAt ? new Date(input.validAt) : undefined,
      validBetween: input.validBetween && {
        from: new Date(input.validBetween.from),
        to: new Date(input.validBetween.to),
      },
    },
  })
  const nodes = new Map(expansion.nodes.map((node) => [node.id, node]))
  const refOf = (id: string) => nodes.get(id)?.path ?? id
  const units = ranked.length
    ? await withOrgDbContext(org.id, (db) =>
        db
          .select({
            id: workspaceKnowledgeUnits.servingId,
            title: workspaceKnowledgeUnits.title,
            source: workspaceKnowledgeUnits.source,
            updatedAt: workspaceKnowledgeUnits.updatedAt,
          })
          .from(workspaceKnowledgeUnits)
          .where(
            and(
              eq(workspaceKnowledgeUnits.orgId, org.id),
              eq(workspaceKnowledgeUnits.workspaceId, workspace.id),
              inArray(
                workspaceKnowledgeUnits.servingId,
                ranked.map((result) => result.id),
              ),
            ),
          ),
      )
    : []
  const unitById = new Map(units.map((unit) => [unit.id, unit]))
  const results = ranked.flatMap((result): RelatedResult[] => {
    const node = nodes.get(result.id)
    const unit = unitById.get(result.id)
    if (!node?.path || !unit) return []
    return [
      {
        ref: node.path,
        title: unit.title,
        kind: result.kind,
        source: unit.source ?? "authored",
        updatedAt: unit.updatedAt.toISOString(),
        ...(node.summary ? { summary: truncateText(node.summary, 200) } : {}),
        score: round(result.score),
        ...(result.queryMatch > 0
          ? { queryMatch: round(result.queryMatch) }
          : {}),
        depth: node.depth,
        path: result.path.map((step) => ({
          from: refOf(step.from),
          to: refOf(step.to),
          predicate: step.predicate,
          weight: round(step.weight),
        })),
      },
    ]
  })
  return {
    results,
    explored: { nodes: expansion.nodes.length, edges: expansion.edges.length },
    partial: expansion.partial,
    ...(expansion.partialReason
      ? { partialReason: expansion.partialReason }
      : {}),
    cappedHubs: expansion.cappedHubs.slice(0, 20).map(refOf),
  }
}

/** Register this tool at the seven-tool cutover (ADR-051). */
export const getRelatedTool = defineMcpReadTool({
  name: "get_related",
  title: "Get related knowledge",
  description:
    "Find knowledge related to seed refs AND relevant to your query, ranked by graph proximity, edge confidence, recency and query match. Each result can explain why (the path of predicates from a seed). Set intent for the question: why, ownership, change, dependencies, structure. Filter by predicates, kinds, direction, depth and time. Use it after search_knowledge to find owners, dependencies, decisions, incidents and changes. Without a query it lists plain neighbors (maxDepth 1).",
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
    const served = requireServed(workspace)
    const { cursor, ...parameters } = input
    const { limit, maxTokens, explain, ...rankParameters } = parameters
    const binding = {
      orgId: org.id,
      workspaceId: workspace.id,
      scope: JSON.stringify(["get_related", parameters]),
      sha: served.sha,
    }
    const offset = cursor ? decodeCursor(cursor, binding) : 0
    const key = createHash("sha256")
      .update(
        JSON.stringify([org.id, workspace.id, served.sha, rankParameters]),
      )
      .digest("hex")
    let ranking = rankings.get(key)
    if (!ranking) {
      ranking = await rank(org, workspace, served.sha, input)
      rankings.set(key, ranking)
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
        : { cursor: encodeCursor({ ...binding, offset: nextOffset }) }),
      ...(truncated ? { truncated: true } : {}),
    }
  },
})
