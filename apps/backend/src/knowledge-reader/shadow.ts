import { SpanStatusCode, trace } from "@opentelemetry/api"

import { servingIdForKnowledgePath } from "../domain/workspaces/hydrate.js"
import { log } from "../observability/logger.js"
import { failureOf } from "./failure.js"
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
 * path, no text, no error message. A failed plane read gives the source
 * and the code of its error (`failureOf`), and a partial answer gives the
 * source and the code of the error that made it partial. A failed plane
 * read also sets the span `knowledge_plane.shadow` of the request trace to
 * error, with the source and the code.
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
  // A child of the active span of the request, which can end first.
  void trace
    .getTracer("ctxpipe-backend")
    .startActiveSpan(
      "knowledge_plane.shadow",
      { attributes: { "ctxpipe.knowledge_plane.tool": answered.tool } },
      (span) =>
        run(plane(meter))
          .then(
            (shadow) => {
              // A partial answer is not an error: the span stays ok, and
              // names the cause.
              if (meter.partialCause)
                span.setAttributes({
                  "ctxpipe.knowledge_plane.partial_cause":
                    meter.partialCause.kind,
                  ...(meter.partialCause.code === undefined
                    ? {}
                    : {
                        "ctxpipe.knowledge_plane.partial_cause_code":
                          meter.partialCause.code,
                      }),
                })
              return { shadow, failure: undefined }
            },
            (error: unknown) => {
              const failure = failureOf(error)
              span.setAttributes({
                "error.type": failure.kind,
                ...(failure.code === undefined
                  ? {}
                  : { "ctxpipe.knowledge_plane.failure_code": failure.code }),
              })
              // The kind only (`exception.type`), with no message and no
              // stack: they can quote content. The code is on the span.
              span.recordException({ name: failure.kind })
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: failure.kind,
              })
              return { shadow: undefined, failure }
            },
          )
          .finally(() => span.end()),
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
          ...(failure
            ? {
                failure: failure.kind,
                ...(failure.code === undefined
                  ? {}
                  : { failureCode: failure.code }),
              }
            : {}),
          latencyMs: Math.round(performance.now() - started),
          // The counts, and the source and the code of a partial answer.
          ...meter,
        },
      })
    })
}
