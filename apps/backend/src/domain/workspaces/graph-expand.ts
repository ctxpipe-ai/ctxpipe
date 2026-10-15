import { z } from "zod"
import {
  type GraphClient,
  GraphQueryTimeoutError,
} from "../../platform/graph/client.js"
import {
  WorkspaceGraphMissingError,
  withCompleteWorkspaceGraph,
} from "./graph-projection.js"
import { readOrRebuild } from "./graph-rebuild.js"
import type { PublishedProjection } from "./revision.js"

/**
 * The limits of ADR-051 section 6. A caller can set lower limits. A test can
 * give the walk up to `maxTestTimeoutMs`, so that the load of the machine does
 * not change a result.
 */
export const defaultCaps = {
  maxNodes: 5_000,
  maxEdges: 25_000,
  hopTimeoutMs: 1_000,
  totalTimeoutMs: 3_000,
}

const maxTestTimeoutMs = 60_000

const expandParamsSchema = z
  .object({
    seeds: z.array(z.string().min(1)).min(1).max(10),
    maxDepth: z.number().int().min(0).max(4).default(1),
    direction: z.enum(["out", "in", "both"]).default("both"),
    predicates: z.array(z.string().min(1)).min(1).optional(),
    minConfidence: z.number().min(0).max(1).default(0),
    maxFanOut: z.number().int().min(1).max(1_000).default(50),
    validAt: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString())
      .optional(),
    validBetween: z
      .object({
        from: z.iso
          .datetime({ offset: true })
          .transform((value) => new Date(value).toISOString()),
        to: z.iso
          .datetime({ offset: true })
          .transform((value) => new Date(value).toISOString()),
      })
      .optional(),
    caps: z
      .object({
        maxNodes: z.number().int().min(1).max(defaultCaps.maxNodes),
        maxEdges: z.number().int().min(0).max(defaultCaps.maxEdges),
        hopTimeoutMs: z.number().int().min(0).max(maxTestTimeoutMs),
        totalTimeoutMs: z.number().int().min(0).max(maxTestTimeoutMs),
      })
      .partial()
      .optional(),
  })
  .refine(
    (params) =>
      !params.validBetween ||
      params.validBetween.from <= params.validBetween.to,
    {
      message: "Validity window ends before it starts.",
    },
  )
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
  /** Nodes with more matching edges than `maxFanOut`; only the strongest edges of each predicate were walked. */
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
  probe: z.boolean(),
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
 * for each hop. Each node expands at most `maxFanOut` matching edges: the
 * strongest edge of each predicate, then the second strongest, and so on.
 * The walk never reads the whole graph: it stops at a cap and marks the
 * result `partial`. The result is sorted by id, so it does not depend on
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
  const instant = params.validAt ?? new Date().toISOString()
  const window = params.validBetween ?? { from: instant, to: instant }
  const deadline = performance.now() + caps.totalTimeoutMs
  const nodes = new Map<string, ExpandedNode>()
  const edges = new Map<string, ExpandedEdge>()
  const cappedHubs = new Set<string>()
  let partialReason: GraphExpansion["partialReason"] = null
  let timeoutReason: "total_timeout" | "hop_timeout" = "total_timeout"
  try {
    await readOrRebuild(input, (graph) =>
      withCompleteWorkspaceGraph(
        graph,
        async ({ client, projectionKey, marker }) => {
          const count = await client.executeQuery(
            "MATCH (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey}) RETURN count(n) AS nodeCount",
            { projectionKey },
            { deadline },
          )
          if (
            Number(count.records[0]?.get("nodeCount")) !==
            Number(marker.get("nodeCount"))
          )
            throw new WorkspaceGraphMissingError(
              "Workspace graph projection is unavailable.",
            )
          const seedResult = await client.executeQuery(
            `MATCH (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey})
        WHERE n.id IN $seeds RETURN ${nodeFields("")} ORDER BY n.id LIMIT $seedLimit`,
            {
              projectionKey,
              seeds: params.seeds,
              seedLimit: caps.maxNodes + 1,
            },
            { deadline },
          )
          for (const node of rows(
            nodeSchema,
            seedResult.records.slice(0, caps.maxNodes),
          ))
            nodes.set(node.id, { ...node, depth: 0 })
          partialReason =
            seedResult.records.length > caps.maxNodes ? "max_nodes" : null
          let frontier = [...nodes.keys()]
          for (
            let depth = 1;
            depth <= params.maxDepth && frontier.length && !partialReason;
            depth++
          ) {
            const hopDeadline = Math.min(
              deadline,
              performance.now() + caps.hopTimeoutMs,
            )
            timeoutReason =
              hopDeadline < deadline ? "hop_timeout" : "total_timeout"
            const hop = await expandHop(client, {
              projectionKey,
              frontier,
              direction: params.direction,
              predicates: params.predicates,
              minConfidence: params.minConfidence,
              maxFanOut: params.maxFanOut,
              window,
              remainingEdges: caps.maxEdges - edges.size,
              seenEdges: [...edges.keys()],
              deadline: hopDeadline,
            })
            for (const id of hop.cappedHubs) cappedHubs.add(id)
            const next: string[] = []
            for (const { fromId, probe, ...edge } of hop.edges) {
              if (probe || edges.has(edge.id)) continue
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
        },
        { deadline },
      ),
    )
  } catch (error) {
    if (!(error instanceof GraphQueryTimeoutError)) throw error
    partialReason = timeoutReason
  }
  if (!partialReason && performance.now() >= deadline)
    partialReason = "total_timeout"
  return {
    nodes: [...nodes.values()].sort((a, b) => compare(a.id, b.id)),
    edges: [...edges.values()].sort((a, b) => compare(a.id, b.id)),
    partial: partialReason !== null,
    partialReason,
    cappedHubs: [...cappedHubs].sort(compare),
  }
}

/** Read at most maxFanOut + 1 edges per node and remainingEdges + 1 rows per hop. */
export async function expandHop(
  client: GraphClient,
  input: {
    projectionKey: string
    frontier: string[]
    direction: "out" | "in" | "both"
    predicates: string[] | undefined
    minConfidence: number
    maxFanOut: number
    remainingEdges: number
    seenEdges: string[]
    deadline?: number
    window: { from: string; to: string }
  },
) {
  const pattern = {
    out: "-[r:WorkspaceSignal {projectionKey: $projectionKey}]->",
    in: "<-[r:WorkspaceSignal {projectionKey: $projectionKey}]-",
    both: "-[r:WorkspaceSignal {projectionKey: $projectionKey}]-",
  }[input.direction]
  // The fan-out takes the edges of a node in turns by predicate, the
  // strongest edge of each predicate first, so that one predicate with many
  // edges does not fill the fan-out of a node. Of equal edges, the newest
  // (`validFrom`) comes first. Round 1 holds at most `perNodeLimit`
  // predicates, those with the strongest edges, and each predicate reads at
  // most `perNodeLimit` edges in its own subquery. Thus the memory of a node
  // stays at most perNodeLimit² edges, however many edges a hub has.
  // Validity compares ISO strings. An edge is valid in the window when it
  // starts before the window ends and ends after the window starts.
  const match = `MATCH (f:WorkspaceKnowledgeUnit {projectionKey: $projectionKey, id: fromId})${pattern}(n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey})
      WHERE r.confidence >= $minConfidence
        ${input.predicates ? "AND r.predicate IN $predicates" : ""}
        AND (r.validFrom IS NULL OR r.validFrom <= $windowTo)
        AND (r.validTo IS NULL OR r.validTo > $windowFrom)`
  const result = await client.executeQuery(
    `UNWIND $frontier AS fromId
    CALL {
      WITH fromId
      ${match}
      WITH fromId, r.predicate AS predicate, max(r.confidence) AS best
      ORDER BY best DESC, predicate LIMIT $perNodeLimit
      CALL {
        WITH fromId, predicate
        ${match} AND r.predicate = predicate
        WITH DISTINCT r ORDER BY r.confidence DESC, coalesce(r.validFrom, '') DESC, r.id
        LIMIT $perNodeLimit
        RETURN collect(r) AS ranked
      }
      UNWIND range(0, size(ranked) - 1) AS rank
      WITH ranked[rank] AS r, rank
      RETURN r ORDER BY rank, r.confidence DESC, coalesce(r.validFrom, '') DESC, r.id LIMIT $perNodeLimit
    }
    WITH fromId, collect(r) AS top
    WITH collect({fromId: fromId, top: top}) AS groups
    WITH groups, [g IN groups WHERE size(g.top) > $maxFanOut | g.fromId] AS cappedHubs
    UNWIND groups AS g
    UNWIND range(0, size(g.top) - 1) AS edgeIndex
    WITH g.fromId AS fromId, g.top[edgeIndex] AS r,
      edgeIndex >= $maxFanOut AS probe, cappedHubs
    WHERE probe OR NOT r.id IN $seenEdges
    WITH r, probe, cappedHubs, min(fromId) AS fromId
    WITH r, probe, cappedHubs, fromId,
      CASE WHEN startNode(r).id = fromId THEN endNode(r) ELSE startNode(r) END AS n
    RETURN fromId, probe, cappedHubs, r.id AS id, startNode(r).id AS sourceId, endNode(r).id AS targetId,
      r.predicate AS predicate, r.confidence AS confidence, r.validFrom AS validFrom,
      r.validTo AS validTo, r.source AS source, r.lastObservedAt AS lastObservedAt, ${nodeFields("node_")}
    ORDER BY probe, confidence DESC, coalesce(validFrom, '') DESC, id, fromId LIMIT $rowLimit`,
    {
      projectionKey: input.projectionKey,
      frontier: input.frontier,
      predicates: input.predicates ?? [],
      minConfidence: input.minConfidence,
      maxFanOut: input.maxFanOut,
      perNodeLimit: input.maxFanOut + 1,
      rowLimit: input.remainingEdges + 1,
      seenEdges: input.seenEdges,
      windowFrom: input.window.from,
      windowTo: input.window.to,
    },
    { deadline: input.deadline },
  )
  const nodes = new Map(
    rows(nodeSchema, result.records, "node_").map((node) => [node.id, node]),
  )
  // The strongest edges come first, so a cap keeps them. Ties sort the
  // newest first, then by id.
  const edges = rows(edgeSchema, result.records).sort(
    (a, b) =>
      b.confidence - a.confidence ||
      compare(b.validFrom ?? "", a.validFrom ?? "") ||
      compare(a.id, b.id),
  )
  const cappedHubs = z
    .array(z.string())
    .parse(result.records[0]?.get("cappedHubs") ?? [])
  if (input.deadline !== undefined && performance.now() >= input.deadline)
    throw new GraphQueryTimeoutError("Graph query deadline exceeded.")
  return { nodes, edges, cappedHubs }
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
