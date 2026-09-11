import { z } from "zod"
import { hydrateUnitsToProjectionClaims } from "./hydrate.js"
import { createHash } from "node:crypto"
import {
  requireCurrentOrgId,
  requireCurrentOrgSlug,
} from "../../auth/context.js"
import {
  getWorkspaceProjectionSnapshot,
  persistWorkspaceGraphResult,
} from "../../models/workspaces.js"
import { getGraphClient, withGraphClient } from "../../platform/graph/client.js"
import {
  publishedProjection,
  sameWorkspaceRevision,
  workspaceRevisionSchema,
  type WorkspaceRevision,
  type PublishedProjection,
} from "./revision.js"
import {
  workspaceGraphNodes,
  workspaceGraphFromSignals,
} from "./workspace-graph.js"

export function workspaceGraphRevisionKey(revision: WorkspaceRevision): string {
  return createHash("sha256")
    .update(JSON.stringify(workspaceRevisionSchema.parse(revision)))
    .digest("hex")
}

/** Build the derived graph from a captured PostgreSQL projection, never by parsing Git again. */
export async function projectWorkspaceGraph(
  revision: WorkspaceRevision,
): Promise<boolean> {
  const snapshot = await getWorkspaceProjectionSnapshot(revision.workspaceId)
  const projection = publishedProjection(snapshot.projection)
  if (
    projection?.kind !== "active" ||
    !sameWorkspaceRevision(projection.revision, revision)
  )
    return false
  const orgId = requireCurrentOrgId()
  const orgSlug = requireCurrentOrgSlug()
  const projectionKey = workspaceGraphRevisionKey(revision)
  try {
    await withGraphClient({ orgId, orgSlug }, async () => {
      const graph = getGraphClient()
      const nodes = workspaceGraphNodes(snapshot.units)
      if (nodes.length)
        await graph.executeQuery(
          `UNWIND $nodes AS node
        MERGE (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey, id: node.id})
        SET n.workspaceId = $workspaceId, n.kind = node.kind, n.name = node.name, n.summary = node.summary`,
          { projectionKey, workspaceId: revision.workspaceId, nodes },
        )
      const claims = hydrateUnitsToProjectionClaims(snapshot.units)
      if (claims.length)
        await graph.executeQuery(
          `UNWIND $claims AS claim
        MATCH (s:WorkspaceKnowledgeUnit {projectionKey: $projectionKey, id: claim.subjectId})
        MATCH (t:WorkspaceKnowledgeUnit {projectionKey: $projectionKey, id: claim.objectId})
        MERGE (s)-[r:WorkspaceSignal {projectionKey: $projectionKey, id: claim.id}]->(t)
        SET r.predicate = claim.predicate, r.confidence = claim.aggregatedConfidence,
            r.validFrom = claim.validFrom, r.validTo = claim.validTo,
            r.source = claim.source, r.lastObservedAt = claim.lastObservedAt`,
          { projectionKey, claims },
        )
      await graph.executeQuery(
        `MERGE (p:WorkspaceProjection {projectionKey: $projectionKey})
        SET p.workspaceId = $workspaceId, p.revision = $revision, p.nodeCount = $nodeCount, p.claimCount = $claimCount, p.completedAt = $completedAt`,
        {
          projectionKey,
          workspaceId: revision.workspaceId,
          revision: JSON.stringify(revision),
          nodeCount: nodes.length,
          claimCount: claims.length,
          completedAt: new Date().toISOString(),
        },
      )
    })
    return await persistWorkspaceGraphResult({
      revision,
      result: { kind: "ready" },
    })
  } catch (error) {
    await persistWorkspaceGraphResult({
      revision,
      result: {
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      },
    })
    throw error
  }
}

export class WorkspaceGraphUnavailableError extends Error {
  override readonly name = "WorkspaceGraphUnavailableError"
}

/** Read one immutable derived graph; missing/corrupt data never becomes an empty Postgres fallback. */
export async function readWorkspaceGraph(input: {
  orgId: string
  orgSlug: string
  projection: PublishedProjection | null
}) {
  const projection = input.projection
  if (projection?.kind !== "active" || projection.stores.graph.kind !== "ready")
    throw new WorkspaceGraphUnavailableError(
      "Workspace graph projection is unavailable.",
    )
  const revision = projection.revision
  const projectionKey = workspaceGraphRevisionKey(revision)
  return withGraphClient(input, async () => {
    const graph = getGraphClient()
    const marker = await graph.executeQuery(
      "MATCH (p:WorkspaceProjection {projectionKey: $projectionKey}) RETURN p.nodeCount AS nodeCount, p.claimCount AS claimCount, p.completedAt AS completedAt",
      { projectionKey },
    )
    const complete = marker.records[0]
    if (!complete)
      throw new WorkspaceGraphUnavailableError(
        "Workspace graph projection is unavailable.",
      )
    const nodeResult = await graph.executeQuery(
      `MATCH (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey})
      RETURN n.id AS id, n.kind AS kind, n.name AS name, n.summary AS summary ORDER BY n.id`,
      { projectionKey },
    )
    const nodeSchema = z.object({
      id: z.string(),
      kind: z.literal("KnowledgeUnit"),
      name: z.string().nullable(),
      summary: z.string().nullable(),
    })
    const nodes = nodeResult.records.map((row) =>
      nodeSchema.parse({
        id: row.get("id"),
        kind: row.get("kind"),
        name: row.get("name"),
        summary: row.get("summary"),
      }),
    )
    const signalResult = await graph.executeQuery(
      `MATCH (s:WorkspaceKnowledgeUnit {projectionKey: $projectionKey})-[r:WorkspaceSignal {projectionKey: $projectionKey}]->(t:WorkspaceKnowledgeUnit {projectionKey: $projectionKey})
      RETURN s.id AS subjectId, t.id AS objectId, r.predicate AS predicate, r.confidence AS aggregatedConfidence,
        r.validFrom AS validFrom, r.validTo AS validTo, r.source AS source, r.lastObservedAt AS lastObservedAt ORDER BY r.id`,
      { projectionKey },
    )
    const signalSchema = z.object({
      subjectId: z.string(),
      objectId: z.string(),
      predicate: z.string(),
      aggregatedConfidence: z.number(),
      validFrom: z.string().nullable(),
      validTo: z.string().nullable(),
      source: z.string().nullable(),
      lastObservedAt: z.string(),
    })
    const claims = signalResult.records.map((row) =>
      signalSchema.parse(
        Object.fromEntries(
          Object.keys(signalSchema.shape).map((key) => [key, row.get(key)]),
        ),
      ),
    )
    if (
      nodes.length !== Number(complete.get("nodeCount")) ||
      claims.length !== Number(complete.get("claimCount"))
    )
      throw new WorkspaceGraphUnavailableError(
        "Workspace graph projection is unavailable.",
      )
    return workspaceGraphFromSignals({
      nodes,
      claims,
      lastUpdatedAt: z.string().parse(complete.get("completedAt")),
    })
  })
}
