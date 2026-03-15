import { codeSearch } from "../../../retrieval/index.js"
import type { ConversationGraphState } from "../state.js"

/** Collects repository IDs (repo_*) from graph nodes and traversal results. */
function repositoryIdsFromGraph(state: ConversationGraphState): string[] {
  const ids = new Set<string>()
  for (const n of state.graphNodes ?? []) {
    const id = (n as { id?: string }).id
    if (id?.startsWith("repo_")) ids.add(id)
  }
  for (const t of state.traversalResults ?? []) {
    const nodeIds = (t as { nodeIds?: string[] }).nodeIds ?? []
    for (const id of nodeIds) {
      if (id?.startsWith("repo_")) ids.add(id)
    }
  }
  return [...ids]
}

export async function codeSearchNode(
  state: ConversationGraphState,
): Promise<Partial<ConversationGraphState>> {
  const { orgId, orgSlug, query, plan } = state
  if (!orgId || !orgSlug) return {}
  const step = plan?.steps.find((s) => s.type === "code_search")
  if (!step) return {}

  const params = (step.params ?? {}) as Record<string, unknown>
  const q = (params.query as string) ?? query ?? ""
  let repoIds = params.repositoryIds as string[] | undefined

  if (!repoIds?.length) {
    const fromGraph = repositoryIdsFromGraph(state)
    if (fromGraph.length > 0) {
      repoIds = fromGraph
    }
  }

  const results = await codeSearch(orgId, {
    query: q,
    repositoryIds: repoIds,
  })

  return {
    codeResults: [...state.codeResults, ...results],
  }
}
