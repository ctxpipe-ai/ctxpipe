import {
  codeSearch,
  graphLookup,
  graphTraversal,
  hybridSearch,
} from "../../../retrieval/index.js"
import type { ConversationGraphState } from "../state.js"

/**
 * Runs retrieval channels with parallel execution where possible.
 * Phase 1: hybridSearch and codeSearch in parallel (enables code→graph anchoring)
 * Phase 2: graphRetrieval (anchored from hybrid or code results)
 */
export async function retrievalChannelsNode(
  state: ConversationGraphState,
): Promise<Partial<ConversationGraphState>> {
  const { orgId, orgSlug, query, embedding, plan } = state
  if (!orgId || !orgSlug) return {}

  let hybridResults = state.hybridResults ?? []
  let objectIds = state.objectIds ?? []
  let graphNodes = state.graphNodes ?? []
  let traversalResults = state.traversalResults ?? []
  let claimIds = state.claimIds ?? []
  let codeResults = state.codeResults ?? []

  // Phase 1: hybridSearch and codeSearch in parallel
  const hasHybridStep = plan?.steps.some((s) => s.type === "hybrid_search")
  const codeStep = plan?.steps.find((s) => s.type === "code_search")

  const [hybridOutput, codeOutput] = await Promise.all([
    hasHybridStep && embedding
      ? (async () => {
          const resultLimit = plan?.resultLimit ?? 20
          const results = await hybridSearch(
            orgId,
            { embedding, query: query ?? "" },
            { limit: resultLimit },
          )
          return {
            hybridResults: results,
            objectIds: results.map((r) => r.objectId),
          }
        })()
      : Promise.resolve(null),
    codeStep
      ? runCodeSearch(orgId, orgSlug, state, codeStep)
      : Promise.resolve(null),
  ])

  if (hybridOutput) {
    hybridResults = [...hybridResults, ...hybridOutput.hybridResults]
    objectIds = [...new Set(objectIds), ...hybridOutput.objectIds]
  }

  if (codeOutput?.codeResults) {
    codeResults = [...codeResults, ...codeOutput.codeResults]
  }

  // Phase 2: graphRetrieval (anchored from hybrid or code)
  const anchorStep = plan?.steps.find((s) => s.type === "graph_anchor")
  const traversalStep = plan?.steps.find((s) => s.type === "graph_traversal")
  const extensionTraversalStep = plan?.steps.find(
    (s) => s.type === "extension_traversal",
  )
  const exactStep = plan?.steps.find((s) => s.type === "exact_lookup")

  const graphState: ConversationGraphState = {
    ...state,
    hybridResults,
    objectIds,
    codeResults,
  }

  const graphOutput = await runGraphRetrieval(orgId, orgSlug, graphState, {
    anchorStep,
    traversalStep,
    extensionTraversalStep,
    exactStep,
  })

  if (graphOutput) {
    graphNodes = [...graphNodes, ...(graphOutput.graphNodes ?? [])]
    traversalResults = [...traversalResults, ...(graphOutput.traversalResults ?? [])]
    objectIds = [...new Set([...objectIds, ...(graphOutput.objectIds ?? [])])]
    claimIds = [...new Set([...claimIds, ...(graphOutput.claimIds ?? [])])]
  }

  // Phase 2.5: graph→code scoping – run code search again when graph produced repo IDs
  const repoIdsFromGraph = repositoryIdsFromGraph({
    ...state,
    graphNodes,
    traversalResults,
  })
  if (repoIdsFromGraph.length > 0 && codeStep) {
    const scopedCodeOutput = await runCodeSearch(
      orgId,
      orgSlug,
      { ...state, graphNodes, traversalResults, codeResults },
      {
        ...codeStep,
        params: { ...codeStep.params, repositoryIds: repoIdsFromGraph },
      },
    )
    if (scopedCodeOutput?.codeResults?.length) {
      codeResults = [...codeResults, ...scopedCodeOutput.codeResults]
    }
  }

  return {
    hybridResults,
    objectIds,
    graphNodes,
    traversalResults,
    claimIds,
    codeResults,
  }
}

type PlanStep = { type: string; params?: Record<string, unknown> }

async function runGraphRetrieval(
  orgId: string,
  orgSlug: string,
  state: ConversationGraphState,
  steps: {
    anchorStep?: PlanStep | null
    traversalStep?: PlanStep | null
    extensionTraversalStep?: PlanStep | null
    exactStep?: PlanStep | null
  },
): Promise<Partial<ConversationGraphState> | null> {
  const { anchorStep, traversalStep, extensionTraversalStep, exactStep } = steps
  if (
    !anchorStep &&
    !traversalStep &&
    !extensionTraversalStep &&
    !exactStep
  ) {
    return null
  }

  const results = await Promise.all([
    anchorStep ? runAnchor(orgId, orgSlug, state, anchorStep) : Promise.resolve(null),
    traversalStep
      ? runTraversal(orgId, orgSlug, state, traversalStep)
      : Promise.resolve(null),
    extensionTraversalStep
      ? runTraversal(orgId, orgSlug, state, extensionTraversalStep)
      : Promise.resolve(null),
    exactStep ? runExactLookup(orgId, orgSlug, state, exactStep) : Promise.resolve(null),
  ])

  const anchorResult = results[0] as Partial<ConversationGraphState> | null
  const traversalResult = results[1] as Partial<ConversationGraphState> | null
  const extensionResult = results[2] as Partial<ConversationGraphState> | null
  const exactResult = results[3] as Partial<ConversationGraphState> | null

  const graphNodes = [
    ...(anchorResult?.graphNodes ?? []),
    ...(traversalResult?.graphNodes ?? []),
    ...(extensionResult?.graphNodes ?? []),
    ...(exactResult?.graphNodes ?? []),
  ]
  const traversalResults = [
    ...(traversalResult?.traversalResults ?? []),
    ...(extensionResult?.traversalResults ?? []),
  ]
  const objectIds = [
    ...(traversalResult?.objectIds ?? []),
    ...(extensionResult?.objectIds ?? []),
  ]
  const claimIds = [
    ...(traversalResult?.claimIds ?? []),
    ...(extensionResult?.claimIds ?? []),
  ]

  return {
    graphNodes,
    traversalResults,
    objectIds,
    claimIds,
  }
}

async function runAnchor(
  orgId: string,
  orgSlug: string,
  state: ConversationGraphState,
  step: PlanStep,
): Promise<Partial<ConversationGraphState> | null> {
  const params = (step.params ?? {}) as Record<string, unknown>
  let nodeId = params.nodeId as string | undefined
  if (!nodeId && (params.anchorFrom === "hybrid" || params.anchorFrom === "code")) {
    if (params.anchorFrom === "hybrid" && state.hybridResults?.length) {
      const first = state.hybridResults[0] as { objectId?: string }
      nodeId = first?.objectId
    }
    if (params.anchorFrom === "code" && state.codeResults?.length) {
      const first = state.codeResults[0] as { repositoryId?: string }
      nodeId = first?.repositoryId
    }
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
  step: PlanStep,
): Promise<Partial<ConversationGraphState> | null> {
  const params = (step.params ?? {}) as Record<string, unknown>
  let startId: string | undefined =
    (params.startId as string) ?? (params.nodeId as string)
  if (!startId && (params.anchorFrom === "hybrid" || params.anchorFrom === "code")) {
    if (params.anchorFrom === "hybrid" && state.hybridResults?.length) {
      const first = state.hybridResults[0] as { objectId?: string }
      startId = first?.objectId
    }
    if (params.anchorFrom === "code" && state.codeResults?.length) {
      const first = state.codeResults[0] as { repositoryId?: string }
      startId = first?.repositoryId
    }
  }
  if (!startId) return null

  const depthLimit = state.plan?.depthLimit ?? 3
  const resultLimit = state.plan?.resultLimit ?? 20
  const maxDepth = (params.maxDepth as number | undefined) ?? depthLimit
  const useExtensionLayer = step.type === "extension_traversal"

  const result = await graphTraversal(orgId, orgSlug, startId, {
    maxDepth,
    limit: resultLimit,
    useExtensionLayer,
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
  step: PlanStep,
): Promise<Partial<ConversationGraphState> | null> {
  const params = (step.params ?? {}) as Record<string, unknown>
  const nodeId = params.nodeId as string
  if (!nodeId) return null

  const node = await graphLookup(orgId, orgSlug, nodeId)
  if (!node) return null

  return { graphNodes: [node] }
}

/**
 * Collects repository IDs (repo_*) from graph nodes and traversal results.
 * Canonical mapping: repo_* IDs connect graph (Repository nodes) and code search.
 * Service→repositories mapping is implicit via claims; repo_* is the join key.
 */
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

async function runCodeSearch(
  orgId: string,
  _orgSlug: string,
  state: ConversationGraphState,
  step: PlanStep | undefined,
): Promise<Partial<ConversationGraphState> | null> {
  if (!step) return null

  const params = (step.params ?? {}) as Record<string, unknown>
  const q = (params.query as string) ?? state.query ?? ""
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
    codeResults: results,
  }
}
