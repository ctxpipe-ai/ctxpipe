import { graphLookup, graphTraversal } from "../../../retrieval/index.js"
import type { ConversationGraphState } from "../state.js"

/**
 * Runs graph anchor, traversal, and exact lookup in parallel.
 * Enables code search to use repository IDs from graph results (graph→code scoping).
 */
export async function graphRetrievalNode(
  state: ConversationGraphState,
): Promise<Partial<ConversationGraphState>> {
  const { orgId, orgSlug, plan } = state
  if (!orgId || !orgSlug) return {}

  const anchorStep = plan?.steps.find((s) => s.type === "graph_anchor")
  const traversalStep = plan?.steps.find((s) => s.type === "graph_traversal")
  const exactStep = plan?.steps.find((s) => s.type === "exact_lookup")

  const results = await Promise.all([
    anchorStep ? runAnchor(orgId, orgSlug, state, anchorStep) : Promise.resolve(null),
    traversalStep ? runTraversal(orgId, orgSlug, state, traversalStep) : Promise.resolve(null),
    exactStep ? runExactLookup(orgId, orgSlug, state, exactStep) : Promise.resolve(null),
  ])

  const anchorResult = results[0] as Partial<ConversationGraphState> | null
  const traversalResult = results[1] as Partial<ConversationGraphState> | null
  const exactResult = results[2] as Partial<ConversationGraphState> | null

  const graphNodes = [
    ...(anchorResult?.graphNodes ?? []),
    ...(traversalResult?.graphNodes ?? []),
    ...(exactResult?.graphNodes ?? []),
  ]
  const traversalResults = traversalResult?.traversalResults ?? []
  const objectIds = [
    ...new Set([
      ...state.objectIds,
      ...(traversalResult?.objectIds ?? []),
    ]),
  ]
  const claimIds = [
    ...new Set([
      ...state.claimIds,
      ...(traversalResult?.claimIds ?? []),
    ]),
  ]

  return {
    graphNodes: [...state.graphNodes, ...graphNodes],
    traversalResults: [...state.traversalResults, ...traversalResults],
    objectIds,
    claimIds,
  }
}

async function runAnchor(
  orgId: string,
  orgSlug: string,
  state: ConversationGraphState,
  step: { params?: Record<string, unknown> },
): Promise<Partial<ConversationGraphState> | null> {
  const params = (step.params ?? {}) as Record<string, unknown>
  let nodeId = params.nodeId as string | undefined
  if (!nodeId && params.anchorFrom === "hybrid" && state.hybridResults?.length) {
    const first = state.hybridResults[0] as { objectId?: string }
    nodeId = first?.objectId
  }
  if (!nodeId) return null

  const node = await graphLookup(orgId, orgSlug, nodeId)
  if (!node) return null

  return { graphNodes: [node] }
}

async function runTraversal(
  orgId: string,
  orgSlug: string,
  state: ConversationGraphState,
  step: { params?: Record<string, unknown> },
): Promise<Partial<ConversationGraphState> | null> {
  const params = (step.params ?? {}) as Record<string, unknown>
  let startId: string | undefined =
    (params.startId as string) ?? (params.nodeId as string)
  if (!startId && params.anchorFrom === "hybrid" && state.hybridResults?.length) {
    const first = state.hybridResults[0] as { objectId?: string }
    startId = first?.objectId
  }
  if (!startId) return null

  const depthLimit = state.plan?.depthLimit ?? 3
  const resultLimit = state.plan?.resultLimit ?? 20
  const maxDepth = (params.maxDepth as number | undefined) ?? depthLimit

  const result = await graphTraversal(orgId, orgSlug, startId, {
    maxDepth,
    limit: resultLimit,
  })

  return {
    graphNodes: [],
    traversalResults: [result],
    objectIds: result.nodeIds,
    claimIds: result.edgeClaimIds,
  }
}

async function runExactLookup(
  orgId: string,
  orgSlug: string,
  _state: ConversationGraphState,
  step: { params?: Record<string, unknown> },
): Promise<Partial<ConversationGraphState> | null> {
  const params = (step.params ?? {}) as Record<string, unknown>
  const nodeId = params.nodeId as string
  if (!nodeId) return null

  const node = await graphLookup(orgId, orgSlug, nodeId)
  if (!node) return null

  return { graphNodes: [node] }
}
