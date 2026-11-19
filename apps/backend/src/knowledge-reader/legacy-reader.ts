import { expandWorkspaceGraph } from "../domain/workspaces/graph-expand.js"
import { readOrRebuildWorkspaceGraph } from "../domain/workspaces/graph-rebuild.js"
import { searchKnowledge } from "../domain/workspaces/knowledge-search.js"
import { rankWorkspaceRelated } from "../domain/workspaces/related-ranking.js"
import type { KnowledgeReader } from "./knowledge-reader.js"

/**
 * The old stack: Postgres knowledge search, the FalkorDB walk and the graph
 * relevance ranking (ADR-051). It calls the code of the old stack with no
 * change.
 */
export const legacyKnowledgeReader: KnowledgeReader = {
  stack: "legacy",
  search: async (request) => ({ hits: await searchKnowledge(request) }),
  related: ({ org, workspace, sha, input, now }) =>
    rankWorkspaceRelated(org, workspace, sha, input, now),
  graph: ({ orgId, orgSlug, projection }) =>
    readOrRebuildWorkspaceGraph({ orgId, orgSlug, projection }),
  expand: ({ orgId, orgSlug, projection, params }) =>
    expandWorkspaceGraph({ orgId, orgSlug, projection, ...params }),
}
