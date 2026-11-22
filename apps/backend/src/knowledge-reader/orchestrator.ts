import {
  type DocumentRef,
  documentId,
  type FrontierRelation,
  type KnowledgeDocument,
  type KnowledgeRelation,
  type KnowledgeReadScope,
  type KnowledgeStore,
} from "../knowledge-store/knowledge-store.js"
import { JevError } from "../retrieval/jev/client.js"
import { judgeLayer } from "../retrieval/jev/layer-judge.js"
import type { CandidateMeta } from "../retrieval/jev/state.js"

/*
 * The retrieval loop of ADR-068 decisions 2 and 3. Layer 0 judges the seed
 * documents, and all seeds are the first frontier: the caller named them to
 * traverse from them. Then each layer reads the relations of the frontier in
 * both directions (one ClickHouse query), reads the evidence of the new
 * candidates (one query), and asks Jev p(answers) and p(explore) for each
 * candidate (one call for each batch). The candidates with a high
 * p(explore) are the next frontier. The budgets are in code: depth, fan-out,
 * time and the visited set.
 */

/** The defaults of the loop. The evals of ADR-069 tune them. */
export const ORCHESTRATOR_DEFAULTS = {
  /** D: the layers after the seeds. */
  maxDepth: 3,
  /** The candidates of one layer, at most. */
  fanOut: 50,
  /**
   * The time of one retrieval, from the first read to the last judge. 0: no
   * time budget. Only the evals use 0, so that a slow step does not hide
   * what the loop finds (the CTO, 2026-11-22).
   */
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
  /**
   * The disagreement step reads a Jev fact as "yes" when its p(yes) is at
   * least this value: same part of the question, disagree, changes or
   * replaces, and applies only to a part of the question (ADR-068
   * decision 4).
   */
  sameAt: 0.5,
  disagreeAt: 0.5,
  replacesAt: 0.5,
  scopedAt: 0.5,
}

/** The model calls of one retrieval, for the shadow log (no content). */
export type ModelMeter = {
  jevCalls: number
  jevCandidates: number
  embeddingCalls: number
}

/** The candidates that one Jev call takes (the `judgeLayer` default). */
const JEV_BATCH = 25

/** The time budget of a retrieval ended before a step could start or end. */
export class BudgetSpentError extends Error {
  override readonly name = "BudgetSpentError"
}

/**
 * The `performance.now()` time at which a retrieval that starts now must
 * end, from `timeBudgetMs`. With no time budget, `Infinity`.
 */
export function retrievalDeadline(): number {
  const budget = ORCHESTRATOR_DEFAULTS.timeBudgetMs
  return budget > 0 ? performance.now() + budget : Number.POSITIVE_INFINITY
}

/**
 * The time limit of one model call before `deadline`. With no time budget,
 * undefined: the call keeps the time limit of its client.
 */
export function callTimeLimitMs(deadline: number): number | undefined {
  return Number.isFinite(deadline)
    ? Math.max(1, Math.floor(deadline - performance.now()))
    : undefined
}

/**
 * `step`, or `BudgetSpentError` when `deadline` (a `performance.now()` time)
 * comes first. A step that the deadline stops goes on in the background,
 * and its own time limit ends it. With no time budget, `step` alone.
 */
export async function beforeDeadline<T>(
  deadline: number,
  step: () => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(deadline)) return step()
  const left = deadline - performance.now()
  if (left <= 0) throw new BudgetSpentError("The time budget is spent")
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      step(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new BudgetSpentError("The time budget is spent")),
          left,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * True for the end of the time budget: the deadline, or a Jev call that
 * timed out (each Jev call gets the rest of the budget as its time limit).
 */
export function isBudgetSpent(error: unknown): boolean {
  return (
    error instanceof BudgetSpentError ||
    (error instanceof JevError && error.kind === "timeout")
  )
}

/** A document with the text that Jev reads for it. */
export type JudgeInput = {
  ref: DocumentRef
  document: KnowledgeDocument
  text: string
}

type Judgment = { pAnswers: number; pExplore: number }

/** The metadata of a document that Jev reads with its text. */
export function jevMeta(document: KnowledgeDocument): CandidateMeta {
  return {
    status: document.status,
    sourceType: document.sourceType,
    observedAt: document.observedAt.toISOString(),
    validFrom: document.validFrom?.toISOString() ?? null,
    validTo: document.validTo?.toISOString() ?? null,
    confidence: null,
  }
}

/**
 * Judge `inputs` for `question` in one layer, before `deadline`. Throws the
 * `JevError` of a failed call. Jev reads only text: an image goes to Jev as
 * its text, never as its bytes (ADR-068 decision 6).
 */
export async function judge(
  inputs: readonly JudgeInput[],
  question: string,
  intent: string,
  deadline: number,
  meter: ModelMeter,
): Promise<Judgment[]> {
  if (inputs.length === 0) return []
  meter.jevCalls += Math.ceil(inputs.length / JEV_BATCH)
  meter.jevCandidates += inputs.length
  const judged = await beforeDeadline(deadline, () =>
    judgeLayer({
      question,
      intent,
      timeoutMs: callTimeLimitMs(deadline),
      batchSize: JEV_BATCH,
      candidates: inputs.map(({ document, text }, index) => ({
        id: String(index),
        text,
        meta: jevMeta(document),
      })),
    }),
  )
  return inputs.map(
    (_, index) => judged.get(String(index)) ?? { pAnswers: 0, pExplore: 0 },
  )
}

/** The text of a candidate for Jev: its title, then its evidence chunks. */
export function evidenceText(
  document: KnowledgeDocument,
  chunks: readonly { text: string }[],
): string {
  const body =
    document.kind === "image"
      ? `[image] ${document.path}`
      : chunks.map((chunk) => chunk.text).join("\n\n")
  return [document.title, body]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, ORCHESTRATOR_DEFAULTS.evidenceChars)
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
  /** Only relations and documents valid at this time (the store filters). */
  validAt: Date | null
  /** Only relations and documents valid at some time in this window. */
  validBetween?: { from: Date; to: Date }
}

type Traversal = {
  /** Each judged document, the seeds first, in the order of the layers. */
  nodes: TraversalNode[]
  /** Each relation that the layers read. */
  relations: KnowledgeRelation[]
  explored: { nodes: number; edges: number }
  partialReason?: "total_timeout"
  /** Frontier documents with more relations than `maxFanOut`. */
  cappedHubs: KnowledgeDocument[]
}

/**
 * Layer 0 judges the seeds, and all seeds are the first frontier: p(explore)
 * picks the frontier of layer 2 and later. Then up to `maxDepth` layers (at
 * most D). When the time budget ends, the loop stops and returns what it
 * judged, with `total_timeout`.
 * Another Jev failure throws its `JevError`.
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
  maxDepth: number
  walk: WalkFilter
  meter: ModelMeter
}): Promise<Traversal> {
  const { deadline } = input
  const settings = ORCHESTRATOR_DEFAULTS
  const nodes: TraversalNode[] = []
  const visited = new Set(input.seeds.map((seed) => documentId(seed.ref)))
  const cappedHubs: KnowledgeDocument[] = []
  const read: KnowledgeRelation[] = []
  let partialReason: Traversal["partialReason"]
  try {
    const judged = await judge(
      input.seeds,
      input.question,
      input.intent,
      deadline,
      input.meter,
    )
    const seeds = input.seeds.map((seed, index): TraversalNode => ({
      ...seed,
      pAnswers: judged[index]?.pAnswers ?? 0,
      pExplore: judged[index]?.pExplore ?? 0,
      depth: 0,
      parent: null,
    }))
    nodes.push(...seeds)
    let frontier = seeds
    for (
      let depth = 1;
      depth <= Math.min(input.maxDepth, settings.maxDepth) && frontier.length;
      depth++
    ) {
      const byKey = new Map(
        frontier.map((node) => [documentId(node.ref), node]),
      )
      const refs = frontier.map((node) => node.ref)
      const relations = await beforeDeadline(deadline, () =>
        input.store.readFrontier(input.scope, refs, input.walk.validAt),
      )
      read.push(...relations.map((item) => item.relation))
      const candidates = layerCandidates(relations, byKey, visited, input.walk)
      cappedHubs.push(...candidates.capped.map((node) => node.document))
      const layer = candidates.picked.slice(0, settings.fanOut)
      if (layer.length === 0) break
      for (const candidate of layer) visited.add(documentId(candidate.ref))
      const evidence = await beforeDeadline(deadline, () =>
        input.store.readEvidence(
          input.scope,
          layer.map((candidate) => candidate.ref),
          input.vector,
          settings.evidenceChunks,
        ),
      )
      const chunksOf = new Map(
        evidence.map((item) => [
          documentId({
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
          chunksOf.get(documentId(candidate.ref)) ?? [],
        ),
      }))
      const scores = await judge(
        inputs,
        input.question,
        input.intent,
        deadline,
        input.meter,
      )
      const layerNodes = inputs.map((candidate, index): TraversalNode => ({
        ref: candidate.ref,
        document: candidate.document,
        text: candidate.text,
        pAnswers: scores[index]?.pAnswers ?? 0,
        pExplore: scores[index]?.pExplore ?? 0,
        depth,
        parent: candidate.parent,
      }))
      nodes.push(...layerNodes)
      frontier = layerNodes.filter(
        (node) => node.pExplore >= settings.exploreAt,
      )
    }
  } catch (error) {
    if (!isBudgetSpent(error)) throw error
    partialReason = "total_timeout"
  }
  return {
    nodes,
    relations: read,
    explored: { nodes: visited.size, edges: read.length },
    ...(partialReason ? { partialReason } : {}),
    cappedHubs,
  }
}

/** A document that a layer reaches, with the relation that reaches it. */
type Candidate = Omit<JudgeInput, "text"> & {
  parent: NonNullable<TraversalNode["parent"]>
}

/** True when the validity of a row overlaps the window (open ends count). */
function overlaps(
  row: { validFrom: Date | null; validTo: Date | null },
  window: { from: Date; to: Date },
): boolean {
  return (
    (!row.validFrom || row.validFrom <= window.to) &&
    (!row.validTo || row.validTo >= window.from)
  )
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
): { picked: Candidate[]; capped: TraversalNode[] } {
  const perNode = new Map<TraversalNode, FrontierRelation[]>()
  for (const item of relations) {
    const { relation, direction, neighbor } = item
    const predicate = relation.predicate.toUpperCase()
    const from = frontier.get(
      documentId({
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
      (walk.validBetween &&
        (!overlaps(relation, walk.validBetween) ||
          !overlaps(neighbor, walk.validBetween))) ||
      visited.has(
        documentId({ workspaceId: item.workspaceId, docKey: neighbor.docKey }),
      )
    )
      continue
    const list = perNode.get(from) ?? []
    list.push(item)
    perNode.set(from, list)
  }
  const best = new Map<string, Candidate>()
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
      const key = documentId(ref)
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
