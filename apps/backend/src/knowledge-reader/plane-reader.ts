import { parseEnv } from "../config/env.js"
import {
  CONNECTOR_MIRROR_ROOTS,
  connectorMirrorRoot,
} from "../domain/codeIngestion/connectorMirrorPaths.js"
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
  type RelatedClaim,
  type RelatedResult,
  round,
  unknownRefError,
} from "../domain/workspaces/related-ranking.js"
import { workspaceGraphFromSignals } from "../domain/workspaces/workspace-graph.js"
import {
  createKnowledgeStore,
  type DocumentRef,
  documentId,
  type FrontierRelation,
  type KnowledgeDocument,
  type KnowledgeReadScope,
  type KnowledgeRelation,
  type KnowledgeStore,
} from "../knowledge-store/knowledge-store.js"
import {
  isRetryableFetchFailure,
  TransientHttpError,
} from "../lib/withTransientHttpRetry.js"
import { truncateText } from "../mcp/framework/budget.js"
import { checkPath } from "../mcp/framework/refs.js"
import { McpToolError } from "../mcp/framework/tool-errors.js"
import type { KnowledgeHead } from "../models/knowledge-state.js"
import {
  EmbeddingError,
  embedQuery,
} from "../retrieval/embeddings/textEmbeddings.js"
import { JevError } from "../retrieval/jev/client.js"
import {
  askDisagreementFacts,
  type DisagreementFacts,
  disagreementCalls,
  type EvidenceItem,
  readDisagreements,
} from "../retrieval/jev/disagreement.js"
import { BudgetSpentError, notePartial } from "./failure.js"
import type {
  KnowledgeReader,
  RelatedRequest,
  SearchRequest,
  SearchResult,
} from "./knowledge-reader.js"
import {
  beforeDeadline,
  callTimeLimitMs,
  evidenceText,
  isBudgetSpent,
  judge,
  type ModelMeter,
  ORCHESTRATOR_DEFAULTS,
  overlaps,
  retrievalDeadline,
  type TraversalNode,
  traverse,
  type WalkFilter,
} from "./orchestrator.js"
import { queryVector } from "./query-vectors.js"

/*
 * The knowledge plane (ADR-066 and ADR-068): ClickHouse reads, the Jev
 * layer judge and the query embedding. The output has the shapes
 * of the old stack, so the tools do not change.
 */

let opened: KnowledgeStore | undefined

/** The store of `CLICKHOUSE_URL` (the reader user), opened on first use. */
export function knowledgeStore(): KnowledgeStore {
  opened ??= createKnowledgeStore(parseEnv(process.env).CLICKHOUSE_URL)
  return opened
}

/**
 * The plane reader of one request. `heads` is the served head of each
 * Workspace (ADR-071 decision 4). `meter` counts the model calls.
 */
export function planeKnowledgeReader(input: {
  heads: ReadonlyMap<string, KnowledgeHead>
  meter?: ModelMeter
}): KnowledgeReader {
  /** The read scope of `workspaceIds`, with the head of each one. */
  const scopeOf = (
    orgId: string,
    workspaceIds: readonly string[],
  ): KnowledgeReadScope => ({
    orgId,
    heads: workspaceIds.map((workspaceId) => {
      const head = input.heads.get(workspaceId)
      if (!head)
        throw new Error(
          `The Workspace ${workspaceId} has no head on the knowledge plane`,
        )
      return { workspaceId, ...head }
    }),
  })
  const meter = input.meter ?? {
    jevCalls: 0,
    jevCandidates: 0,
    embeddingCalls: 0,
  }
  // A kept vector of the same org and text needs no call (`queryVector`).
  const embed = (orgId: string, text: string) =>
    queryVector(orgId, text, async () => {
      meter.embeddingCalls += 1
      try {
        return await embedQuery(text)
      } catch (error) {
        // A retry does not fit in the time budget (ADR-068 decision 7). Thus
        // a 429, a 5xx or a network error ends the budget, and the call
        // returns partial, as when the budget ends.
        if (isRetryableFetchFailure(error))
          throw new BudgetSpentError("The query embedding failed", {
            // The status only: the shadow log gives the cause of the
            // partial answer.
            cause: new EmbeddingError(
              "The query embedding failed",
              error instanceof TransientHttpError ? error.status : undefined,
            ),
          })
        throw error
      }
    })
  return {
    stack: "plane",
    search: (request) =>
      search(
        request,
        scopeOf(request.orgId, request.workspaceIds),
        input.heads,
        embed,
        meter,
      ),
    related: (request) =>
      related(
        request,
        scopeOf(request.org.id, [request.workspace.id]),
        embed,
        meter,
      ),
    graph: async ({ orgId, workspaceId }) => {
      // The graph view shows at most 5,000 documents and relations.
      const graph = await knowledgeStore().readGraph(
        scopeOf(orgId, [workspaceId]),
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
      expand(scopeOf(orgId, [workspaceId]), workspaceId, params),
  }
}

/** The source of a path outside the connector mirror roots. */
const AUTHORED = "authored"

/**
 * The `source` of a result, as the old stack gives it: the connector mirror
 * root of the path, else `authored`. The `source_type` of the plane is the
 * authority kind of the source (CTX-1410), which only Jev reads.
 */
function sourceOf({ path }: { path: string }): string {
  return connectorMirrorRoot(path) ?? AUTHORED
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
 * (Jev orders the hits by p(answers)). A hit that is not valid at `validAt`
 * (or now) comes after the valid hits. When Jev fails, the hits keep the
 * search order and the result says `judge_unavailable`. When the time
 * budget ends during the judge, they keep the search order and the result
 * says `total_timeout`; when it ends before the search ends, there are no
 * hits.
 */
async function search(
  request: SearchRequest,
  scope: KnowledgeReadScope,
  heads: ReadonlyMap<string, KnowledgeHead>,
  embed: (orgId: string, text: string) => Promise<number[]>,
  meter: ModelMeter,
): Promise<SearchResult> {
  const query = request.query.trim()
  if (!query || request.workspaceIds.length === 0) return { hits: [] }
  const queryTime = request.validAt ?? request.now ?? new Date()
  const deadline = retrievalDeadline()
  const store = knowledgeStore()
  // The store applies each filter before it cuts the candidates. With no
  // time left for the search itself, there is no hit to give. The store
  // gets the query vector as a promise, so that its lexical query runs
  // while the embedding call is on its way (CTX-1576). The neighbors of the
  // best hits take the last places of the hits (CTX-1605). When the time
  // budget ends during the read of the neighbors only, the hits stay
  // without them.
  let found: SearchHits
  const neighborsEnd = new AbortController()
  try {
    found = await beforeDeadline(
      deadline,
      () =>
        store.search(scope, {
          vector: beforeDeadline(deadline, () => embed(scope.orgId, query)),
          terms: queryTerms(query),
          kinds: request.kinds ? [...request.kinds] : undefined,
          pathPrefix: request.pathPrefix,
          sources: request.sources ? [...request.sources] : undefined,
          observedAfter: request.updatedAfter ?? null,
          validAt: request.validAt ?? null,
          chunksPerDocument: ORCHESTRATOR_DEFAULTS.evidenceChunks,
          neighbors: {
            from: ORCHESTRATOR_DEFAULTS.searchNeighborsFrom,
            places: ORCHESTRATOR_DEFAULTS.searchNeighbors,
            signal: neighborsEnd.signal,
          },
        }),
      () => neighborsEnd.abort(),
    )
  } catch (error) {
    if (!isBudgetSpent(error, deadline)) throw error
    notePartial(meter, error)
    return { hits: [], partialReason: "total_timeout" }
  }
  const limit = Math.min(Math.max(Math.trunc(request.limit ?? 10), 1), 50)
  const inputs = found.map((hit) => ({
    ref: refOf(hit),
    document: hit.document,
    text: evidenceText(hit.document, hit.chunks),
  }))
  // A Jev failure or the end of the time budget keeps the search order.
  let unjudged: SearchResult["partialReason"]
  const [judged, relations] = await Promise.all([
    judge(inputs, query, "search", deadline, meter).catch((error: unknown) => {
      // A Jev timeout is the end of the budget: Jev gets the rest of it.
      if (isBudgetSpent(error, deadline)) unjudged = "total_timeout"
      else if (error instanceof JevError) unjudged = "judge_unavailable"
      else throw error
      notePartial(meter, error)
      return null
    }),
    // The claims of the hits: their out-relations only (CTX-1688). With no
    // time left, the hits have none.
    beforeDeadline(deadline, () =>
      store.readFrontier(
        scope,
        inputs.map((input) => input.ref),
        request.validAt ?? null,
        "out",
      ),
    ).catch((error: unknown) => {
      if (!isBudgetSpent(error, deadline)) throw error
      return []
    }),
  ])
  const claimsOf = claimsByDocument(relations)
  const hits = found.flatMap(
    (hit, index): (KnowledgeHit & { order: number; valid: boolean })[] => {
      const chunk = hit.chunks[0]
      const sha = heads.get(hit.workspaceId)?.sha
      if (!chunk || !sha) return []
      return [
        {
          order: index,
          valid: isValidAt(hit.document, queryTime),
          workspaceId: hit.workspaceId,
          unitId: hit.document.docKey,
          path: hit.document.path,
          kind: hit.document.kind || null,
          title: hit.document.title || null,
          source: sourceOf(hit.document),
          updatedAt: hit.document.observedAt,
          projectionSha: sha,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text,
          claims: claimsOf.get(documentId(refOf(hit))) ?? [],
          score: judged ? (judged[index]?.pAnswers ?? 0) : chunk.score,
        },
      ]
    },
  )
  // The valid hits first: the validity reaches the order through code, not
  // through Jev. Then Jev's order, with the search order between equal
  // probabilities.
  hits.sort(
    (a, b) =>
      Number(b.valid) - Number(a.valid) ||
      b.score - a.score ||
      a.order - b.order,
  )
  return {
    hits: hits
      .slice(0, limit)
      .map(({ order: _order, valid: _valid, ...hit }) => hit),
    ...(unjudged ? { partialReason: unjudged } : {}),
  }
}

type SearchHits = Awaited<ReturnType<KnowledgeStore["search"]>>

/** The document of a search hit. */
const refOf = (hit: SearchHits[number]): DocumentRef => ({
  workspaceId: hit.workspaceId,
  docKey: hit.document.docKey,
})

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

/** True when the span is valid at `at`. An unknown bound is open. */
function isValidAt(
  span: { validFrom: Date | null; validTo: Date | null },
  at: Date,
): boolean {
  return (
    (!span.validFrom || span.validFrom <= at) &&
    (!span.validTo || at < span.validTo)
  )
}

/**
 * `get_related`: layer 0 judges the seeds, then up to D layers of the loop.
 * A result is a judged document with p(answers) of at least the `keepAt`
 * setting (a seed only with `includeSeeds`), or a step: a document on the
 * "why" path of such a result, or one with p(explore) of at least the
 * `exploreAt` setting (not a seed); p(answers) is its score. Then the
 * claims between the top results that answer: their stored relations, and
 * the readings of the disagreement step (ADR-068 decision 4). When the time
 * budget ends, the result is partial, with `total_timeout` and no claims.
 * When Jev fails, the call fails with `judge_unavailable`.
 */
async function related(
  { workspace, input }: RelatedRequest,
  scope: KnowledgeReadScope,
  embed: (orgId: string, text: string) => Promise<number[]>,
  meter: ModelMeter,
): Promise<Ranking> {
  const deadline = retrievalDeadline()
  const store = knowledgeStore()
  const paths = [...new Set(input.seeds.map((ref) => checkPath(ref, ref)))]
  const question =
    input.query ??
    `Which knowledge is related to ${paths.join(", ")}? The kind of question: ${input.intent}.`
  const seedRefs = paths.map((path) => ({
    workspaceId: workspace.id,
    docKey: servingIdForKnowledgePath(workspace.id, path),
  }))
  const upper = (values: readonly string[] | undefined) =>
    values && new Set(values.map((value) => value.toUpperCase()))
  const walk = {
    direction: input.direction,
    predicates: upper(input.predicates),
    excludePredicates: upper(input.excludePredicates) ?? new Set<string>(),
    // As on the old stack, only the provenance intent or named
    // predicates walk to a source (ADR-051 section 6).
    skipUnlessNamed: new Set(
      input.intent === "provenance" ? [] : [FROM_SOURCE_PREDICATE],
    ),
    minConfidence: input.minConfidence,
    maxFanOut: input.maxFanOut,
    validAt: input.validBetween ? null : new Date(input.validAt ?? Date.now()),
    ...(input.validBetween
      ? {
          validBetween: {
            from: new Date(input.validBetween.from),
            to: new Date(input.validBetween.to),
          },
        }
      : {}),
  }
  // The seeds are the first frontier, so their relations need no vector and
  // no judge: the read starts with the query embedding (CTX-1535).
  const seedRelations = beforeDeadline(deadline, () =>
    store.readFrontier(scope, seedRefs, walk.validAt),
  )
  // The traversal awaits it; a call that ends before (an unknown seed, the
  // end of the budget) must not leave an unhandled rejection.
  seedRelations.catch(() => {})
  let vector: number[]
  let evidence: Awaited<ReturnType<KnowledgeStore["readEvidence"]>>
  let bridge: ReturnType<typeof bridgeDocuments>
  try {
    vector = await beforeDeadline(deadline, () => embed(scope.orgId, question))
    bridge = bridgeDocuments(store, scope, vector, paths, walk, deadline)
    // The traversal awaits it; a call that ends before must not leave an
    // unhandled rejection.
    bridge.catch(() => {})
    evidence = await beforeDeadline(deadline, () =>
      store.readEvidence(
        scope,
        seedRefs,
        vector,
        ORCHESTRATOR_DEFAULTS.evidenceChunks,
      ),
    )
  } catch (error) {
    if (!isBudgetSpent(error, deadline)) throw error
    notePartial(meter, error)
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
  let traversal: Awaited<ReturnType<typeof traverse>>
  let results: TraversalNode[]
  let claims: RelatedClaim[] | undefined
  const keepsKind = kindFilter(input)
  // A document that can be a result: not a seed (unless `includeSeeds`),
  // and of a kind that the call keeps.
  const canAnswer = (node: TraversalNode) =>
    (node.depth > 0 || input.includeSeeds) && keepsKind(node)
  const { disagreementItems } = ORCHESTRATOR_DEFAULTS
  // The facts of the disagreement step and the relations between the top
  // results, asked with the judge of the last layer: see `onLastLayer`
  // below.
  let earlyFacts: Promise<DisagreementFacts> | undefined
  let earlyRelations: Promise<KnowledgeRelation[]> | undefined
  const readRelations = (nodes: readonly TraversalNode[]) =>
    relationsBetween(store, scope, nodes, walk, deadline)
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
      seedRelations,
      bridge,
      maxDepth: input.maxDepth,
      walk,
      meter,
      // The top answers come only from the answers that Jev judged before
      // the last layer and from the documents of the last judge. When these
      // are at most `disagreementItems`, the top answers are some of them.
      // Thus Jev can give the facts of all of them in the round of the last
      // judge, and the step after the walk makes no Jev call. Only the
      // facts of the top answers are used. When there are more, the facts
      // are asked after the walk, for the top answers only.
      onLastLayer: (judged, pending) => {
        const possible = [
          ...answerNodes(judged, canAnswer).slice(0, disagreementItems),
          ...pending.filter(canAnswer),
        ]
        if (possible.length > 0 && possible.length <= disagreementItems) {
          earlyFacts = askFacts(question, possible, deadline, meter)
          earlyRelations = readRelations(possible)
        }
      },
    })
    const answers = answerNodes(traversal.nodes, canAnswer)
    results = withSteps(answers, traversal.nodes, keepsKind)
    const top = answers.slice(0, disagreementItems)
    if (top.length > 0 && !traversal.partialReason)
      claims = await topClaims(
        top,
        deadline,
        earlyFacts ?? askFacts(question, top, deadline, meter),
        earlyRelations ?? readRelations(top),
      ).catch((error: unknown) => {
        // The end of the budget gives the ranking with no claims.
        if (!isBudgetSpent(error, deadline)) throw error
        notePartial(meter, error)
        traversal.partialReason = "total_timeout"
        return undefined
      })
  } catch (error) {
    if (!(error instanceof JevError)) throw error
    throw new McpToolError(
      "judge_unavailable",
      "The relevance judge did not answer, so get_related has no ranking. Try again later, or use search_knowledge.",
      { cause: error },
    )
  }
  return {
    results: results.map(relatedResult),
    ...(claims ? { claims } : {}),
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
 * The bridge to other sources (`bridgeItems`): the documents of the sources
 * of no seed that are closest to `vector`, best first. An issue often has
 * no relation to the code or the design that it is about, and a code
 * document has no relation to the issues about it. The search of the store
 * with no query terms orders only by vector, and it needs no model call.
 * The bridge follows no relation, so a walk of named predicates, of one
 * direction or of a time window has no bridge.
 */
function bridgeDocuments(
  store: KnowledgeStore,
  scope: KnowledgeReadScope,
  vector: number[],
  seeds: readonly string[],
  walk: Pick<
    WalkFilter,
    "direction" | "predicates" | "validAt" | "validBetween"
  >,
  deadline: number,
): Promise<{ ref: DocumentRef; document: KnowledgeDocument }[]> {
  const items = ORCHESTRATOR_DEFAULTS.bridgeItems
  if (
    items <= 0 ||
    walk.direction !== "both" ||
    walk.predicates ||
    walk.validBetween
  )
    return Promise.resolve([])
  const seedSources = new Set(seeds.map((path) => sourceOf({ path })))
  const sources = [...CONNECTOR_MIRROR_ROOTS, AUTHORED].filter(
    (source) => !seedSources.has(source),
  )
  // No sources is no filter for the store, so it gives no bridge.
  if (sources.length === 0) return Promise.resolve([])
  return beforeDeadline(deadline, () =>
    store.search(scope, {
      vector,
      terms: [],
      sources,
      validAt: walk.validAt,
      chunksPerDocument: 1,
    }),
  ).then((hits) =>
    hits.slice(0, items).map((hit) => ({
      ref: { workspaceId: hit.workspaceId, docKey: hit.document.docKey },
      document: hit.document,
    })),
  )
}

/**
 * The judged documents that answer (p(answers) of at least `keepAt`) and
 * `canAnswer` accepts, best first.
 */
function answerNodes(
  nodes: readonly TraversalNode[],
  canAnswer: (node: TraversalNode) => boolean,
): TraversalNode[] {
  return nodes
    .filter(
      (node) =>
        node.pAnswers >= ORCHESTRATOR_DEFAULTS.keepAt && canAnswer(node),
    )
    .sort(byScore)
}

/**
 * The results: the answers, best first, each with the documents on its
 * "why" path that are not seeds and pass the kind filters (CTX-1520). A step
 * does not answer the question, but the traversal went through it to reach
 * an answer, so the caller gets the chain. The `RANKED_LIMIT` applies to an
 * answer and its steps together: an answer whose new steps do not fit ends
 * the results, so that no kept answer loses a step. The cut is strictly by
 * rank: no answer after it is a result, also when it would fit.
 *
 * Then, while they fit, the other steps: each document that is not a seed,
 * passes the kind filters, and has a p(explore) of at least `exploreAt`
 * (CTX-1534). Jev judged that the search must explore from such a
 * document to answer the question, so it is a needed step, also when no
 * answer comes after it. Each step on a "why" path also has such a
 * p(explore), because only these documents are the frontier after layer 1.
 * Thus the walk of the "why" paths changes the results only at the
 * `RANKED_LIMIT`: there, it keeps the full chain of each kept answer.
 *
 * The results are in the order of their score. A step keeps its own
 * p(answers) as its score, which is below `keepAt`, so each step comes
 * after each answer.
 */
function withSteps(
  answers: readonly TraversalNode[],
  nodes: readonly TraversalNode[],
  keepsKind: (node: TraversalNode) => boolean,
): TraversalNode[] {
  const kept = new Set<TraversalNode>()
  for (const answer of answers) {
    const chain = [answer]
    for (let step = answer.parent?.node; step; step = step.parent?.node)
      if (step.depth > 0 && keepsKind(step)) chain.push(step)
    const added = chain.filter((node) => !kept.has(node))
    if (kept.size + added.length > RANKED_LIMIT) return [...kept].sort(byScore)
    for (const node of added) kept.add(node)
  }
  const steps = nodes
    .filter(
      (node) =>
        node.depth > 0 &&
        node.pExplore >= ORCHESTRATOR_DEFAULTS.exploreAt &&
        !kept.has(node) &&
        keepsKind(node),
    )
    .sort(byScore)
  for (const step of steps.slice(0, RANKED_LIMIT - kept.size)) kept.add(step)
  return [...kept].sort(byScore)
}

/** True for a node whose kind passes the kind filters of the call. */
function kindFilter(
  input: RelatedRequest["input"],
): (node: TraversalNode) => boolean {
  const keptKinds = input.kinds?.length
    ? new Set(input.kinds.map(kindKey))
    : null
  const droppedKinds = new Set((input.excludeKinds ?? []).map(kindKey))
  return (node) => {
    const kind = kindKey(node.document.kind)
    return (!keptKinds || keptKinds.has(kind)) && !droppedKinds.has(kind)
  }
}

/** Best first: p(answers), then the nearer layer, then the path. */
function byScore(a: TraversalNode, b: TraversalNode): number {
  return (
    b.pAnswers - a.pAnswers ||
    a.depth - b.depth ||
    a.document.path.localeCompare(b.document.path)
  )
}

/**
 * A judged document as an item of the disagreement step. Its path is its
 * id: the documents of one call are in one Workspace.
 */
function evidenceItem({ document, text }: TraversalNode): EvidenceItem {
  return { id: document.path, passage: text }
}

/**
 * Ask Jev the disagreement facts of `nodes` (ADR-068 decision 4), before
 * `deadline`. The caller awaits the result later, so a failure is not an
 * unhandled rejection until then.
 */
function askFacts(
  question: string,
  nodes: readonly TraversalNode[],
  deadline: number,
  meter: ModelMeter,
): Promise<DisagreementFacts> {
  const calls = disagreementCalls(nodes.length)
  meter.jevCalls += calls
  if (calls > 0) meter.jevCandidates += nodes.length
  const facts = beforeDeadline(deadline, () =>
    askDisagreementFacts({
      question,
      items: nodes.map(evidenceItem),
      timeoutMs: callTimeLimitMs(deadline),
    }),
  )
  facts.catch(() => {})
  return facts
}

/**
 * The out-relations of `nodes` that pass the time filter of the `walk`,
 * read before `deadline`. Each relation between two of the nodes is an
 * out-relation of one of them, so fewer than two nodes need no read. The
 * caller awaits the result later, so a failure is not an unhandled
 * rejection until then.
 */
function relationsBetween(
  store: KnowledgeStore,
  scope: KnowledgeReadScope,
  nodes: readonly TraversalNode[],
  walk: Pick<WalkFilter, "validAt" | "validBetween">,
  deadline: number,
): Promise<KnowledgeRelation[]> {
  if (nodes.length < 2) return Promise.resolve([])
  const { validAt, validBetween } = walk
  const relations = beforeDeadline(deadline, () =>
    store.readFrontier(
      scope,
      nodes.map(({ ref }) => ref),
      validAt,
      "out",
    ),
  ).then((read) =>
    read
      .map(({ relation }) => relation)
      .filter((relation) => !validBetween || overlaps(relation, validBetween)),
  )
  relations.catch(() => {})
  return relations
}

/**
 * The claims between the `top` results (ADR-068 decision 4): each stored
 * relation from one top result to another, then the readings of the
 * disagreement step. `facts` are the facts, and `relations` the
 * out-relations, of a set of documents that holds the top results
 * (`askFacts`, `relationsBetween`). A Jev failure throws its `JevError`.
 */
async function topClaims(
  top: readonly TraversalNode[],
  deadline: number,
  facts: Promise<DisagreementFacts>,
  relations: Promise<readonly KnowledgeRelation[]>,
): Promise<RelatedClaim[]> {
  const { sameAt, disagreeAt, replacesAt, scopedAt } = ORCHESTRATOR_DEFAULTS
  const pathOf = new Map(
    top.map(({ document }) => [document.docKey, document.path]),
  )
  // A frontier read can give one relation more than one time (one row for
  // each chunk), so equal claims are kept once.
  const edges = new Map<string, RelatedClaim>()
  for (const relation of await beforeDeadline(deadline, () => relations)) {
    const from = pathOf.get(relation.srcDoc)
    const to = pathOf.get(relation.dstDoc)
    if (from === undefined || to === undefined || from === to) continue
    const claim: RelatedClaim = {
      from,
      to,
      predicate: relation.predicate,
      by: "edge",
      source: relation.source,
      validFrom: relation.validFrom?.toISOString() ?? null,
      validTo: relation.validTo?.toISOString() ?? null,
      confidence: round(relation.confidence),
    }
    edges.set(JSON.stringify(claim), claim)
  }
  const readings = readDisagreements({
    items: top.map(evidenceItem),
    facts: await beforeDeadline(deadline, () => facts),
    thresholds: { sameAt, disagreeAt, replacesAt, scopedAt },
  })
  return [
    ...edges.values(),
    ...readings.map((reading): RelatedClaim => ({
      ...reading,
      by: "reading",
      confidence: round(reading.confidence),
    })),
  ]
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
    source: sourceOf(document),
    ...(document.sourceType ? { sourceType: document.sourceType } : {}),
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
  scope: KnowledgeReadScope,
  workspaceId: string,
  params: {
    seeds: string[]
    maxDepth?: number
    maxFanOut?: number
  },
): Promise<GraphExpansion> {
  const store = knowledgeStore()
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
