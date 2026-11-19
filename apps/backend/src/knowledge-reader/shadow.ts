import { servingIdForKnowledgePath } from "../domain/workspaces/hydrate.js"
import { McpToolError } from "../mcp/framework/tool-errors.js"
import { log } from "../observability/logger.js"
import { JevError } from "../retrieval/jev/client.js"
import type { KnowledgeReader } from "./knowledge-reader.js"
import type { ModelMeter } from "./orchestrator.js"

/** The results that the shadow event lists, and the k of overlap@k. */
const LOGGED_IDS = 50
const OVERLAP_K = 10

/** The ranked ids and scores of one answer. Ids are hashes, never paths. */
type Ranked = { ids: string[]; scores: number[] }

/**
 * The reader of the `shadow` flag value (ADR-069 decision 9): the old stack
 * answers. After it answers, the plane runs the same search or `get_related`
 * call off the request path, and one evlog event
 * (`knowledge_plane.shadow`) compares the two. The event holds only ids,
 * scores, overlap@k, latency and the counts of the model calls: no query, no
 * path, no text, no error message.
 */
export function shadowKnowledgeReader(
  legacy: KnowledgeReader,
  plane: (meter: ModelMeter) => KnowledgeReader,
): KnowledgeReader {
  return {
    ...legacy,
    async search(request) {
      const started = performance.now()
      const result = await legacy.search(request)
      // The key of a unit is a hash of its Workspace and its path, and it
      // is the id of the unit on both stacks.
      const hitIds = (hits: typeof result.hits): Ranked => ({
        ids: hits.map((hit) =>
          servingIdForKnowledgePath(hit.workspaceId, hit.path),
        ),
        scores: hits.map((hit) => hit.score),
      })
      compare(
        {
          tool: "search_knowledge",
          orgId: request.orgId,
          workspaceIds: [...request.workspaceIds],
          legacy: hitIds(result.hits),
          legacyMs: performance.now() - started,
        },
        plane,
        async (reader) => {
          const shadow = await reader.search(request)
          return {
            ...hitIds(shadow.hits),
            partialReason: shadow.partialReason,
          }
        },
      )
      return result
    },
    async related(request) {
      const started = performance.now()
      const ranking = await legacy.related(request)
      // A result names its unit by its path. The event names it by its key.
      const resultIds = (results: typeof ranking.results): Ranked => ({
        ids: results.map((result) =>
          servingIdForKnowledgePath(request.workspace.id, result.ref),
        ),
        scores: results.map((result) => result.score),
      })
      compare(
        {
          tool: "get_related",
          orgId: request.org.id,
          workspaceIds: [request.workspace.id],
          legacy: resultIds(ranking.results),
          legacyMs: performance.now() - started,
        },
        plane,
        async (reader) => {
          const shadow = await reader.related(request)
          return {
            ...resultIds(shadow.results),
            partialReason: shadow.partialReason,
          }
        },
      )
      return ranking
    },
  }
}

/** Start the plane read, and log the comparison when it ends. */
function compare(
  answered: {
    tool: "search_knowledge" | "get_related"
    orgId: string
    workspaceIds: string[]
    legacy: Ranked
    legacyMs: number
  },
  plane: (meter: ModelMeter) => KnowledgeReader,
  run: (
    reader: KnowledgeReader,
  ) => Promise<Ranked & { partialReason?: string }>,
): void {
  const meter: ModelMeter = { jevCalls: 0, jevCandidates: 0, embeddingCalls: 0 }
  const started = performance.now()
  void run(plane(meter))
    .then(
      (shadow) => ({ shadow, failure: undefined }),
      (error: unknown) => ({ shadow: undefined, failure: failureKind(error) }),
    )
    .then(({ shadow, failure }) => {
      const legacyTop = answered.legacy.ids.slice(0, OVERLAP_K)
      const planeTop = shadow?.ids.slice(0, OVERLAP_K) ?? []
      const k = Math.max(legacyTop.length, planeTop.length)
      const shared = planeTop.filter((id) => legacyTop.includes(id)).length
      log.info({
        step: "knowledge_plane.shadow",
        tool: answered.tool,
        orgId: answered.orgId,
        workspaceIds: answered.workspaceIds,
        k,
        overlapAtK: shadow && k > 0 ? shared / k : null,
        legacy: {
          ids: answered.legacy.ids.slice(0, LOGGED_IDS),
          scores: answered.legacy.scores.slice(0, LOGGED_IDS),
          latencyMs: Math.round(answered.legacyMs),
        },
        plane: {
          ...(shadow
            ? {
                ids: shadow.ids.slice(0, LOGGED_IDS),
                scores: shadow.scores.slice(0, LOGGED_IDS),
              }
            : {}),
          ...(shadow?.partialReason
            ? { partialReason: shadow.partialReason }
            : {}),
          ...(failure ? { failure } : {}),
          latencyMs: Math.round(performance.now() - started),
          ...meter,
        },
      })
    })
}

/** The kind of a failure, with no message: a message can quote content. */
function failureKind(error: unknown): string {
  if (error instanceof JevError) return `jev_${error.kind}`
  if (error instanceof McpToolError) return error.code
  return error instanceof Error ? error.name : "unknown"
}
