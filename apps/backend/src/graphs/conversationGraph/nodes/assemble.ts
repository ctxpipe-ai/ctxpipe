import { listRepositoriesForOrg } from "../../../models/repositories.js"
import { toToon } from "../../../lib/agentToolRuntime.js"
import { hydrateClaimsWithEvidence } from "../../../retrieval/index.js"
import type { ConversationGraphState } from "../state.js"

const TOP_CANDIDATES_FOR_CLAIM_HYDRATION = 20

/** Extracts claim IDs referenced by top candidates (e.g. from traversal edgeClaimIds). */
function claimIdsFromTopCandidates(
  candidates: ConversationGraphState["candidates"],
  limit: number,
): string[] {
  const ids = new Set<string>()
  for (const c of (candidates ?? []).slice(0, limit)) {
    const edgeClaimIds = (c.payload?.edgeClaimIds as string[] | undefined)
    if (Array.isArray(edgeClaimIds)) {
      for (const id of edgeClaimIds) if (id) ids.add(id)
    }
    const claimId = c.claimId
    if (claimId) ids.add(claimId)
  }
  return [...ids]
}

/**
 * Builds retrieval context from combined candidates (graph + semantic + code)
 * and hydrated claims. Hydrates claims only for top-ranked candidates (after rerank).
 */
export async function assembleNode(
  state: ConversationGraphState,
): Promise<Partial<ConversationGraphState>> {
  if (!state.query) {
    return {
      retrievalContext:
        "No query found in messages. Reply with: No query found in messages.",
    }
  }

  const contextParts: string[] = []

  if (state.candidates?.length) {
    contextParts.push(
      `Retrieval candidates (graph + semantic + code, by relevance):\n${toToon({
        candidates: state.candidates.map((c) => ({
          objectId: c.objectId,
          sourceChannels: c.sourceChannels,
          score: c.score,
          payload: c.payload,
        })),
      })}`,
    )
  }

  const claimIdsToHydrate = claimIdsFromTopCandidates(
    state.candidates,
    TOP_CANDIDATES_FOR_CLAIM_HYDRATION,
  )
  const hydratedClaimsWithEvidence =
    state.orgId && claimIdsToHydrate.length > 0
      ? await hydrateClaimsWithEvidence(state.orgId, claimIdsToHydrate)
      : []

  if (hydratedClaimsWithEvidence.length > 0) {
    contextParts.push(
      `Claims with evidence (provenance):\n${toToon({
        claims: hydratedClaimsWithEvidence.map((c) => ({
          ...c,
          evidenceCount: c.evidence.length,
        })),
        evidence: hydratedClaimsWithEvidence.flatMap((c) =>
          c.evidence.map((e) => ({
            claimId: c.id,
            sourceType: e.sourceType,
            sourceId: e.sourceId,
            extractionMethod: e.extractionMethod,
            confidence: e.confidence,
          })),
        ),
      })}`,
    )
  }

  const retrievalContext =
    contextParts.length > 0
      ? contextParts.join("\n\n")
      : "No retrieval results."

  const repositories =
    state.orgId != null
      ? await listRepositoriesForOrg(state.orgId)
      : []
  const repoSnapshot = toToon({
    repositories: repositories.map((r) => ({
      id: r.id,
      name: r.name,
      indexReady: r.indexReady,
      orgId: r.orgId,
    })),
  })

  const fullContext = `Retrieval context:\n${retrievalContext}\n\nRepositories (TOON):\n${repoSnapshot}`

  return { retrievalContext: fullContext }
}
