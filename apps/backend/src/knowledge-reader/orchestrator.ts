import type {
  DocumentRef,
  FrontierRelation,
  KnowledgeDocument,
  KnowledgeRelation,
  KnowledgeReadScope,
  KnowledgeStore,
} from "../knowledge-store/knowledge-store.js"
import { judgeLayer } from "../retrieval/jev/layer-judge.js"

/*
 * The retrieval loop of ADR-068 decisions 2 and 3. From the seed documents,
 * each layer reads the relations of the frontier in both directions (one
 * ClickHouse query), reads the evidence of the new candidates (one query),
 * and asks Jev p(answers) and p(explore) for each candidate (one call for
 * each batch). The candidates with a high p(explore) are the next frontier.
 * The budgets are in code: depth, fan-out, time and the visited set.
 */

/** The defaults of the loop. The evals of ADR-069 tune them. */
export const ORCHESTRATOR_DEFAULTS = {
  /** D: the layers after the seeds. */
  maxDepth: 3,
  /** The candidates of one layer, at most. */
  fanOut: 50,
  /** The time of one retrieval, from the first read to the last judge. */
  timeBudgetMs: 3_000,
  /** The top results that the disagreement step compares (N). */
  disagreementItems: 10,
  /** A candidate is a result when p(answers) is at least this value. */
  keepAt: 0.5,
  /** The loop explores from a candidate when p(explore) is at least this. */
  exploreAt: 0.5,
  /** The chunks of each candidate that Jev reads: the closest to the query. */
  evidenceChunks: 2,
  /** The characters of evidence text of each candidate, at most. */
  evidenceChars: 1_500,
}

type OrchestratorSettings = typeof ORCHESTRATOR_DEFAULTS

/** The model calls of one retrieval, for the shadow log (no content). */
export type ModelMeter = {
  jevCalls: number
  jevCandidates: number
  embeddingCalls: number
}

/** The candidates that one Jev call takes (the `judgeLayer` default). */
const JEV_BATCH = 25

/** A document with the text that Jev reads for it. */
export type JudgeInput = {
  ref: DocumentRef
  document: KnowledgeDocument
  text: string
}

type Judgment = { pAnswers: number; pExplore: number }

/**
 * Judge `inputs` for `question` in one layer. Throws the `JevError` of a
 * failed call. An image goes to Jev as its metadata and its title only: the
 * backend does not read image bytes yet.
 */
export async function judge(
  inputs: readonly JudgeInput[],
  question: string,
  intent: string,
  timeoutMs: number,
  meter: ModelMeter,
): Promise<Judgment[]> {
  if (inputs.length === 0) return []
  meter.jevCalls += Math.ceil(inputs.length / JEV_BATCH)
  meter.jevCandidates += inputs.length
  const judged = await judgeLayer({
    question,
    intent,
    timeoutMs: Math.max(1, Math.floor(timeoutMs)),
    batchSize: JEV_BATCH,
    candidates: inputs.map(({ document, text }, index) => ({
      id: String(index),
      text,
      meta: {
        status: document.status,
        sourceType: document.sourceType || "authored",
        observedAt: document.observedAt.toISOString(),
        validFrom: document.validFrom?.toISOString() ?? null,
        validTo: document.validTo?.toISOString() ?? null,
        confidence: null,
      },
    })),
  })
  return inputs.map(
    (_, index) => judged.get(String(index)) ?? { pAnswers: 0, pExplore: 0 },
  )
}

/** The text of a candidate for Jev: its title, then its evidence chunks. */
export function evidenceText(
  document: KnowledgeDocument,
  chunks: readonly { text: string }[],
  maxChars: number,
): string {
  const body =
    document.kind === "image"
      ? `[image] ${document.path}`
      : chunks.map((chunk) => chunk.text).join("\n\n")
  return [document.title, body].filter(Boolean).join("\n\n").slice(0, maxChars)
}

/** One judged document of the traversal. */
export type TraversalNode = JudgeInput &
  Judgment & {
    /** 0 for a seed, else the layer that found the document. */
    depth: number
    /** The relation that found it, from its parent. Null for a seed. */
    parent: {
      node: TraversalNode
      predicate: string
      confidence: number
    } | null
  }

/** Which relations the loop follows. */
type WalkFilter = {
  direction: "out" | "in" | "both"
  /** Upper case. Undefined: each predicate except `skipUnlessNamed`. */
  predicates?: ReadonlySet<string>
  /** Upper case. Never follow these. */
  excludePredicates: ReadonlySet<string>
  /** Upper case. Followed only when `predicates` names it. */
  skipUnlessNamed: ReadonlySet<string>
  minConfidence: number
  /** The relations of one frontier document that the loop follows. */
  maxFanOut: number
  validAt: Date | null
}

type Traversal = {
  /** Each judged document, in the order of the layers. */
  nodes: TraversalNode[]
  /** Each relation that the layers read. */
  relations: KnowledgeRelation[]
  explored: { nodes: number; edges: number }
  partialReason?: "total_timeout"
  /** Frontier documents with more relations than `maxFanOut`. */
  cappedHubs: KnowledgeDocument[]
}

const refKey = (ref: DocumentRef) =>
  JSON.stringify([ref.workspaceId, ref.docKey])

/**
 * The layers after the seeds, up to `maxDepth` (at most D). Each seed is
 * explored. With `judgeSeeds`, the seeds are judged first, as layer 0.
 * A failure of a Jev call throws its `JevError`.
 */
export async function traverse(input: {
  store: KnowledgeStore
  /** The `performance.now()` time at which the retrieval must end. */
  deadline: number
  scope: KnowledgeReadScope
  question: string
  intent: string
  vector: number[]
  seeds: readonly JudgeInput[]
  judgeSeeds: boolean
  maxDepth: number
  walk: WalkFilter
  meter: ModelMeter
  settings?: OrchestratorSettings
}): Promise<Traversal> {
  const settings = input.settings ?? ORCHESTRATOR_DEFAULTS
  const left = () => input.deadline - performance.now()
  const judgeAll = async (layer: JudgeInput[]) =>
    judge(layer, input.question, input.intent, left(), input.meter)

  const seedNodes: TraversalNode[] = input.seeds.map((seed) => ({
    ...seed,
    pAnswers: 0,
    pExplore: 1,
    depth: 0,
    parent: null,
  }))
  const nodes: TraversalNode[] = []
  if (input.judgeSeeds) {
    const judged = await judgeAll(seedNodes)
    seedNodes.forEach((node, index) => {
      node.pAnswers = judged[index]?.pAnswers ?? 0
    })
    nodes.push(...seedNodes)
  }
  const visited = new Set(seedNodes.map((node) => refKey(node.ref)))
  const cappedHubs: KnowledgeDocument[] = []
  const read: KnowledgeRelation[] = []
  let frontier = seedNodes
  let partialReason: Traversal["partialReason"]

  for (
    let depth = 1;
    depth <= Math.min(input.maxDepth, settings.maxDepth) && frontier.length;
    depth++
  ) {
    if (left() <= 0) {
      partialReason = "total_timeout"
      break
    }
    const byKey = new Map(frontier.map((node) => [refKey(node.ref), node]))
    const relations = await input.store.readFrontier(
      input.scope,
      frontier.map((node) => node.ref),
      input.walk.validAt,
    )
    read.push(...relations.map((item) => item.relation))
    const candidates = layerCandidates(relations, byKey, visited, input.walk)
    cappedHubs.push(...candidates.capped.map((node) => node.document))
    const layer = candidates.picked.slice(0, settings.fanOut)
    if (layer.length === 0) break
    for (const candidate of layer) visited.add(refKey(candidate.ref))
    if (left() <= 0) {
      partialReason = "total_timeout"
      break
    }
    const evidence = await input.store.readEvidence(
      input.scope,
      layer.map((candidate) => candidate.ref),
      input.vector,
      settings.evidenceChunks,
    )
    const chunksOf = new Map(
      evidence.map((item) => [
        refKey({
          workspaceId: item.workspaceId,
          docKey: item.document.docKey,
        }),
        item.chunks,
      ]),
    )
    const inputs = layer.map((candidate) => ({
      ...candidate,
      text: evidenceText(
        candidate.document,
        chunksOf.get(refKey(candidate.ref)) ?? [],
        settings.evidenceChars,
      ),
    }))
    const judged = await judgeAll(inputs)
    const layerNodes = inputs.map((candidate, index): TraversalNode => ({
      ref: candidate.ref,
      document: candidate.document,
      text: candidate.text,
      pAnswers: judged[index]?.pAnswers ?? 0,
      pExplore: judged[index]?.pExplore ?? 0,
      depth,
      parent: candidate.parent,
    }))
    nodes.push(...layerNodes)
    frontier = layerNodes.filter((node) => node.pExplore >= settings.exploreAt)
  }
  return {
    nodes,
    relations: read,
    explored: { nodes: visited.size, edges: read.length },
    ...(partialReason ? { partialReason } : {}),
    cappedHubs,
  }
}

/**
 * The new documents that the relations of a frontier reach. A document that
 * two relations reach keeps the one with the higher confidence. The
 * candidates are in the order of their confidence, highest first.
 */
function layerCandidates(
  relations: readonly FrontierRelation[],
  frontier: ReadonlyMap<string, TraversalNode>,
  visited: ReadonlySet<string>,
  walk: WalkFilter,
): {
  picked: (Omit<JudgeInput, "text"> & {
    parent: NonNullable<TraversalNode["parent"]>
  })[]
  capped: TraversalNode[]
} {
  const perNode = new Map<TraversalNode, FrontierRelation[]>()
  for (const item of relations) {
    const { relation, direction, neighbor } = item
    const predicate = relation.predicate.toUpperCase()
    const from = frontier.get(
      refKey({
        workspaceId: item.workspaceId,
        docKey: direction === "out" ? relation.srcDoc : relation.dstDoc,
      }),
    )
    if (
      !from ||
      !neighbor ||
      neighbor.status !== "active" ||
      (walk.direction !== "both" && walk.direction !== direction) ||
      relation.confidence < walk.minConfidence ||
      walk.excludePredicates.has(predicate) ||
      (walk.predicates
        ? !walk.predicates.has(predicate)
        : walk.skipUnlessNamed.has(predicate)) ||
      visited.has(
        refKey({ workspaceId: item.workspaceId, docKey: neighbor.docKey }),
      )
    )
      continue
    const list = perNode.get(from) ?? []
    list.push(item)
    perNode.set(from, list)
  }
  const best = new Map<
    string,
    Omit<JudgeInput, "text"> & {
      parent: NonNullable<TraversalNode["parent"]>
    }
  >()
  const capped: TraversalNode[] = []
  for (const [node, list] of perNode) {
    list.sort((a, b) => b.relation.confidence - a.relation.confidence)
    if (list.length > walk.maxFanOut) capped.push(node)
    for (const { workspaceId, relation, neighbor } of list.slice(
      0,
      walk.maxFanOut,
    )) {
      if (!neighbor) continue
      const ref = { workspaceId, docKey: neighbor.docKey }
      const key = refKey(ref)
      const current = best.get(key)
      if (current && current.parent.confidence >= relation.confidence) continue
      best.set(key, {
        ref,
        document: neighbor,
        parent: {
          node,
          predicate: relation.predicate,
          confidence: relation.confidence,
        },
      })
    }
  }
  return {
    picked: [...best.values()].sort(
      (a, b) =>
        b.parent.confidence - a.parent.confidence ||
        a.document.path.localeCompare(b.document.path),
    ),
    capped,
  }
}
