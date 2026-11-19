import { parseEnv } from "../config/env.js"
import type {
  ExpandedEdge,
  ExpandedNode,
  GraphExpansion,
} from "../domain/workspaces/graph-expand.js"
import {
  FROM_SOURCE_PREDICATE,
  kindKey,
} from "../domain/workspaces/graph-relevance.js"
import { servingIdForKnowledgePath } from "../domain/workspaces/hydrate.js"
import type { KnowledgeHit } from "../domain/workspaces/knowledge-search.js"
import {
  RANKED_LIMIT,
  type Ranking,
  type RelatedPosition,
  type RelatedResult,
  round,
  unknownRefError,
} from "../domain/workspaces/related-ranking.js"
import { workspaceGraphFromSignals } from "../domain/workspaces/workspace-graph.js"
import {
  createKnowledgeStore,
  documentId,
  type FrontierRelation,
  type KnowledgeDocument,
  type KnowledgeRelation,
  type KnowledgeStore,
} from "../knowledge-store/knowledge-store.js"
import { truncateText } from "../mcp/framework/budget.js"
import { checkPath } from "../mcp/framework/refs.js"
import { McpToolError } from "../mcp/framework/tool-errors.js"
import { embedMultimodal } from "../retrieval/embeddings/multimodalEmbeddings.js"
import { JevError } from "../retrieval/jev/client.js"
import { resolveDisagreements } from "../retrieval/jev/disagreement.js"
import type {
  KnowledgeReader,
  RelatedRequest,
  SearchRequest,
  SearchResult,
} from "./knowledge-reader.js"
import {
  beforeDeadline,
  evidenceText,
  isBudgetSpent,
  jevMeta,
  judge,
  type ModelMeter,
  ORCHESTRATOR_DEFAULTS,
  type TraversalNode,
  traverse,
} from "./orchestrator.js"

/*
 * The knowledge plane (ADR-066 and ADR-068): ClickHouse reads, the Jev
 * layer judge and the multimodal query embedding. The output has the shapes
 * of the old stack, so the tools do not change.
 */

let opened: KnowledgeStore | undefined

/** The store of `CLICKHOUSE_URL` (the reader user), opened on first use. */
function knowledgeStore(): KnowledgeStore {
  opened ??= createKnowledgeStore(parseEnv(process.env).CLICKHOUSE_URL)
  return opened
}

/**
 * The plane reader of one request. `shas` is the served SHA of each
 * Workspace. `meter` counts the model calls.
 */
export function planeKnowledgeReader(input: {
  shas: ReadonlyMap<string, string>
  meter?: ModelMeter
}): KnowledgeReader {
  const meter = input.meter ?? {
    jevCalls: 0,
    jevCandidates: 0,
    embeddingCalls: 0,
  }
  const embed = async (text: string) => {
    meter.embeddingCalls += 1
    const [vector] = await embedMultimodal([{ kind: "query", text }])
    if (!vector) throw new Error("The embedding endpoint returned no vector")
    return vector
  }
  return {
    stack: "plane",
    search: (request) => search(request, input.shas, embed, meter),
    related: (request) => related(request, embed, meter),
    graph: async ({ orgId, workspaceId }) => {
      // The graph view shows at most 5,000 documents and relations.
      const graph = await knowledgeStore().readGraph(
        { orgId, workspaceId },
        5_000,
      )
      const documents = graph.documents.filter(
        (document) => document.status === "active",
      )
      const ids = new Set(documents.map((document) => document.docKey))
      const payload = workspaceGraphFromSignals({
        nodes: documents.map((document) => ({
          id: document.docKey,
          path: document.path,
          kind: document.kind || "KnowledgeUnit",
          name: fileName(document.path),
          summary: document.summary || null,
        })),
        claims: graph.relations
          .filter(
            (relation) => ids.has(relation.srcDoc) && ids.has(relation.dstDoc),
          )
          .map((relation) => ({
            subjectId: relation.srcDoc,
            objectId: relation.dstDoc,
            predicate: relation.predicate,
            aggregatedConfidence: relation.confidence,
            validFrom: relation.validFrom?.toISOString() ?? null,
            validTo: relation.validTo?.toISOString() ?? null,
            source: relation.source || null,
            lastObservedAt: relation.observedAt.toISOString(),
          })),
        lastUpdatedAt:
          documents
            .map((document) => document.observedAt.toISOString())
            .sort()
            .at(-1) ?? null,
      })
      if (graph.truncated) payload.metrics.truncated = true
      return payload
    },
    expand: ({ orgId, workspaceId, params }) =>
      expand(orgId, workspaceId, params),
  }
}

/** The file name of a path without `.md`, as the old graph names a node. */
function fileName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "")
}

/**
 * The query terms for the text index. The index is case-sensitive, so each
 * word also goes in lower case.
 */
function queryTerms(query: string): string[] {
  const words = query.split(/\s+/).filter(Boolean)
  return [...new Set([...words, ...words.map((word) => word.toLowerCase())])]
}

/**
 * `search_knowledge` and the chat search: the hybrid search, then layer 0
 * (Jev orders the hits by p(answers)). When Jev fails, the hits keep the
 * search order and the result says `judge_unavailable`.
 */
async function search(
  request: SearchRequest,
  shas: ReadonlyMap<string, string>,
  embed: (text: string) => Promise<number[]>,
  meter: ModelMeter,
): Promise<SearchResult> {
  const query = request.query.trim()
  if (!query || request.workspaceIds.length === 0) return { hits: [] }
  const deadline = performance.now() + ORCHESTRATOR_DEFAULTS.timeBudgetMs
  const store = knowledgeStore()
  const scope = {
    orgId: request.orgId,
    workspaceIds: [...request.workspaceIds],
  }
  // The store applies each filter before it cuts the candidates.
  const found = await store.search(scope, {
    vector: await embed(query),
    terms: queryTerms(query),
    kinds: request.kinds ? [...request.kinds] : undefined,
    pathPrefix: request.pathPrefix,
    sourceTypes: request.sources ? [...request.sources] : undefined,
    observedAfter: request.updatedAfter ?? null,
    validAt: request.validAt ?? null,
  })
  const limit = Math.min(Math.max(Math.trunc(request.limit ?? 10), 1), 50)
  const inputs = found.map((hit) => ({
    ref: { workspaceId: hit.workspaceId, docKey: hit.document.docKey },
    document: hit.document,
    text: evidenceText(
      hit.document,
      hit.chunks.slice(0, ORCHESTRATOR_DEFAULTS.evidenceChunks),
    ),
  }))
  const [judged, relations] = await Promise.all([
    // A Jev failure or the end of the time budget keeps the search order.
    judge(inputs, query, "search", deadline, meter).catch((error: unknown) => {
      if (error instanceof JevError || isBudgetSpent(error)) return null
      throw error
    }),
    store.readFrontier(
      scope,
      inputs.map((input) => input.ref),
      request.validAt ?? null,
    ),
  ])
  const claimsOf = claimsByDocument(relations)
  const hits = found.flatMap(
    (hit, index): (KnowledgeHit & { order: number })[] => {
      const chunk = hit.chunks[0]
      const sha = shas.get(hit.workspaceId)
      if (!chunk || !sha) return []
      return [
        {
          order: index,
          workspaceId: hit.workspaceId,
          unitId: hit.document.docKey,
          path: hit.document.path,
          kind: hit.document.kind || null,
          title: hit.document.title || null,
          source: hit.document.sourceType || "authored",
          updatedAt: hit.document.observedAt,
          projectionSha: sha,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text,
          claims:
            claimsOf.get(
              documentId({
                workspaceId: hit.workspaceId,
                docKey: hit.document.docKey,
              }),
            ) ?? [],
          score: judged ? (judged[index]?.pAnswers ?? 0) : chunk.score,
        },
      ]
    },
  )
  // Jev's order, with the search order between equal probabilities.
  hits.sort((a, b) => b.score - a.score || a.order - b.order)
  return {
    hits: hits.slice(0, limit).map(({ order: _order, ...hit }) => hit),
    ...(judged ? {} : { partialReason: "judge_unavailable" as const }),
  }
}

/** The out-relations of each document, as the claims of a search hit. */
function claimsByDocument(
  relations: readonly FrontierRelation[],
): Map<string, KnowledgeHit["claims"]> {
  const claims = new Map<string, KnowledgeHit["claims"]>()
  for (const { direction, workspaceId, relation, neighbor } of relations) {
    // The relation of a file to an image that it shows is no claim.
    if (direction !== "out" || relation.predicate === "EMBEDS_IMAGE") continue
    if (!neighbor?.path) continue
    const key = documentId({ workspaceId, docKey: relation.srcDoc })
    const list = claims.get(key) ?? []
    list.push({ predicate: relation.predicate, to: neighbor.path })
    claims.set(key, list)
  }
  return claims
}

/**
 * `get_related`: layer 0 judges the seeds, then up to D layers of the loop.
 * A result is a judged document with p(answers) of at least the `keepAt`
 * setting (a seed only with `includeSeeds`); p(answers) is its score. Then
 * the disagreement step gives the positions of the top results (ADR-068
 * decision 4). When the time budget ends, the result is partial, with
 * `total_timeout` and no positions. When Jev fails, the call fails with
 * `judge_unavailable`.
 */
async function related(
  { org, workspace, input, now }: RelatedRequest,
  embed: (text: string) => Promise<number[]>,
  meter: ModelMeter,
): Promise<Ranking> {
  const deadline = performance.now() + ORCHESTRATOR_DEFAULTS.timeBudgetMs
  const store = knowledgeStore()
  const scope = { orgId: org.id, workspaceIds: [workspace.id] }
  const paths = [...new Set(input.seeds.map((ref) => checkPath(ref, ref)))]
  const question =
    input.query ??
    `Which knowledge is related to ${paths.join(", ")}? The kind of question: ${input.intent}.`
  const seedRefs = paths.map((path) => ({
    workspaceId: workspace.id,
    docKey: servingIdForKnowledgePath(workspace.id, path),
  }))
  let vector: number[]
  let evidence: Awaited<ReturnType<KnowledgeStore["readEvidence"]>>
  try {
    vector = await beforeDeadline(deadline, () => embed(question))
    evidence = await beforeDeadline(deadline, () =>
      store.readEvidence(
        scope,
        seedRefs,
        vector,
        ORCHESTRATOR_DEFAULTS.evidenceChunks,
      ),
    )
  } catch (error) {
    if (!isBudgetSpent(error)) throw error
    return {
      results: [],
      explored: { nodes: 0, edges: 0 },
      partial: true,
      partialReason: "total_timeout",
      cappedHubs: [],
    }
  }
  const seeds = evidence.filter((item) => item.document.status === "active")
  const unknown = paths.filter(
    (path) => !seeds.some((seed) => seed.document.path === path),
  )
  if (unknown.length > 0) throw unknownRefError(unknown)
  const upper = (values: readonly string[] | undefined) =>
    values && new Set(values.map((value) => value.toUpperCase()))
  let traversal: Awaited<ReturnType<typeof traverse>>
  let positions: RelatedPosition[] | undefined
  try {
    traversal = await traverse({
      store,
      deadline,
      scope,
      question,
      intent: input.intent,
      vector,
      seeds: seeds.map((seed) => ({
        ref: { workspaceId: seed.workspaceId, docKey: seed.document.docKey },
        document: seed.document,
        text: evidenceText(seed.document, seed.chunks),
      })),
      maxDepth: input.maxDepth,
      walk: {
        direction: input.direction,
        predicates: upper(input.predicates),
        excludePredicates: upper(input.excludePredicates) ?? new Set(),
        // As on the old stack, only the provenance intent or named
        // predicates walk to a source (ADR-051 section 6).
        skipUnlessNamed: new Set(
          input.intent === "provenance" ? [] : [FROM_SOURCE_PREDICATE],
        ),
        minConfidence: input.minConfidence,
        maxFanOut: input.maxFanOut,
        validAt: input.validBetween
          ? null
          : new Date(input.validAt ?? Date.now()),
        ...(input.validBetween
          ? {
              validBetween: {
                from: new Date(input.validBetween.from),
                to: new Date(input.validBetween.to),
              },
            }
          : {}),
      },
      meter,
    })
    const top = keptNodes(traversal.nodes, input).slice(
      0,
      ORCHESTRATOR_DEFAULTS.disagreementItems,
    )
    if (top.length > 0 && !traversal.partialReason)
      positions = await disagreementPositions(
        question,
        top,
        traversal.relations,
        now,
        deadline,
        meter,
      ).catch((error: unknown) => {
        // The end of the budget gives the ranking with no positions.
        if (!isBudgetSpent(error)) throw error
        traversal.partialReason = "total_timeout"
        return undefined
      })
  } catch (error) {
    if (!(error instanceof JevError)) throw error
    throw new McpToolError(
      "judge_unavailable",
      "The relevance judge did not answer, so get_related has no ranking. Try again later, or use search_knowledge.",
    )
  }
  return {
    results: keptNodes(traversal.nodes, input)
      .slice(0, RANKED_LIMIT)
      .map(relatedResult),
    ...(positions ? { positions } : {}),
    explored: traversal.explored,
    partial: traversal.partialReason !== undefined,
    ...(traversal.partialReason
      ? { partialReason: traversal.partialReason }
      : {}),
    cappedHubs: [
      ...new Set(traversal.cappedHubs.map((document) => document.path)),
    ].slice(0, 20),
  }
}

/**
 * The judged documents that answer (p(answers) of at least `keepAt`) and
 * pass the kind filters of the call, best first. A seed is one only with
 * `includeSeeds`.
 */
function keptNodes(
  nodes: readonly TraversalNode[],
  input: RelatedRequest["input"],
): TraversalNode[] {
  const keptKinds = input.kinds?.length
    ? new Set(input.kinds.map(kindKey))
    : null
  const droppedKinds = new Set((input.excludeKinds ?? []).map(kindKey))
  return nodes
    .filter(
      (node) =>
        (node.depth > 0 || input.includeSeeds) &&
        node.pAnswers >= ORCHESTRATOR_DEFAULTS.keepAt &&
        (!keptKinds || keptKinds.has(kindKey(node.document.kind))) &&
        !droppedKinds.has(kindKey(node.document.kind)),
    )
    .sort(
      (a, b) =>
        b.pAnswers - a.pAnswers ||
        a.depth - b.depth ||
        a.document.path.localeCompare(b.document.path),
    )
}

/**
 * The disagreement step of ADR-068 decision 4 on the top results: the
 * positions, each with its refs, its status, the reason of the status, and
 * the positions that it contradicts or updates. A Jev failure throws its
 * `JevError`.
 */
async function disagreementPositions(
  question: string,
  top: readonly TraversalNode[],
  relations: readonly KnowledgeRelation[],
  queryTime: Date,
  deadline: number,
  meter: ModelMeter,
): Promise<RelatedPosition[]> {
  // The pairs go to Jev in batches of `batchSize`, then one call gives the
  // status of each position.
  const batchSize = 15
  const pairs = (top.length * (top.length - 1)) / 2
  meter.jevCalls += Math.ceil(pairs / batchSize) + 1
  meter.jevCandidates += top.length
  // The resolver makes two calls one after the other, and each gets the rest
  // of the budget, so the deadline also bounds both together.
  const resolution = await beforeDeadline(deadline, () =>
    resolveDisagreements({
      question,
      queryTime,
      batchSize,
      timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
      items: top.map(({ document, text }, index) => ({
        id: String(index),
        passage: text,
        meta: { ...jevMeta(document), documentKey: document.docKey },
      })),
      relations,
    }),
  )
  return resolution.positions.map((position, index) => ({
    refs: position.itemIds.map((id) => top[Number(id)]?.document.path ?? ""),
    status: position.status,
    reason: position.reason,
    against: resolution.pairs
      .flatMap(({ positions: [a, b], label }) => {
        if (label !== "contradicts" && label !== "updates") return []
        if (a === index) return [{ position: b, label }]
        if (b === index) return [{ position: a, label }]
        return []
      })
      .filter(
        (entry, at, all) =>
          all.findIndex(
            (other) =>
              other.position === entry.position && other.label === entry.label,
          ) === at,
      ),
  }))
}

/** One result, with its "why" path: the parent chain from a seed. */
function relatedResult(node: TraversalNode): RelatedResult {
  const path: NonNullable<RelatedResult["path"]> = []
  for (let current = node; current.parent; current = current.parent.node)
    path.unshift({
      from: current.parent.node.document.path,
      to: current.document.path,
      predicate: current.parent.predicate,
      weight: round(current.parent.confidence),
    })
  const { document } = node
  return {
    ref: document.path,
    title: document.title || null,
    kind: document.kind || null,
    source: document.sourceType || "authored",
    updatedAt: document.observedAt.toISOString(),
    ...(document.summary
      ? { summary: truncateText(document.summary, 200) }
      : {}),
    score: round(node.pAnswers),
    depth: node.depth,
    path,
  }
}

/**
 * The walk of the chat graph tools from seed documents: the seeds, then up
 * to `maxDepth` layers of relations, at most `maxFanOut` relations of each
 * document (highest confidence first). It has no judge.
 */
async function expand(
  orgId: string,
  workspaceId: string,
  params: {
    seeds: string[]
    maxDepth?: number
    maxFanOut?: number
  },
): Promise<GraphExpansion> {
  const store = knowledgeStore()
  const scope = { orgId, workspaceIds: [workspaceId] }
  // The default of the old walk (`expandWorkspaceGraph`).
  const maxFanOut = params.maxFanOut ?? 50
  const seeds = await store.readDocuments(
    scope,
    params.seeds.map((docKey) => ({ workspaceId, docKey })),
  )
  const nodes = new Map<string, ExpandedNode>()
  const add = (document: KnowledgeDocument, depth: number) =>
    nodes.set(document.docKey, {
      id: document.docKey,
      kind: document.kind || "KnowledgeUnit",
      name: fileName(document.path),
      summary: document.summary || null,
      path: document.path || null,
      degree: 0,
      inDegree: 0,
      outDegree: 0,
      depth,
    })
  for (const seed of seeds)
    if (seed?.document.status === "active") add(seed.document, 0)
  const edges: ExpandedEdge[] = []
  const cappedHubs: string[] = []
  let frontier = [...nodes.keys()]
  for (
    let depth = 1;
    depth <= (params.maxDepth ?? 1) && frontier.length;
    depth++
  ) {
    const relations = await store.readFrontier(
      scope,
      frontier.map((docKey) => ({ workspaceId, docKey })),
      new Date(),
    )
    const next: string[] = []
    for (const docKey of frontier) {
      const node = nodes.get(docKey)
      const own = relations
        .filter(
          ({ direction, relation }) =>
            (direction === "out" ? relation.srcDoc : relation.dstDoc) ===
            docKey,
        )
        .sort((a, b) => b.relation.confidence - a.relation.confidence)
      if (node) {
        node.outDegree = own.filter((item) => item.direction === "out").length
        node.inDegree = own.length - node.outDegree
        node.degree = own.length
      }
      if (own.length > maxFanOut) cappedHubs.push(docKey)
      for (const { relation, neighbor } of own.slice(0, maxFanOut)) {
        if (neighbor?.status !== "active") continue
        edges.push({
          id: [
            relation.srcDoc,
            relation.srcChunk,
            relation.predicate,
            relation.dstDoc,
          ].join("\0"),
          sourceId: relation.srcDoc,
          targetId: relation.dstDoc,
          predicate: relation.predicate,
          confidence: relation.confidence,
          validFrom: relation.validFrom?.toISOString() ?? null,
          validTo: relation.validTo?.toISOString() ?? null,
          source: relation.source || null,
          lastObservedAt: relation.observedAt.toISOString(),
        })
        if (nodes.has(neighbor.docKey)) continue
        add(neighbor, depth)
        next.push(neighbor.docKey)
      }
    }
    frontier = next
  }
  return {
    nodes: [...nodes.values()],
    edges,
    partial: false,
    partialReason: null,
    cappedHubs,
  }
}
