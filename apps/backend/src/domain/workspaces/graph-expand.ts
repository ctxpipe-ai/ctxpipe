import { z } from "zod"
import type { GraphClient } from "../../platform/graph/client.js"
import { withCompleteWorkspaceGraph } from "./graph-projection.js"
import { readOrRebuild } from "./graph-rebuild.js"
import type { PublishedProjection } from "./revision.js"

/** The limits of ADR-051 section 6. A caller can set lower limits. */
const defaultCaps = {
  maxNodes: 5_000,
  maxEdges: 25_000,
  hopTimeoutMs: 1_000,
  totalTimeoutMs: 3_000,
}

const expandParamsSchema = z
  .object({
    seeds: z.array(z.string().min(1)).min(1).max(10),
    maxDepth: z.number().int().min(0).max(4).default(1),
    direction: z.enum(["out", "in", "both"]).default("both"),
    predicates: z.array(z.string().min(1)).min(1).optional(),
    minConfidence: z.number().min(0).max(1).default(0),
    maxFanOut: z.number().int().min(1).max(1_000).default(50),
    validAt: z.iso.datetime({ offset: true }).optional(),
    validBetween: z
      .object({
        from: z.iso.datetime({ offset: true }),
        to: z.iso.datetime({ offset: true }),
      })
      .optional(),
    caps: z
      .object({
        maxNodes: z.number().int().min(1),
        maxEdges: z.number().int().min(0),
        hopTimeoutMs: z.number().int().min(0),
        totalTimeoutMs: z.number().int().min(0),
      })
      .partial()
      .optional(),
  })
  .refine((params) => !(params.validAt && params.validBetween), {
    message: "Give validAt or validBetween, not both.",
  })

export type GraphExpandParams = z.input<typeof expandParamsSchema>

export type ExpandedNode = {
  id: string
  kind: string
  name: string | null
  summary: string | null
  path: string | null
  degree: number
  inDegree: number
  outDegree: number
  /** The hop that found the node. A seed has depth 0. */
  depth: number
}

export type ExpandedEdge = {
  id: string
  sourceId: string
  targetId: string
  predicate: string
  confidence: number
  validFrom: string | null
  validTo: string | null
  source: string | null
  lastObservedAt: string
}

export type GraphExpansion = {
  nodes: ExpandedNode[]
  edges: ExpandedEdge[]
  /** True when a cap stopped the walk before `maxDepth`. */
  partial: boolean
  partialReason:
    | "max_nodes"
    | "max_edges"
    | "hop_timeout"
    | "total_timeout"
    | null
  /** Nodes with more matching edges than `maxFanOut`; only their strongest edges were walked. */
  cappedHubs: string[]
}

const nodeSchema = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string().nullable(),
  summary: z.string().nullable(),
  path: z.string().nullable(),
  degree: z.number(),
  inDegree: z.number(),
  outDegree: z.number(),
})

const edgeSchema = z.object({
  fromId: z.string(),
  matched: z.number(),
  id: z.string(),
  sourceId: z.string(),
  targetId: z.string(),
  predicate: z.string(),
  confidence: z.number(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  source: z.string().nullable(),
  lastObservedAt: z.string(),
})

/** Cypher columns for the node `n`, each named `<prefix><field>`. */
const nodeFields = (prefix: string) =>
  Object.keys(nodeSchema.shape)
    .map((key) => `n.${key} AS ${prefix}${key}`)
    .join(", ")

function rows<T extends z.ZodObject>(
  schema: T,
  records: Array<{ get: (key: string) => unknown }>,
  prefix = "",
): Array<z.output<T>> {
  return records.map((row) =>
    schema.parse(
      Object.fromEntries(
        Object.keys(schema.shape).map((key) => [
          key,
          row.get(`${prefix}${key}`) ?? null,
        ]),
      ),
    ),
  )
}

/**
 * Walk the published Workspace graph from `seeds`, one bounded Cypher query
 * for each hop. Each node expands only its `maxFanOut` strongest matching
 * edges. The walk never reads the whole graph: it stops at a cap and marks
 * the result `partial`. The result is sorted by id, so it does not depend on
 * the write order of the graph.
 */
export async function expandWorkspaceGraph(
  input: {
    orgId: string
    orgSlug: string
    projection: PublishedProjection | null
  } & GraphExpandParams,
): Promise<GraphExpansion> {
  const params = expandParamsSchema.parse(input)
  const caps = { ...defaultCaps, ...params.caps }
  const window = params.validBetween ?? {
    from: params.validAt ?? new Date().toISOString(),
    to: params.validAt ?? new Date().toISOString(),
  }
  return readOrRebuild(input, (graph) =>
    withCompleteWorkspaceGraph(graph, async ({ client, projectionKey }) => {
      const started = performance.now()
      const seedResult = await client.executeQuery(
        `MATCH (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey})
        WHERE n.id IN $seeds RETURN ${nodeFields("")}`,
        { projectionKey, seeds: params.seeds },
      )
      const nodes = new Map<string, ExpandedNode>(
        rows(nodeSchema, seedResult.records).map((node) => [
          node.id,
          { ...node, depth: 0 },
        ]),
      )
      const edges = new Map<string, ExpandedEdge>()
      const cappedHubs = new Set<string>()
      let partialReason: GraphExpansion["partialReason"] = null
      let frontier = [...nodes.keys()]
      for (
        let depth = 1;
        depth <= params.maxDepth && frontier.length;
        depth++
      ) {
        const remaining = caps.totalTimeoutMs - (performance.now() - started)
        if (remaining <= 0) {
          partialReason = "total_timeout"
          break
        }
        const hop = await withTimeout(
          expandHop(client, {
            projectionKey,
            frontier,
            direction: params.direction,
            predicates: params.predicates,
            minConfidence: params.minConfidence,
            maxFanOut: params.maxFanOut,
            window,
          }),
          Math.min(caps.hopTimeoutMs, remaining),
        )
        if (hop === "timeout") {
          partialReason =
            caps.hopTimeoutMs < remaining ? "hop_timeout" : "total_timeout"
          break
        }
        for (const edge of hop.edges)
          if (edge.matched > params.maxFanOut) cappedHubs.add(edge.fromId)
        const next: string[] = []
        for (const { fromId, matched, ...edge } of hop.edges) {
          if (edges.has(edge.id)) continue
          const otherId =
            edge.sourceId === fromId ? edge.targetId : edge.sourceId
          const other = hop.nodes.get(otherId)
          const isNew = !nodes.has(otherId)
          if (isNew && nodes.size >= caps.maxNodes) {
            partialReason = "max_nodes"
            break
          }
          if (edges.size >= caps.maxEdges) {
            partialReason = "max_edges"
            break
          }
          edges.set(edge.id, edge)
          if (isNew && other) {
            nodes.set(otherId, { ...other, depth })
            next.push(otherId)
          }
        }
        if (partialReason) break
        frontier = next
      }
      return {
        nodes: [...nodes.values()].sort((a, b) => compare(a.id, b.id)),
        edges: [...edges.values()].sort((a, b) => compare(a.id, b.id)),
        partial: partialReason !== null,
        partialReason,
        cappedHubs: [...cappedHubs].sort(compare),
      }
    }),
  )
}

async function expandHop(
  client: GraphClient,
  input: {
    projectionKey: string
    frontier: string[]
    direction: "out" | "in" | "both"
    predicates: string[] | undefined
    minConfidence: number
    maxFanOut: number
    window: { from: string; to: string }
  },
) {
  const pattern = {
    out: "-[r:WorkspaceSignal {projectionKey: $projectionKey}]->",
    in: "<-[r:WorkspaceSignal {projectionKey: $projectionKey}]-",
    both: "-[r:WorkspaceSignal {projectionKey: $projectionKey}]-",
  }[input.direction]
  // Validity compares ISO strings. An edge is valid in the window when it
  // starts before the window ends and ends after the window starts.
  const result = await client.executeQuery(
    `UNWIND $frontier AS fromId
    MATCH (f:WorkspaceKnowledgeUnit {projectionKey: $projectionKey, id: fromId})${pattern}(n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey})
    WHERE r.confidence >= $minConfidence
      ${input.predicates ? "AND r.predicate IN $predicates" : ""}
      AND (r.validFrom IS NULL OR r.validFrom <= $windowTo)
      AND (r.validTo IS NULL OR r.validTo > $windowFrom)
    WITH fromId, r, n ORDER BY r.confidence DESC, r.id
    WITH fromId, count(r) AS matched, collect([r, n])[0..$maxFanOut] AS top
    UNWIND top AS hit
    WITH fromId, matched, hit[0] AS r, hit[1] AS n
    RETURN fromId, matched, r.id AS id, startNode(r).id AS sourceId, endNode(r).id AS targetId,
      r.predicate AS predicate, r.confidence AS confidence, r.validFrom AS validFrom,
      r.validTo AS validTo, r.source AS source, r.lastObservedAt AS lastObservedAt, ${nodeFields("node_")}`,
    {
      projectionKey: input.projectionKey,
      frontier: input.frontier,
      predicates: input.predicates ?? [],
      minConfidence: input.minConfidence,
      maxFanOut: input.maxFanOut,
      windowFrom: input.window.from,
      windowTo: input.window.to,
    },
  )
  const nodes = new Map(
    rows(nodeSchema, result.records, "node_").map((node) => [node.id, node]),
  )
  // The strongest edges come first, so a cap keeps them. Ties sort by id.
  const edges = rows(edgeSchema, result.records).sort(
    (a, b) => b.confidence - a.confidence || compare(a.id, b.id),
  )
  return { nodes, edges }
}

async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
