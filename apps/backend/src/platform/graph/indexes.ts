import type { GraphClient, getConfig } from "./client.js"

type Provider = ReturnType<typeof getConfig>["provider"]

/**
 * Index DDL for each graph engine. Each claim finds its two units by
 * projectionKey and id. Without this index, a large repository keeps the
 * graph store busy for many minutes.
 */
function workspaceGraphIndexStatements(provider: Provider): string[] {
  if (provider === "falkordb")
    return [
      "CREATE INDEX FOR (n:WorkspaceKnowledgeUnit) ON (n.projectionKey, n.id)",
    ]
  if (provider === "memgraph")
    return [
      "CREATE INDEX ON :WorkspaceKnowledgeUnit(projectionKey)",
      "CREATE INDEX ON :WorkspaceKnowledgeUnit(id)",
    ]
  if (provider === "neo4j-enterprise" || provider === "neo4j-community")
    return [
      "CREATE INDEX workspace_knowledge_unit_key IF NOT EXISTS FOR (n:WorkspaceKnowledgeUnit) ON (n.projectionKey, n.id)",
    ]
  // Neptune openCypher has no CREATE INDEX. Neptune indexes all properties.
  return []
}

/** Create the Workspace graph indexes. A second run has no effect. */
export async function ensureWorkspaceGraphIndexes(
  graph: GraphClient,
  provider: Provider,
): Promise<void> {
  for (const statement of workspaceGraphIndexStatements(provider))
    await graph.executeQuery(statement).catch((error: unknown) => {
      // FalkorDB and Memgraph have no IF NOT EXISTS. A second create gives
      // one of these errors.
      if (!/already (indexed|exists)/i.test(String(error))) throw error
    })
}
