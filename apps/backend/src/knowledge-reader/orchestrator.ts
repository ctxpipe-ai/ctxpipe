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
   * The bridge to other sources: layer 1 also gets the documents of the
   * sources of no seed that are closest to the question by vector, at most
   * this many, in addition to `fanOut`. 0: no bridge.
   */
  bridgeItems: 10,
  /**
   * The time of one retrieval, from the first read to the last judge. 0: no
   * time budget. Only the evals use 0, so that a slow step does not hide
   * what the loop finds (the CTO, 2026-11-22).
   */
  timeBudgetMs: 3_000,
  /** The top results that the disagreement step compares (N). */
  disagreementItems: 10,
  /**
   * A candidate answers when p(answers) is at least this value. Each answer
   * is a result, and so is each step on its "why" path (CTX-1520).
   */
  keepAt: 0.5,
  /**
   * The search finds an answer when its top hit has p(answers) of at least
   * this value; else it says "no answer". The eval scores the search with it
   * (CTX-1561), and `search_knowledge` can give it as a field (CTX-1164). It
   * is above `keepAt`: on the dev questions, a no-answer question can get a
   * top hit of 0.5 to 0.6, and an answered question with a gold document in
   * the top 5 always got more than 0.6.
   */
  answerAt: 0.6,
  /**
   * The loop explores from a candidate when p(explore) is at least this.
   * Such a candidate is also a result: a step (CTX-1534).
   */
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
 * True for the end of the time budget of a retrieval with `deadline`: the
 * deadline, or a Jev call that timed out (each Jev call gets the rest of the
 * budget as its time limit). With no time budget, a Jev timeout is a failed
 * call: the call had the time limit of its client.
 */
export function isBudgetSpent(error: unknown, deadline: number): boolean {
  return (
    error instanceof BudgetSpentError ||
    (error instanceof JevError &&
      error.kind === "timeout" &&
      Number.isFinite(deadline))
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
 *
 * The id of a candidate is its document key (a hash of its path), then its
 * Workspace id. Thus the batches do not change when the order of the inputs
 * (the search rank) changes, and each batch gets a mix of strong and weak
 * documents.
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
  // The key first, so that the order mixes the Workspaces. The Workspace
  // keeps the id unique.
  const idOf = ({ ref }: JudgeInput) => `${ref.docKey} ${ref.workspaceId}`
  const judged = await beforeDeadline(deadline, () =>
    judgeLayer({
      question,
      intent,
      timeoutMs: callTimeLimitMs(deadline),
      batchSize: JEV_BATCH,
      candidates: inputs.map((input) => ({
        id: idOf(input),
        text: input.text,
        meta: jevMeta(input.document),
      })),
    }),
  )
  return inputs.map(
    (input) => judged.get(idOf(input)) ?? { pAnswers: 0, pExplore: 0 },
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
    /**
     * The relation that found it, from its parent. Null for a seed, and for
     * a document of the bridge: no relation found it.
     */
    parent: {
      node: TraversalNode
      predicate: string
      /** `out`: the parent is the source of the relation. */
      direction: "out" | "in"
      confidence: number
    } | null
  }

/** Which relations the loop follows. */
export type WalkFilter = {
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
 * most D). Layer 1 also judges the documents of the bridge. When the time
 * budget ends, the loop stops and returns what it judged, with
 * `total_timeout`.
 * Another Jev failure throws its `JevError`.
 *
 * The steps that do not wait for each other run in parallel (CTX-1535):
 * - The judge of the seeds runs with layer 1, because the seeds are the
 *   first frontier whatever Jev says. `seedRelations` is the read of their
 *   relations, which the caller starts before the query vector is ready.
 * - While Jev judges a layer, the relations of all its candidates are read.
 *   The next layer uses only the relations of the candidates that Jev
 *   explores, so the result is the same as a read after the judge.
 * Thus a walk of D layers waits for D Jev calls, not D + 1, and for no
 * frontier read after layer 1.
 *
 * When the judge of the last layer (depth `maxDepth`) starts, `onLastLayer`
 * gets the documents that Jev judged before it and the documents of this
 * judge (at depth 1 also the seeds, when their judge is still in flight).
 * The caller can start a step that needs only these documents, so that the
 * step runs with the judge.
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
  /** The relations of the seeds (`readFrontier` at `walk.validAt`). */
  seedRelations: Promise<FrontierRelation[]>
  /**
   * The documents that layer 1 adds with no relation, after the documents
   * that the relations of the seeds reach (`bridgeItems`).
   */
  bridge: Promise<Omit<JudgeInput, "text">[]>
  maxDepth: number
  walk: WalkFilter
  meter: ModelMeter
  onLastLayer?: (
    judged: readonly TraversalNode[],
    pending: readonly TraversalNode[],
  ) => void
}): Promise<Traversal> {
  const { deadline } = input
  const settings = ORCHESTRATOR_DEFAULTS
  const maxDepth = Math.min(input.maxDepth, settings.maxDepth)
  const nodes: TraversalNode[] = []
  const visited = new Set(input.seeds.map((seed) => documentId(seed.ref)))
  const cappedHubs: KnowledgeDocument[] = []
  const read: KnowledgeRelation[] = []
  let partialReason: Traversal["partialReason"]
  let seedsJudged = false
  // The judgments of the seeds come with layer 1. Until then, a seed node
  // has 0 for both, and only the walk of layer 1 reads it (as a parent).
  const seeds = input.seeds.map((seed): TraversalNode => ({
    ...seed,
    pAnswers: 0,
    pExplore: 0,
    depth: 0,
    parent: null,
  }))
  const seedJudge = judge(
    input.seeds,
    input.question,
    input.intent,
    deadline,
    input.meter,
  ).then((judged) => {
    seeds.forEach((seed, index) => {
      seed.pAnswers = judged[index]?.pAnswers ?? 0
      seed.pExplore = judged[index]?.pExplore ?? 0
    })
    seedsJudged = true
  })
  // The loop awaits `seedJudge` later; until then, a failure must not be an
  // unhandled rejection.
  seedJudge.catch(() => {})
  try {
    let frontier: readonly TraversalNode[] = seeds
    let relations = input.seedRelations
    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      const byKey = new Map(
        frontier.map((node) => [documentId(node.ref), node]),
      )
      // Only the relations of the frontier: a read of more documents gives
      // the same relations for these documents.
      const own = (await beforeDeadline(deadline, () => relations)).filter(
        (item) => byKey.has(frontierKey(item)),
      )
      read.push(...own.map((item) => item.relation))
      const candidates = layerCandidates(own, byKey, visited, input.walk)
      cappedHubs.push(...candidates.capped.map((node) => node.document))
      const layer: Candidate[] = candidates.picked.slice(0, settings.fanOut)
      if (depth === 1) {
        const reached = new Set(
          layer.map((candidate) => documentId(candidate.ref)),
        )
        for (const item of await beforeDeadline(deadline, () => input.bridge))
          if (
            !visited.has(documentId(item.ref)) &&
            !reached.has(documentId(item.ref))
          )
            layer.push({ ...item, parent: null })
      }
      if (layer.length === 0) break
      for (const candidate of layer) visited.add(documentId(candidate.ref))
      const refs = layer.map((candidate) => candidate.ref)
      // The relations of the next layer, read while Jev judges this one.
      relations =
        depth < maxDepth
          ? beforeDeadline(deadline, () =>
              input.store.readFrontier(input.scope, refs, input.walk.validAt),
            )
          : Promise.resolve([])
      // Each await of `relations` comes later; until then, a failure must
      // not be an unhandled rejection.
      relations.catch(() => {})
      const evidence = await beforeDeadline(deadline, () =>
        input.store.readEvidence(
          input.scope,
          refs,
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
      // The judgments come with the judge, as for the seeds.
      const layerNodes = inputs.map((candidate): TraversalNode => ({
        ref: candidate.ref,
        document: candidate.document,
        text: candidate.text,
        pAnswers: 0,
        pExplore: 0,
        depth,
        parent: candidate.parent,
      }))
      if (depth === maxDepth)
        input.onLastLayer?.(
          seedsJudged ? [...seeds, ...nodes] : [...nodes],
          seedsJudged ? layerNodes : [...seeds, ...layerNodes],
        )
      // A settled `seedJudge` costs nothing to await again.
      const [scores] = await Promise.all([
        // Only the layer judge reads the relation line: the node keeps the
        // evidence text, which the disagreement step reads.
        judge(
          inputs.map((candidate) => ({
            ...candidate,
            text: relationLine(candidate.parent) + candidate.text,
          })),
          input.question,
          input.intent,
          deadline,
          input.meter,
        ),
        seedJudge,
      ])
      layerNodes.forEach((node, index) => {
        node.pAnswers = scores[index]?.pAnswers ?? 0
        node.pExplore = scores[index]?.pExplore ?? 0
      })
      nodes.push(...layerNodes)
      frontier = layerNodes.filter(
        (node) => node.pExplore >= settings.exploreAt,
      )
    }
    await seedJudge
  } catch (error) {
    if (!isBudgetSpent(error, deadline)) throw error
    partialReason = "total_timeout"
  }
  // The seeds come first, when Jev judged them (also before the end of the
  // budget).
  if (seedsJudged) nodes.unshift(...seeds)
  return {
    nodes,
    relations: read,
    explored: { nodes: visited.size, edges: read.length },
    ...(partialReason ? { partialReason } : {}),
    cappedHubs,
  }
}

/**
 * The relation that reached a candidate, as Jev reads it before the text of
 * the candidate: the title of the parent and the predicate, in the
 * direction of the relation. Empty when no relation reached it.
 */
function relationLine(parent: TraversalNode["parent"]): string {
  if (!parent) return ""
  const { title, path } = parent.node.document
  const other = `"${title || path}"`
  return parent.direction === "out"
    ? `${other} ${parent.predicate} this document.\n\n`
    : `This document ${parent.predicate} ${other}.\n\n`
}

/** The key of the frontier document of a relation that the store read. */
function frontierKey(item: FrontierRelation): string {
  return documentId({
    workspaceId: item.workspaceId,
    docKey:
      item.direction === "out" ? item.relation.srcDoc : item.relation.dstDoc,
  })
}

/**
 * A document that a layer reaches, with the relation that reaches it (none
 * for a document of the bridge).
 */
type Candidate = Omit<JudgeInput, "text"> & {
  parent: TraversalNode["parent"]
}

/** A document that a relation of the frontier reaches. */
type Reached = Candidate & { parent: NonNullable<TraversalNode["parent"]> }

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
): { picked: Reached[]; capped: TraversalNode[] } {
  const perNode = new Map<TraversalNode, FrontierRelation[]>()
  for (const item of relations) {
    const { relation, direction, neighbor } = item
    const predicate = relation.predicate.toUpperCase()
    const from = frontier.get(frontierKey(item))
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
  const best = new Map<string, Reached>()
  const capped: TraversalNode[] = []
  for (const [node, list] of perNode) {
    list.sort((a, b) => b.relation.confidence - a.relation.confidence)
    if (list.length > walk.maxFanOut) capped.push(node)
    for (const { workspaceId, relation, neighbor, direction } of list.slice(
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
          direction,
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
