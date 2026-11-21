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
import { getConversation } from "../models/conversations.js"
import {
  type KnowledgeHead,
  readyKnowledgeHeads,
} from "../models/knowledge-state.js"
import { getOrgFeature } from "../models/org-features.js"
import { legacyKnowledgeReader } from "./legacy-reader.js"
import { planeKnowledgeReader } from "./plane-reader.js"
import { shadowKnowledgeReader } from "./shadow.js"

/*
 * The knowledge reader seam of ADR-069 decision 9. The tools
 * (`search_knowledge`, `get_related`, the chat search and graph tools) and
 * the graph route read knowledge only through `KnowledgeReader`. The org
 * flag `knowledge_plane` picks the implementation for each request.
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

const flags = new Map<
  string,
  { value: Promise<"off" | "shadow" | "on">; expires: number }
>()

/** The `knowledge_plane` flag of an org, read at most every 30 seconds. */
function knowledgePlaneFlag(orgId: string): Promise<"off" | "shadow" | "on"> {
  const now = Date.now()
  const cached = flags.get(orgId)
  if (cached && cached.expires > now) return cached.value
  const value = getOrgFeature(orgId, "knowledge_plane")
  flags.set(orgId, { value, expires: now + 30_000 })
  // A failed read is not kept: the next request reads again.
  value.catch(() => flags.delete(orgId))
  return value
}

/**
 * The reader for one request over `workspaceIds` of `orgId`:
 * - `off`: the old stack.
 * - `shadow`: the old stack answers. When each Workspace is ready on the
 *   plane, the plane also runs after the answer, off the request path, and
 *   logs only ids, scores, overlap, latency and call counts.
 * - `on`: the plane answers when each Workspace is ready on it, else the old
 *   stack answers the whole request.
 * A Workspace is ready when a knowledge run applied a commit in full
 * (`knowledge_state.last_sha`).
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
  const flag = await knowledgePlaneFlag(orgId)
  if (branch !== undefined) {
    if (flag !== "on")
      throw new McpToolError(
        "invalid_argument",
        "A read of a branch needs the knowledge plane, which is not on for this org. Omit branch to read the default branch.",
      )
    for (const workspaceId of workspaceIds)
      await resolveReadBranch({ workspaceId, branch })
    const heads = await readyKnowledgeHeads(orgId, workspaceIds, branch)
    const missing = workspaceIds.filter((id) => !heads.has(id))
    if (missing.length > 0) throw unknownBranch(branch)
    return { reader: planeKnowledgeReader({ heads }), planeHeads: heads }
  }
  if (flag === "off" || workspaceIds.length === 0) return legacy
  const heads = await readyKnowledgeHeads(orgId, workspaceIds)
  if (!workspaceIds.every((id) => heads.has(id))) return legacy
  if (flag === "on")
    return { reader: planeKnowledgeReader({ heads }), planeHeads: heads }
  return {
    reader: shadowKnowledgeReader(legacyKnowledgeReader, (meter) =>
      planeKnowledgeReader({ heads, meter }),
    ),
    planeHeads: new Map(),
  }
}

/** The prefix of the session branch of a conversation (ADR-048). */
const CONVERSATION_BRANCH = /^ctxpipe\/chat\/([^/]+)\//

/**
 * The error for a branch that the caller cannot read: the same for a branch
 * with no projection and for the session branch of a conversation of
 * another user, so that it does not tell whether that conversation exists.
 */
const unknownBranch = (branch: string) =>
  new McpToolError(
    "invalid_argument",
    `The branch ${branch} has no knowledge projection that this call can read. A branch is projected after a commit on it; check the name, or omit branch to read the default branch.`,
  )

/**
 * The read rule of a branch (ADR-071 decision 6), in one place. Each member
 * of the Workspace can read each branch, except the session branch of a
 * conversation (`ctxpipe/chat/<conversation>/<n>`): only the actor that can
 * open the conversation reads it. This is option A of the open question of
 * ADR-071 for the CTO, and it does not merge before the CTO answers.
 * Call it in the org context of the request.
 */
export async function resolveReadBranch(input: {
  workspaceId: string
  branch: string
}): Promise<void> {
  const conversationId = CONVERSATION_BRANCH.exec(input.branch)?.[1]
  if (!conversationId) return
  const conversation = await getConversation(conversationId, {
    workspaceId: input.workspaceId,
  })
  if (!conversation) throw unknownBranch(input.branch)
}

