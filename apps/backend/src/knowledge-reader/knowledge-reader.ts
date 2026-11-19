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
import type { CallOrg } from "../mcp/framework/tool-org.js"
import { readyKnowledgeShas } from "../models/knowledge-state.js"
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
>

export type SearchResult = {
  /** Best first. `projectionSha` is the SHA that the stack serves. */
  hits: KnowledgeHit[]
  /**
   * Set when Jev did not judge the hits: they are in the search order
   * (ADR-068 "Open", the PoC choice of CTX-1406).
   */
  partialReason?: "judge_unavailable"
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
   * The SHA that the plane serves for each Workspace (`knowledge_state`
   * `last_sha`). Empty when the old stack answers.
   */
  planeShas: ReadonlyMap<string, string>
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
): Promise<KnowledgeSelection> {
  const legacy = { reader: legacyKnowledgeReader, planeShas: new Map() }
  const flag = await knowledgePlaneFlag(orgId)
  if (flag === "off" || workspaceIds.length === 0) return legacy
  const shas = await readyKnowledgeShas(orgId, workspaceIds)
  if (!workspaceIds.every((id) => shas.has(id))) return legacy
  if (flag === "on")
    return { reader: planeKnowledgeReader({ shas }), planeShas: shas }
  return {
    reader: shadowKnowledgeReader(legacyKnowledgeReader, (meter) =>
      planeKnowledgeReader({ shas, meter }),
    ),
    planeShas: new Map(),
  }
}
