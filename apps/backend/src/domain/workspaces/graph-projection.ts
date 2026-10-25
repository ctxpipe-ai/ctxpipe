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
import { log } from "../../observability/logger.js"
import {
  type GraphClient,
  getConfig,
  getGraphClient,
  withGraphClient,
} from "../../platform/graph/client.js"
import { ensureWorkspaceGraphIndexes } from "../../platform/graph/indexes.js"
import { FROM_SOURCE_PREDICATE } from "./graph-relevance.js"
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
 * Version 3 stores validity bounds as fixed-format UTC timestamps.
 */
const workspaceGraphProjectionVersion = 3

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
 * Write the complete graph of one revision. The graph does not depend on the
 * order of the units, and a second write of the same revision replaces the first.
 * Readers that need a stable order sort by id in Cypher.
 */
export async function writeWorkspaceRevisionGraph(
  graph: GraphClient,
  input: { revision: WorkspaceRevision; units: readonly HydrateUnit[] },
): Promise<void> {
  const { revision, units } = input
  const projectionKey = workspaceGraphRevisionKey(revision)
  // An index makes the claim write fast, but the graph is correct without it.
  await ensureWorkspaceGraphIndexes(graph, getConfig().provider).catch(
    (error: unknown) =>
      log.warn({
        event: "workspace_graph_index_failed",
        workspaceId: revision.workspaceId,
        message: error instanceof Error ? error.message : String(error),
      }),
  )
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
  const nodes = workspaceGraphNodes(units)
  if (nodes.length)
    await graph.executeQuery(
      `UNWIND $nodes AS node
      MERGE (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey, id: node.id})
      SET n.workspaceId = $workspaceId, n.kind = node.kind, n.name = node.name, n.summary = node.summary, n.path = node.path`,
      { projectionKey, workspaceId: revision.workspaceId, nodes },
    )
  const claims = hydrateUnitsToProjectionClaims(units).map((claim) => ({
    ...claim,
    validFrom: normalizeValidityBound(claim.validFrom),
    validTo: normalizeValidityBound(claim.validTo),
  }))
  if (claims.length)
    await graph.executeQuery(workspaceClaimsQuery, { projectionKey, claims })
  // Count the edges that the graph holds. A claim without a target unit
  // writes no edge, so it does not count. The hub penalty uses `degree`: a
  // unit's own edge to its source (FROM_SOURCE) does not make it a hub, so
  // `degree` does not count it. The source still counts each such edge.
  if (nodes.length)
    await graph.executeQuery(
      `MATCH (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey})
      OPTIONAL MATCH (n)-[o:WorkspaceSignal {projectionKey: $projectionKey}]->()
      WITH n, count(o) AS outDegree,
        sum(CASE WHEN o.predicate = $fromSource THEN 1 ELSE 0 END) AS provenanceDegree
      OPTIONAL MATCH (n)<-[i:WorkspaceSignal {projectionKey: $projectionKey}]-()
      WITH n, outDegree, provenanceDegree, count(i) AS inDegree
      SET n.outDegree = outDegree, n.inDegree = inDegree,
        n.degree = outDegree - provenanceDegree + inDegree`,
      { projectionKey, fromSource: FROM_SOURCE_PREDICATE },
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

/** A non-time value is no bound. A time without an offset uses UTC. */
function normalizeValidityBound(value: string | null): string | null {
  const raw = value?.trim()
  if (!raw || !/^\d{4}-\d{2}-\d{2}/.test(raw)) return null
  const utc =
    raw.length > 10 && !/(?:z|[+-]\d{2}(?::?\d{2})?)$/i.test(raw.slice(10))
      ? `${raw}Z`
      : raw
  const time = new Date(utc)
  return Number.isNaN(time.getTime()) ? null : time.toISOString()
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

/** True when the graph store holds a complete graph for the revision. */
export async function hasWorkspaceGraph(input: {
  orgId: string
  orgSlug: string
  revision: WorkspaceRevision
}): Promise<boolean> {
  return withGraphClient(input, async () => {
    const marker = await getGraphClient().executeQuery(
      "MATCH (p:WorkspaceProjection {projectionKey: $projectionKey}) RETURN p.nodeCount AS nodeCount, p.claimCount AS claimCount, p.completedAt AS completedAt",
      { projectionKey: workspaceGraphRevisionKey(input.revision) },
    )
    const record = marker.records[0]
    // The read path needs the same three fields; a marker without them is lost.
    return (
      record !== undefined &&
      z.number().safeParse(record.get("nodeCount")).success &&
      z.number().safeParse(record.get("claimCount")).success &&
      z.string().safeParse(record.get("completedAt")).success
    )
  })
}

export class WorkspaceGraphUnavailableError extends Error {
  override readonly name = "WorkspaceGraphUnavailableError"
}

/** The graph phase is ready, but the graph store has no complete graph for that revision. */
export class WorkspaceGraphMissingError extends Error {
  override readonly name = "WorkspaceGraphMissingError"
}

type WorkspaceGraphReadInput = {
  orgId: string
  orgSlug: string
  projection: PublishedProjection | null
}

/**
 * Run `read` on the graph of the published revision when the graph store
 * holds its completion marker. A graph without the marker gives
 * `WorkspaceGraphMissingError`.
 */
export async function withCompleteWorkspaceGraph<T>(
  input: WorkspaceGraphReadInput,
  read: (graph: {
    client: GraphClient
    projectionKey: string
    marker: { get: (key: string) => unknown }
  }) => Promise<T>,
  options?: { deadline?: number },
): Promise<T> {
  const projection = input.projection
  if (projection?.kind !== "active" || projection.stores.graph.kind !== "ready")
    throw new WorkspaceGraphUnavailableError(
      "Workspace graph projection is unavailable.",
    )
  const projectionKey = workspaceGraphRevisionKey(projection.revision)
  return withGraphClient(input, async () => {
    const client = getGraphClient()
    const result = await client.executeQuery(
      "MATCH (p:WorkspaceProjection {projectionKey: $projectionKey}) RETURN p.nodeCount AS nodeCount, p.claimCount AS claimCount, p.completedAt AS completedAt",
      { projectionKey },
      options,
    )
    const marker = result.records[0]
    if (!marker)
      throw new WorkspaceGraphMissingError(
        "Workspace graph projection is unavailable.",
      )
    return read({ client, projectionKey, marker })
  })
}

/** Read one immutable derived graph; missing/corrupt data never becomes an empty Postgres fallback. */
export async function readWorkspaceGraph(input: WorkspaceGraphReadInput) {
  return withCompleteWorkspaceGraph(input, async (store) => {
    const { client: graph, projectionKey, marker: complete } = store
    const nodeResult = await graph.executeQuery(
      `MATCH (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey})
      RETURN n.id AS id, n.kind AS kind, n.name AS name, n.summary AS summary, n.path AS path ORDER BY n.id`,
      { projectionKey },
    )
    const nodeSchema = z.object({
      id: z.string(),
      kind: z.string(),
      name: z.string().nullable(),
      summary: z.string().nullable(),
      path: z.string(),
    })
    const nodes = nodeResult.records.map((row) =>
      nodeSchema.parse({
        id: row.get("id"),
        kind: row.get("kind"),
        name: row.get("name"),
        summary: row.get("summary"),
        path: row.get("path"),
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
