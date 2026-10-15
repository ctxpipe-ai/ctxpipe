import { createHash } from "node:crypto"
import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"
import { withOrgDbContext } from "../../db/client.js"
import {
  workspaceKnowledgeUnits,
  workspaces,
} from "../../db/schema/workspaces.js"
import {
  defaultCaps,
  type ExpandedNode,
  expandWorkspaceGraph,
  type GraphExpandParams,
} from "../../domain/workspaces/graph-expand.js"
import { WorkspaceGraphUnavailableError } from "../../domain/workspaces/graph-projection.js"
import { WorkspaceGraphBuildingError } from "../../domain/workspaces/graph-rebuild.js"
import {
  INTENT_PRESETS,
  isAnswerKind,
  RELEVANCE_INTENTS,
  rankRelated,
} from "../../domain/workspaces/graph-relevance.js"
import {
  embedQuery,
  searchKnowledge,
} from "../../domain/workspaces/knowledge-search.js"
import {
  type PublishedProjection,
  publishedProjection,
} from "../../domain/workspaces/revision.js"
import { projectionFromWorkspace } from "../../models/workspaces.js"
import { fitPage, truncateText } from "../framework/budget.js"
import {
  requireServed,
  resolveCallWorkspace,
} from "../framework/call-workspace.js"
import { decodeCursorWithAnchor, encodeCursor } from "../framework/cursor.js"
import { checkPath } from "../framework/refs.js"
import { servedSchema, workspaceArgument } from "../framework/schemas.js"
import { McpToolError } from "../framework/tool-errors.js"
import type { CallOrg } from "../framework/tool-org.js"
import { defineMcpReadTool } from "../framework/tool-registry.js"

const instant = z.iso.datetime({ offset: true })
const name = z.string().min(1).max(64)

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
      "The kind of question: why (decisions), ownership, change (recent changes), dependencies, structure, or general. Set it, or give the question as query: with neither, one page must serve every kind of question.",
    ),
  predicates: z
    .array(name)
    .min(1)
    .max(50)
    .optional()
    .describe(
      "Walk only edges with these predicates. Not case-sensitive. Default: the edges of the intent and the link edges, then all edges only with fewer than limit results or no answer kind (all edges for general).",
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

function round(value: number): number {
  return Number(value.toPrecision(3))
}

/**
 * The projection that the call walks and ranks, read once. It must hold the
 * revision that the call serves. A publish between the two reads gives
 * `workspace_not_ready` (retryable), never a mix of two revisions.
 */
async function loadProjection(
  org: CallOrg,
  workspace: { id: string; slug: string },
  sha: string,
): Promise<Extract<PublishedProjection, { kind: "active" }>> {
  const [row] = await withOrgDbContext(org.id, (db) =>
    db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.orgId, org.id), eq(workspaces.id, workspace.id)))
      .limit(1),
  )
  const projection = row
    ? publishedProjection(projectionFromWorkspace(row))
    : null
  if (projection?.kind === "legacy") {
    throw new McpToolError(
      "workspace_not_ready",
      `The knowledge graph of Workspace "${workspace.slug}" does not exist yet. The Workspace needs a hydrate.`,
    )
  }
  if (projection?.kind !== "active") {
    throw new McpToolError(
      "workspace_not_ready",
      `The knowledge graph of Workspace "${workspace.slug}" is not ready. Try again in a few minutes.`,
    )
  }
  if (projection.revision.sha !== sha) {
    throw new McpToolError(
      "workspace_not_ready",
      `Workspace "${workspace.slug}" got a new revision during the call. Send the call again.`,
    )
  }
  return projection
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

/** The deadline of a search, or a Postgres statement timeout (57014). */
function isTimeout(error: unknown): boolean {
  for (let current = error; current; ) {
    if (current instanceof DOMException && current.name === "TimeoutError")
      return true
    if (typeof current !== "object") return false
    if ("code" in current && current.code === "57014") return true
    current = "cause" in current ? current.cause : undefined
  }
  return false
}

/**
 * The ranking of one call as of `now`. It loads the projection once and
 * checks that it holds the served `sha`. `options.caps` lowers the walk caps,
 * or gives a test more time.
 */
export async function rankWorkspaceRelated(
  org: CallOrg,
  workspace: { id: string; slug: string },
  sha: string,
  input: z.infer<z.ZodObject<typeof getRelatedInputShape>>,
  now: Date,
  options: { caps?: GraphExpandParams["caps"] } = {},
): Promise<Ranking> {
  const notReady = (reason: string) =>
    new McpToolError(
      "workspace_not_ready",
      `The knowledge graph of Workspace "${workspace.slug}" is ${reason}. Try again in a few minutes.`,
    )
  const projection = await loadProjection(org, workspace, sha)
  const seedIds = await resolveSeeds(org, workspace.id, sha, input.seeds)
  const total = { ...defaultCaps, ...options.caps }
  const startedAt = performance.now()
  const deadline = startedAt + total.totalTimeoutMs
  let searchTimedOut = false
  let queryEmbedding: Promise<number[] | null> | undefined
  // Walk the graph and rank what the walk found. No `predicates` walks all
  // edges.
  const walk = async (
    predicates: string[] | undefined,
    diversity = input.diversity,
    caps = options.caps,
  ) => {
    const expansion = await expandWorkspaceGraph({
      orgId: org.id,
      orgSlug: org.slug,
      projection,
      seeds: seedIds,
      maxDepth: input.maxDepth,
      direction: input.direction,
      predicates,
      excludePredicates: input.excludePredicates?.map((predicate) =>
        predicate.toUpperCase(),
      ),
      minConfidence: input.minConfidence,
      maxFanOut: input.maxFanOut,
      validAt: input.validBetween
        ? undefined
        : (input.validAt ?? now.toISOString()),
      validBetween: input.validBetween,
      caps: {
        ...caps,
        totalTimeoutMs: Math.max(0, Math.floor(deadline - performance.now())),
      },
    }).catch((error: unknown) => {
      if (error instanceof WorkspaceGraphBuildingError) {
        throw notReady("being built")
      }
      if (error instanceof WorkspaceGraphUnavailableError) {
        throw notReady("not ready")
      }
      throw error
    })
    const query = input.query
    // Both walks search the same query, so the call embeds it once, inside
    // the total budget.
    if (query)
      queryEmbedding ??= embedQuery(
        query,
        AbortSignal.timeout(
          Math.max(0, Math.ceil(deadline - performance.now())),
        ),
      )
    const queryHits = query
      ? (
          await searchKnowledge({
            orgId: org.id,
            workspaceIds: [workspace.id],
            query,
            unitIds: expansion.nodes.map((node) => node.id),
            limit: 50,
            deadline,
            embedding: queryEmbedding,
          }).catch((error: unknown) => {
            // Only the end of the budget makes a partial result: the
            // deadline of the search, or a Postgres statement timeout.
            if (!isTimeout(error)) throw error
            searchTimedOut = true
            return []
          })
        ).map((hit) => ({ id: hit.unitId, score: hit.score }))
      : []
    const ranked = rankRelated({
      nodes: expansion.nodes,
      signals: expansion.edges,
      seeds: seedIds,
      queryHits,
      options: {
        intent: input.intent,
        predicateWeights: input.predicateWeights,
        direction: input.direction,
        restart: input.restart,
        queryWeight: input.queryWeight,
        hubPenalty: input.hubPenalty,
        recencyHalfLifeDays: input.recencyHalfLifeDays,
        diversity,
        maxPerKind: input.maxPerKind,
        kinds: input.kinds,
        excludeKinds: input.excludeKinds,
        includeSeeds: input.includeSeeds,
        limit: RANKED_LIMIT,
        now: input.validAt ? new Date(input.validAt) : now,
        validBetween: input.validBetween && {
          from: new Date(input.validBetween.from),
          to: new Date(input.validBetween.to),
        },
      },
    })
    return { expansion, ranked }
  }
  // The graph stores predicates in upper case, and the ranking does the same.
  // Explicit predicates are the whole walk. With none, the walk follows the
  // edges of the intent. Add all edges only for a short result list or a
  // list with no answer kind. Free-form claims can be outside the preset.
  const answers = (results: readonly { kind: string | null }[]) =>
    results.filter((result) => isAnswerKind(input.intent, result.kind))
  const defaultWalk = input.predicates
    ? undefined
    : INTENT_PRESETS[input.intent].walk
  const walks = [
    await walk(
      input.predicates?.map((predicate) => predicate.toUpperCase()) ??
        defaultWalk?.slice(),
    ),
  ]
  // The edges of the walk of all edges are not the edges of the intent, so
  // its results spread over kinds as for `general`.
  // The call keeps its caps as a whole: this walk gets what the first walk left.
  const firstRanked = walks[0]?.ranked ?? []
  if (
    defaultWalk &&
    (firstRanked.length < input.limit || answers(firstRanked).length === 0)
  ) {
    const first = walks[0]?.expansion
    const left = {
      maxNodes: total.maxNodes - (first?.nodes.length ?? 0),
      maxEdges: total.maxEdges - (first?.edges.length ?? 0),
      totalTimeoutMs: Math.floor(
        total.totalTimeoutMs - (performance.now() - startedAt),
      ),
    }
    // A walk with no node, edge, or time left would only repeat the seeds.
    if (left.maxNodes > 0 && left.maxEdges > 0 && left.totalTimeoutMs > 0)
      walks.push(
        await walk(
          undefined,
          input.diversity ?? INTENT_PRESETS.general.diversity,
          { ...options.caps, ...left },
        ),
      )
  }
  // A unit keeps the node and the rank of the first walk that found it. The
  // answers of all walks (`answer` of `rankRelated`) come before the other
  // results, as in one walk.
  const nodes = new Map<string, ExpandedNode>()
  const edgeIds = new Set<string>()
  for (const { expansion } of walks) {
    for (const node of expansion.nodes)
      if (!nodes.has(node.id)) nodes.set(node.id, node)
    for (const edge of expansion.edges) edgeIds.add(edge.id)
  }
  const refOf = (id: string) => nodes.get(id)?.path ?? id
  const rankedIds = new Set<string>()
  const ordered = [
    ...walks.flatMap((step) => step.ranked.filter((result) => result.answer)),
    ...walks.flatMap((step) => step.ranked.filter((result) => !result.answer)),
  ]
  const ranked = ordered
    .filter((result) => !rankedIds.has(result.id) && rankedIds.add(result.id))
    .slice(0, RANKED_LIMIT)
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
              eq(workspaceKnowledgeUnits.projectionSha, sha),
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
  const partialReason = searchTimedOut
    ? "total_timeout"
    : walks.find(({ expansion }) => expansion.partialReason)?.expansion
        .partialReason
  return {
    results,
    explored: { nodes: nodes.size, edges: edgeIds.size },
    partial: searchTimedOut || walks.some(({ expansion }) => expansion.partial),
    ...(partialReason ? { partialReason } : {}),
    cappedHubs: [
      ...new Set(walks.flatMap(({ expansion }) => expansion.cappedHubs)),
    ]
      .slice(0, 20)
      .map(refOf),
  }
}

/** Register this tool at the seven-tool cutover (ADR-051). */
export const getRelatedTool = defineMcpReadTool({
  name: "get_related",
  title: "Get related knowledge",
  description:
    "Use it after search_knowledge to find owners, dependencies, decisions, incidents and changes. Finds knowledge related to seed refs AND relevant to your query, ranked by graph proximity, edge confidence, recency and query match. Set intent (why, ownership, change, dependencies, structure) or give the question as query. Each intent walks its own edges first and puts its answer kinds first; with few results, a second walk follows all edges. Each result can explain why: the path of predicates from a seed. Filter by predicates, kinds, direction, depth and time. For plain neighbors, set maxDepth 1 and no query. Send independent calls in parallel.",
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
    const decoded = cursor ? decodeCursorWithAnchor(cursor, binding) : null
    const offset = decoded?.offset ?? 0
    // A page after the first ranks as of the time of the first page.
    const now = decoded?.anchor ?? Date.now()
    const key = createHash("sha256")
      .update(
        JSON.stringify([org.id, workspace.id, served.sha, rankParameters, now]),
      )
      .digest("hex")
    let ranking = cachedRanking(key)
    if (!ranking) {
      ranking = await rankWorkspaceRelated(
        org,
        workspace,
        served.sha,
        input,
        new Date(now),
      )
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
