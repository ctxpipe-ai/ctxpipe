import type {
  CodeSearchResult,
  GraphNode,
  HybridSearchResult,
  HydratedClaim,
  TraversalResult,
} from "../../../retrieval/index.js"
import {
  codeSearch,
  graphLookup,
  graphTraversal,
  hybridSearch,
  hydrateClaims,
} from "../../../retrieval/index.js"
import type { RetrievalPlan } from "../../../retrieval/schema/plan.js"

export type RetrievalGraphState = {
  orgId: string
  orgSlug: string
  query: string
  embedding?: number[]
  plan: RetrievalPlan
  objectIds: string[]
  claimIds: string[]
  hybridResults: HybridSearchResult[]
  codeResults: CodeSearchResult[]
  graphNodes: GraphNode[]
  traversalResults: TraversalResult[]
  hydratedClaims: HydratedClaim[]
}

export async function executeSteps(
  state: RetrievalGraphState,
): Promise<Partial<RetrievalGraphState>> {
  const { orgId, orgSlug, query, plan, embedding } = state
  const depthLimit = plan.depthLimit ?? 3
  const resultLimit = plan.resultLimit ?? 20

  const objectIds = new Set(state.objectIds)
  const claimIds = new Set(state.claimIds)
  const hybridResults: HybridSearchResult[] = [...state.hybridResults]
  const codeResults: CodeSearchResult[] = [...state.codeResults]
  const graphNodes: GraphNode[] = [...state.graphNodes]
  const traversalResults: TraversalResult[] = [...state.traversalResults]

  for (const step of plan.steps) {
    const params = (step.params ?? {}) as Record<string, unknown>

    switch (step.type) {
      case "hybrid_search": {
        const q = (params.query as string) ?? query
        const emb = (params.embedding as number[] | undefined) ?? embedding
        if (!emb) continue
        const results = await hybridSearch(
          orgId,
          { embedding: emb, query: q },
          { limit: resultLimit },
        )
        hybridResults.push(...results)
        for (const r of results) objectIds.add(r.objectId)
        break
      }
      case "code_search": {
        const q = (params.query as string) ?? query
        const repoIds = params.repositoryIds as string[] | undefined
        const results = await codeSearch(orgId, {
          query: q,
          repositoryIds: repoIds,
        })
        codeResults.push(...results)
        break
      }
      case "exact_lookup":
      case "graph_anchor": {
        const nodeId = params.nodeId as string
        if (!nodeId) continue
        const node = await graphLookup(orgId, orgSlug, nodeId)
        if (node) graphNodes.push(node)
        break
      }
      case "graph_traversal": {
        const startId = (params.startId as string) ?? (params.nodeId as string)
        if (!startId) continue
        const maxDepth = (params.maxDepth as number | undefined) ?? depthLimit
        const result = await graphTraversal(orgId, orgSlug, startId, {
          maxDepth,
          limit: resultLimit,
        })
        traversalResults.push(result)
        for (const id of result.nodeIds) objectIds.add(id)
        for (const id of result.edgeClaimIds) claimIds.add(id)
        break
      }
      default:
        break
    }
  }

  const allClaimIds = [...claimIds]
  const hydratedClaims =
    allClaimIds.length > 0
      ? await hydrateClaims(orgId, allClaimIds)
      : state.hydratedClaims

  return {
    objectIds: [...objectIds],
    claimIds: allClaimIds,
    hybridResults,
    codeResults,
    graphNodes,
    traversalResults,
    hydratedClaims,
  }
}
