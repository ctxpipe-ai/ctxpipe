import type {
  GraphExpandParams,
  GraphExpansion,
} from "../domain/workspaces/graph-expand.js"
import type { GraphOrg } from "../domain/workspaces/graph-rebuild.js"
import type {
  KnowledgeHit,
  KnowledgeSearchInput,
} from "../domain/workspaces/knowledge-search.js"
import type {
  Ranking,
  RelatedInput,
} from "../domain/workspaces/related-ranking.js"
import type { PublishedProjection } from "../domain/workspaces/revision.js"
import type { WorkspaceGraphPayload } from "../domain/workspaces/workspace-graph.js"
import { McpToolError } from "../mcp/framework/tool-errors.js"
import type { CallOrg } from "../mcp/framework/tool-org.js"
import {
  type KnowledgeHead,
  readyKnowledgeHeads,
} from "../models/knowledge-state.js"
import { log } from "../observability/logger.js"
import { legacyKnowledgeReader } from "./legacy-reader.js"
import { planeKnowledgeReader } from "./plane-reader.js"

/*
 * The knowledge reader seam of ADR-069 decision 9. The tools
 * (`search_knowledge`, `get_related`, the chat search and graph tools) and
 * the graph route read knowledge only through `KnowledgeReader`. The
 * readiness of each Workspace on the plane picks the implementation for each
 * request.
 */

/** The stack that answers a read: the old stack, or the knowledge plane. */
export type KnowledgeStack = "legacy" | "plane"

/** The search of `search_knowledge` and of the chat search tool. */
export type SearchRequest = Omit<
  KnowledgeSearchInput,
  "deadline" | "embedding" | "unitIds"
> & {
  /**
   * The query time when `validAt` is not given: a hit that is not valid then
   * comes after the valid hits. Now by default; an eval replay gives the
   * recorded time.
   */
  now?: Date
}

export type SearchResult = {
  /** Best first. `projectionSha` is the SHA that the stack serves. */
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
  /** The SHA that the stack serves for the Workspace. */
  sha: string
  input: RelatedInput
  now: Date
}

/** The graph view of one Workspace (the Graph pane). */
export type GraphRequest = GraphOrg & {
  workspaceId: string
  projection: PublishedProjection | null
}

/** A bounded walk from seed nodes (the chat graph tools). */
export type ExpandRequest = GraphOrg & {
  workspaceId: string
  projection: PublishedProjection
  params: GraphExpandParams
}

export type KnowledgeReader = {
  stack: KnowledgeStack
  search(request: SearchRequest): Promise<SearchResult>
  related(request: RelatedRequest): Promise<Ranking>
  graph(request: GraphRequest): Promise<WorkspaceGraphPayload>
  expand(request: ExpandRequest): Promise<GraphExpansion>
}

type KnowledgeSelection = {
  reader: KnowledgeReader
  /**
   * The head that the plane serves for each Workspace (`knowledge_state`:
   * `last_sha` and the tree version). Empty when the old stack answers.
   */
  planeHeads: ReadonlyMap<string, KnowledgeHead>
}

/**
 * The reader for one request over `workspaceIds` of `orgId`: the plane when
 * each Workspace is ready on it, else the old stack for the whole request.
 * A request that the old stack serves because a Workspace is not ready logs
 * one `knowledge_plane.fallback` event. A Workspace is ready when a
 * knowledge run applied a commit in full (`knowledge_state.last_sha`).
 */
export async function selectKnowledgeReader(
  orgId: string,
  workspaceIds: readonly string[],
  /**
   * The branch of the read (ADR-071 decision 6); absent: the default branch.
   * Only the plane serves a named branch.
   */
  branch?: string,
): Promise<KnowledgeSelection> {
  const legacy = { reader: legacyKnowledgeReader, planeHeads: new Map() }
  if (branch !== undefined) {
    // Each actor that can read the Workspace can read each of its branches,
    // also the session branch of a conversation (ADR-071 decision 6).
    const heads = await readyKnowledgeHeads(orgId, workspaceIds, branch)
    const missing = workspaceIds.filter((id) => !heads.has(id))
    if (missing.length > 0) throw unknownBranch(branch)
    return { reader: planeKnowledgeReader({ heads }), planeHeads: heads }
  }
  if (workspaceIds.length === 0) return legacy
  const heads = await readyKnowledgeHeads(orgId, workspaceIds)
  const notReadyIds = workspaceIds.filter((id) => !heads.has(id))
  if (notReadyIds.length > 0) {
    // Ids only: no query and no content.
    log.info({
      step: "knowledge_plane.fallback",
      orgId,
      workspaceIds,
      notReadyIds,
    })
    return legacy
  }
  return { reader: planeKnowledgeReader({ heads }), planeHeads: heads }
}

/**
 * The reader of the first branch of `branches` that the plane serves for
 * each Workspace, else the reader of the default branch (ADR-071, the chat
 * branch selector). A conversation reads its session branch, then its base
 * branch: a session branch has a projection only after a push of it.
 * `branch` names the branch that the selection serves. The fallback to the
 * default branch logs as in `selectKnowledgeReader`.
 */
export async function selectFirstKnowledgeBranch(
  orgId: string,
  workspaceIds: readonly string[],
  branches: readonly string[],
): Promise<KnowledgeSelection & { branch?: string }> {
  if (workspaceIds.length > 0)
    for (const branch of branches) {
      const heads = await readyKnowledgeHeads(orgId, workspaceIds, branch)
      if (workspaceIds.every((id) => heads.has(id)))
        return {
          reader: planeKnowledgeReader({ heads }),
          planeHeads: heads,
          branch,
        }
    }
  return selectKnowledgeReader(orgId, workspaceIds)
}

/** The error for a branch with no projection. */
const unknownBranch = (branch: string) =>
  new McpToolError(
    "invalid_argument",
    `The branch ${branch} has no knowledge projection. A branch is projected after a commit on it; check the name, or omit branch to read the default branch.`,
  )
