import {
  deriveRepositoryIndexingStatus,
  listRepositoriesForOrg,
} from "../../../models/repositories.js"
import { toToon } from "../../../lib/agentToolRuntime.js"
import { hydrateClaimsWithEvidence } from "../../../retrieval/index.js"
import type { ConversationGraphState } from "../state.js"

/**
 * Builds retrieval context from combined candidates (graph + semantic + code)
 * and hydrated claims. Hydrates every claim the traversal kept; the traversal
 * budget bounds how many, and candidate rank does not.
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

  contextParts.push(
    "REASONING: Aggregate claims by predicate (e.g. WRITES_TO, USES_LIBRARY, DEPENDS_ON) to infer recommendations. Multiple services using the same tech = org pattern. Use fleet-wide patterns when available.",
  )

  if (state.claimAggregationResults?.length) {
    contextParts.push(
      `Fleet-wide patterns:\n${toToon({
        patterns: state.claimAggregationResults.map((p) => ({
          objectId: p.objectId,
          predicate: p.predicate,
          subjectCount: p.subjectCount,
        })),
      })}`,
    )
  }

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

  const claimIdsToHydrate = state.claimIds ?? []
  const hydratedClaimsWithEvidence =
    state.orgId && claimIdsToHydrate.length > 0
      ? await hydrateClaimsWithEvidence(state.orgId, claimIdsToHydrate)
      : []

  if (hydratedClaimsWithEvidence.length > 0) {
    const distinct = (values: Array<string | null | undefined>) =>
      [...new Set(values.filter((v): v is string => Boolean(v)))].join(" ")
    contextParts.push(
      `Claims with evidence (provenance):\n${toToon({
        claims: hydratedClaimsWithEvidence.map((c) => ({
          id: c.id,
          subjectId: c.subjectId,
          predicate: c.predicate,
          objectId: c.objectId,
          confidence: c.aggregatedConfidence,
          validFrom: c.validFrom?.toISOString().slice(0, 10) ?? "",
          validTo: c.validTo?.toISOString().slice(0, 10) ?? "",
          evidenceCount: c.evidence.length,
          sources: distinct(
            c.evidence.map((e) => `${e.sourceType}/${e.extractionMethod}`),
          ),
          cite: distinct(
            c.evidence.map(
              (e) =>
                e.sourceUrl ??
                (typeof e.provenance?.path === "string"
                  ? e.provenance.path
                  : null),
            ),
          ),
        })),
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
      indexingStatus: deriveRepositoryIndexingStatus({
        indexReady: r.indexReady,
        indexingStatus: r.indexingStatus,
      }),
      indexingReason: r.indexingReason ?? null,
      orgId: r.orgId,
    })),
  })

  const projectName = state.currentProjectName?.trim() || "unknown"
  const fullContext = `Current project name: ${projectName}\n\nRetrieval context:\n${retrievalContext}\n\nRepositories (TOON):\n${repoSnapshot}`

  return { retrievalContext: fullContext }
}
