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
  // The Bolt client sends each statement in a managed transaction. Memgraph
  // refuses index DDL there ("Index manipulation not allowed in multicommand
  // transactions"), and no live Memgraph test proves an auto-commit path.
  // Thus Memgraph gets no index until such a path has a test.
  if (provider === "memgraph") return []
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
      // FalkorDB has no IF NOT EXISTS. A second create gives this error.
      if (!/already indexed/i.test(String(error))) throw error
    })
}
