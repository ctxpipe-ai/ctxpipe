import type { RelatedInput } from "../domain/workspaces/related-ranking.js"
import { McpToolError } from "../mcp/framework/tool-errors.js"
import type { CallOrg } from "../mcp/framework/tool-org.js"
import {
  type KnowledgeHead,
  readyKnowledgeHeads,
} from "../models/knowledge-state.js"

/*
 * The requests and results of the knowledge plane reads, and the heads that
 * the plane serves. The tools (`search_knowledge`, `get_related`, the chat
 * search and graph tools) and the graph route read knowledge with
 * `planeKnowledgeReader` over these heads.
 */

/** The search of `search_knowledge` and of the chat search tool. */
export type SearchRequest = {
  orgId: string
  /** Workspaces of `orgId` to search. */
  workspaceIds: readonly string[]
  query: string
  kinds?: readonly string[]
  /** Literal path prefix (no pattern characters). */
  pathPrefix?: string
  /** Connector mirror roots, or `authored`. */
  sources?: readonly string[]
  updatedAfter?: Date
  /**
   * A unit matches when it has no claim with a validity window, or when at
   * least one such claim covers this time (`validFrom` ≤ T < `validTo`).
   */
  validAt?: Date
  /** Default 10, at most 50. */
  limit?: number
  /**
   * The query time when `validAt` is not given: a hit that is not valid then
   * comes after the valid hits. Now by default; an eval replay gives the
   * recorded time.
   */
  now?: Date
}

/** The best chunk of one unit. */
export type KnowledgeHit = {
  workspaceId: string
  unitId: string
  path: string
  kind: string | null
  title: string | null
  source: string
  updatedAt: Date
  /** The SHA that the plane serves for the Workspace. */
  projectionSha: string
  /** 1-based file lines of the chunk, inclusive. */
  startLine: number
  endLine: number
  /** Title and heading path, then the section text. */
  text: string
  /** The claims of the unit. Front matter can hold facts that no chunk states. */
  claims: Array<{ predicate: string | null; to: string }>
  score: number
}

export type SearchResult = {
  /** Best first. */
  hits: KnowledgeHit[]
  /**
   * `judge_unavailable`: Jev did not judge the hits, so they are in the
   * search order (ADR-068 "Open", the PoC choice of CTX-1406).
   * `total_timeout`: the time budget ended before the search ended.
   */
  partialReason?: "judge_unavailable" | "total_timeout"
}

/** One `get_related` call on one Workspace, as of `now`. */
export type RelatedRequest = {
  org: CallOrg
  workspace: { id: string; slug: string }
  input: RelatedInput
  now: Date
}

/** A bounded walk from seed documents (the chat graph tools). */
export type ExpandRequest = {
  orgId: string
  workspaceId: string
  params: GraphExpandParams
}

export type GraphExpandParams = {
  seeds: string[]
  /** The layers of relations after the seeds. */
  maxDepth?: number
  /** The most relations of each document, highest confidence first. */
  maxFanOut?: number
}

export type ExpandedNode = {
  id: string
  kind: string
  name: string | null
  summary: string | null
}

export type ExpandedEdge = {
  sourceId: string
  targetId: string
  predicate: string
  confidence: number
  validFrom: string | null
  validTo: string | null
  source: string | null
}

export type GraphExpansion = {
  nodes: ExpandedNode[]
  edges: ExpandedEdge[]
}

/**
 * The head that the plane serves for each of `workspaceIds` of `orgId`, on
 * `branch` (ADR-071 decision 6; absent: the default branch): the SHA and the
 * tree version of the branch. The plane serves a Workspace when a knowledge
 * run applied a commit of the branch in full. Each actor that can read the
 * Workspace can read each of its branches, also the session branch of a
 * conversation. A Workspace that the plane does not serve yet gives
 * `workspace_not_ready` on the default branch, and `invalid_argument` on a
 * named branch.
 */
export async function servedKnowledgeHeads(
  orgId: string,
  workspaceIds: readonly string[],
  branch?: string,
): Promise<ReadonlyMap<string, KnowledgeHead>> {
  const heads = await readyKnowledgeHeads(orgId, workspaceIds, branch)
  if (workspaceIds.some((id) => !heads.has(id)))
    throw branch === undefined ? notReady() : unknownBranch(branch)
  return heads
}

/** The head of one Workspace, as `servedKnowledgeHeads` gives it. */
export async function servedKnowledgeHead(
  orgId: string,
  workspaceId: string,
  branch?: string,
): Promise<KnowledgeHead> {
  const heads = await servedKnowledgeHeads(orgId, [workspaceId], branch)
  const head = heads.get(workspaceId)
  if (!head) throw notReady()
  return head
}

/**
 * The head of the first branch of `branches` that the plane serves for the
 * Workspace, else the head of the default branch (ADR-071, the chat branch
 * selector). A conversation reads its session branch, then its base branch:
 * a session branch has a projection only after a push of it. `branch` names
 * the branch of the head; absent: the default branch.
 */
export async function firstServedKnowledgeBranch(
  orgId: string,
  workspaceId: string,
  branches: readonly string[],
): Promise<{ head: KnowledgeHead; branch?: string }> {
  for (const branch of branches) {
    const head = (await readyKnowledgeHeads(orgId, [workspaceId], branch)).get(
      workspaceId,
    )
    if (head) return { head, branch }
  }
  return { head: await servedKnowledgeHead(orgId, workspaceId) }
}

/** True for the error of a Workspace that the plane does not serve yet. */
export function isKnowledgeNotReady(error: unknown): boolean {
  return error instanceof McpToolError && error.code === "workspace_not_ready"
}

/** The error for a Workspace with no projection of its default branch yet. */
const notReady = () =>
  new McpToolError(
    "workspace_not_ready",
    "The knowledge of the Workspace is still building. Try again in a few minutes.",
  )

/** The error for a branch with no projection. */
const unknownBranch = (branch: string) =>
  new McpToolError(
    "invalid_argument",
    `The branch ${branch} has no knowledge projection. A branch is projected after a commit on it; check the name, or omit branch to read the default branch.`,
  )
