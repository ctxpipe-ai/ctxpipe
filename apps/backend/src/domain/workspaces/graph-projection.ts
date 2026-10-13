import { createHash } from "node:crypto"
import { z } from "zod"
import {
  requireCurrentOrgId,
  requireCurrentOrgSlug,
} from "../../auth/context.js"
import {
  getWorkspaceProjectionSnapshot,
  persistWorkspaceGraphResult,
} from "../../models/workspaces.js"
import {
  type GraphClient,
  getConfig,
  getGraphClient,
  withGraphClient,
} from "../../platform/graph/client.js"
import { ensureWorkspaceGraphIndexes } from "../../platform/graph/indexes.js"
import { type HydrateUnit, hydrateUnitsToProjectionClaims } from "./hydrate.js"
import {
  type PublishedProjection,
  publishedProjection,
  sameWorkspaceRevision,
  type WorkspaceRevision,
  workspaceRevisionSchema,
} from "./revision.js"
import {
  workspaceGraphFromSignals,
  workspaceGraphNodes,
} from "./workspace-graph.js"

/**
 * Increase this number when the node or edge shape changes. A new version
 * gives each revision a new key, so a ready revision has no graph under its
 * key. The graph read then starts a rebuild, which projects it again.
 * Version 2 adds `path`, `degree`, `inDegree`, and `outDegree` to each node.
 */
const workspaceGraphProjectionVersion = 2

export function workspaceGraphRevisionKey(revision: WorkspaceRevision): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectionVersion: workspaceGraphProjectionVersion,
        revision: workspaceRevisionSchema.parse(revision),
      }),
    )
    .digest("hex")
}

/** Write one revision's claims as edges between its units. */
export const workspaceClaimsQuery = `UNWIND $claims AS claim
MATCH (s:WorkspaceKnowledgeUnit {projectionKey: $projectionKey, id: claim.subjectId})
MATCH (t:WorkspaceKnowledgeUnit {projectionKey: $projectionKey, id: claim.objectId})
MERGE (s)-[r:WorkspaceSignal {projectionKey: $projectionKey, id: claim.id}]->(t)
SET r.predicate = claim.predicate, r.confidence = claim.aggregatedConfidence,
    r.validFrom = claim.validFrom, r.validTo = claim.validTo,
    r.source = claim.source, r.lastObservedAt = claim.lastObservedAt`

/**
 * Write the complete graph of one revision. The result does not depend on the
 * order of the units, and a second write of the same revision replaces the first.
 */
export async function writeWorkspaceRevisionGraph(
  graph: GraphClient,
  input: { revision: WorkspaceRevision; units: readonly HydrateUnit[] },
): Promise<void> {
  const { revision, units } = input
  const projectionKey = workspaceGraphRevisionKey(revision)
  await ensureWorkspaceGraphIndexes(graph, getConfig().provider)
  // Write the revision graph clean. A rebuild after a partial or lost graph
  // must not keep stale nodes, or the read count check never matches.
  await graph.executeQuery(
    "MATCH (p:WorkspaceProjection {projectionKey: $projectionKey}) DELETE p",
    { projectionKey },
  )
  await graph.executeQuery(
    "MATCH (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey}) DETACH DELETE n",
    { projectionKey },
  )
  // Sort by id, so that each write order gives the same write sequence.
  const nodes = workspaceGraphNodes(units)
    .map((node, index) => ({ ...node, path: units[index]?.path ?? null }))
    .sort((a, b) => compareIds(a.id, b.id))
  if (nodes.length)
    await graph.executeQuery(
      `UNWIND $nodes AS node
      MERGE (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey, id: node.id})
      SET n.workspaceId = $workspaceId, n.kind = node.kind, n.name = node.name, n.summary = node.summary, n.path = node.path`,
      { projectionKey, workspaceId: revision.workspaceId, nodes },
    )
  const claims = hydrateUnitsToProjectionClaims(units).sort((a, b) =>
    compareIds(a.id, b.id),
  )
  if (claims.length)
    await graph.executeQuery(workspaceClaimsQuery, { projectionKey, claims })
  // Count the edges that the graph holds. A claim without a target unit
  // writes no edge, so it does not count.
  if (nodes.length)
    await graph.executeQuery(
      `MATCH (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey})
      OPTIONAL MATCH (n)-[o:WorkspaceSignal {projectionKey: $projectionKey}]->()
      WITH n, count(o) AS outDegree
      OPTIONAL MATCH (n)<-[i:WorkspaceSignal {projectionKey: $projectionKey}]-()
      WITH n, outDegree, count(i) AS inDegree
      SET n.outDegree = outDegree, n.inDegree = inDegree, n.degree = outDegree + inDegree`,
      { projectionKey },
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
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
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
  await withGraphClient(
    { orgId: requireCurrentOrgId(), orgSlug: requireCurrentOrgSlug() },
    () =>
      writeWorkspaceRevisionGraph(getGraphClient(), {
        revision,
        units: snapshot.units,
      }),
  )
  return persistWorkspaceGraphResult({ revision, result: { kind: "ready" } })
}

export class WorkspaceGraphUnavailableError extends Error {
  override readonly name = "WorkspaceGraphUnavailableError"
}

/** The graph phase is ready, but the graph store has no complete graph for that revision. */
export class WorkspaceGraphMissingError extends Error {
  override readonly name = "WorkspaceGraphMissingError"
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
      throw new WorkspaceGraphMissingError(
        "Workspace graph projection is unavailable.",
      )
    const nodeResult = await graph.executeQuery(
      `MATCH (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey})
      RETURN n.id AS id, n.kind AS kind, n.name AS name, n.summary AS summary ORDER BY n.id`,
      { projectionKey },
    )
    const nodeSchema = z.object({
      id: z.string(),
      kind: z.string(),
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
      throw new WorkspaceGraphMissingError(
        "Workspace graph projection is unavailable.",
      )
    return workspaceGraphFromSignals({
      nodes,
      claims,
      lastUpdatedAt: z.string().parse(complete.get("completedAt")),
    })
  })
}
