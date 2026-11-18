import { createHash, randomUUID } from "node:crypto"

import { z } from "zod"

import {
  requireCurrentOrgId,
  requireCurrentOrgSlug,
} from "../../auth/context.js"
import {
  getWorkspaceProjectionSnapshot,
  getWorkspaceProjectionState,
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
 * gives each Workspace a new key, so a ready revision has no graph under its
 * key. The graph read then starts a rebuild, which projects it again.
 * Version 3 stores validity bounds as fixed-format UTC timestamps.
 */
const workspaceGraphProjectionVersion = 3

/**
 * The graph key of a Workspace binding: the projection version, the
 * Workspace, the generation, the remote and the default branch. The SHA is
 * not part of the key, so each commit updates one graph in place. The
 * `WorkspaceProjection` marker of the key holds the revision of the graph.
 */
export function workspaceGraphKey(revision: WorkspaceRevision): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectionVersion: workspaceGraphProjectionVersion,
        workspaceId: revision.workspaceId,
        generation: revision.generation,
        remote: {
          url: revision.remote.url,
          connectionId: revision.remote.connectionId,
        },
        defaultBranch: revision.defaultBranch,
      }),
    )
    .digest("hex")
}

/** A key for one rebuild trigger of one revision (the graph key has no SHA). */
export function workspaceGraphRebuildKey(revision: WorkspaceRevision): string {
  return `${workspaceGraphKey(revision)}:${revision.sha}`
}

/** The marker's revision value. Key order is fixed, so one revision gives one value. */
function markerRevision(revision: WorkspaceRevision): string {
  return JSON.stringify(workspaceRevisionSchema.parse(revision))
}

/** Write the edge `r` of each `claim` between its two units. */
const claimEdgeClause = `MATCH (s:WorkspaceKnowledgeUnit {projectionKey: $projectionKey, id: claim.subjectId})
MATCH (t:WorkspaceKnowledgeUnit {projectionKey: $projectionKey, id: claim.objectId})
MERGE (s)-[r:WorkspaceSignal {projectionKey: $projectionKey, id: claim.id}]->(t)
SET r.predicate = claim.predicate, r.confidence = claim.aggregatedConfidence,
    r.validFrom = claim.validFrom, r.validTo = claim.validTo,
    r.source = claim.source, r.lastObservedAt = claim.lastObservedAt`

/** Write one revision's claims as edges between its units. */
export const workspaceClaimsQuery = `UNWIND $claims AS claim
${claimEdgeClause}`

/** Set the degrees of each node that `node` matches. */
const degreeClause = `OPTIONAL MATCH (n)-[o:WorkspaceSignal {projectionKey: $projectionKey}]->()
      WITH n, count(o) AS outDegree,
        sum(CASE WHEN o.predicate = $fromSource THEN 1 ELSE 0 END) AS provenanceDegree
      OPTIONAL MATCH (n)<-[i:WorkspaceSignal {projectionKey: $projectionKey}]-()
      WITH n, outDegree, provenanceDegree, count(i) AS inDegree
      SET n.outDegree = outDegree, n.inDegree = inDegree,
        n.degree = outDegree - provenanceDegree + inDegree`

const nodePropertiesSetClause =
  "SET n.workspaceId = $workspaceId, n.kind = node.kind, n.name = node.name, n.summary = node.summary, n.path = node.path"

function graphClaims(units: readonly HydrateUnit[]) {
  return hydrateUnitsToProjectionClaims(units).map((claim) => ({
    ...claim,
    validFrom: normalizeValidityBound(claim.validFrom),
    validTo: normalizeValidityBound(claim.validTo),
  }))
}

/** What one graph write wrote. */
export type WorkspaceGraphWrite = {
  mode: "partial" | "full"
  /** Why a write with a delta wrote the full graph. */
  fullReason?: "graph_base_mismatch" | "graph_delta_failed"
  nodesWritten: number
  edgesWritten: number
}

/**
 * Write the complete graph of one revision under the Workspace's graph key.
 * The graph does not depend on the order of the units, and a second write of
 * the same revision replaces the first. Readers that need a stable order sort
 * by id in Cypher.
 *
 * The write takes more than one query, so the first query removes the
 * marker's `completedAt`: a reader during the write sees a missing graph
 * (`WorkspaceGraphMissingError`) and retries. The last query sets the marker
 * only when no other write started after this one.
 */
export async function writeWorkspaceRevisionGraph(
  graph: GraphClient,
  input: { revision: WorkspaceRevision; units: readonly HydrateUnit[] },
): Promise<WorkspaceGraphWrite> {
  const { revision, units } = input
  const projectionKey = workspaceGraphKey(revision)
  // An index makes the claim write fast, but the graph is correct without it.
  await ensureWorkspaceGraphIndexes(graph, getConfig().provider).catch(
    (error: unknown) =>
      log.warn({
        event: "workspace_graph_index_failed",
        workspaceId: revision.workspaceId,
        message: error instanceof Error ? error.message : String(error),
      }),
  )
  const writer = randomUUID()
  await graph.executeQuery(
    `MERGE (p:WorkspaceProjection {projectionKey: $projectionKey})
      SET p.writer = $writer, p.completedAt = null, p.writes = coalesce(p.writes, 0) + 1`,
    { projectionKey, writer },
  )
  // Write the graph clean. A rebuild after a partial or lost graph must not
  // keep stale nodes, or the read count check never matches.
  await graph.executeQuery(
    "MATCH (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey}) DETACH DELETE n",
    { projectionKey },
  )
  const nodes = workspaceGraphNodes(units)
  if (nodes.length)
    await graph.executeQuery(
      `UNWIND $nodes AS node
      MERGE (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey, id: node.id})
      ${nodePropertiesSetClause}`,
      { projectionKey, workspaceId: revision.workspaceId, nodes },
    )
  const claims = graphClaims(units)
  if (claims.length)
    await graph.executeQuery(workspaceClaimsQuery, { projectionKey, claims })
  // Count the edges that the graph holds. A claim without a target unit
  // writes no edge, so it does not count. The hub penalty uses `degree`: a
  // unit's own edge to its source (FROM_SOURCE) does not make it a hub, so
  // `degree` does not count it. The source still counts each such edge.
  if (nodes.length)
    await graph.executeQuery(
      `MATCH (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey})
      ${degreeClause}`,
      { projectionKey, fromSource: FROM_SOURCE_PREDICATE },
    )
  const marked = await graph.executeQuery(
    `MATCH (p:WorkspaceProjection {projectionKey: $projectionKey})
      WHERE p.writer = $writer
      SET p.workspaceId = $workspaceId, p.revision = $revision, p.nodeCount = $nodeCount, p.claimCount = $claimCount, p.completedAt = $completedAt
      RETURN p.projectionKey AS projectionKey`,
    {
      projectionKey,
      writer,
      workspaceId: revision.workspaceId,
      revision: markerRevision(revision),
      nodeCount: nodes.length,
      claimCount: claims.length,
      completedAt: new Date().toISOString(),
    },
  )
  if (!marked.records.length)
    throw new Error("Another graph write started during this graph write")
  return {
    mode: "full",
    nodesWritten: nodes.length,
    edgesWritten: claims.length,
  }
}

/**
 * The changes of one hydrate: the new unit set and the units that the
 * Postgres commit wrote or removed, relative to the `base` revision.
 */
type WorkspaceGraphDelta = {
  base: WorkspaceRevision
  /**
   * All units of the new revision, as Postgres stores them. A unit that the
   * commit did not write can have no body: the delta reads only the body of
   * a written unit (for its node summary).
   */
  units: readonly HydrateUnit[]
  changedUnitIds: readonly string[]
  removedUnitIds: readonly string[]
}

/**
 * Apply a delta to the graph of the `base` revision in one query. The graph
 * store runs one query atomically, so a reader sees the base graph or the
 * new graph, never a mix. The query changes nothing unless the marker holds
 * the complete graph of the base revision (a compare-and-set). Returns null
 * in that case.
 *
 * 1. Remove the nodes of the changed and removed units, with their edges.
 * 2. Write the nodes of the changed units again.
 * 3. Write the claims of the changed units, and the claims of the other
 *    units that point to a changed unit (step 1 removed those edges).
 * 4. Set the degrees of the written nodes and of their old and new
 *    neighbors.
 * 5. Set the marker's revision, counts and `completedAt`.
 */
async function applyWorkspaceGraphDelta(
  graph: GraphClient,
  input: { revision: WorkspaceRevision; delta: WorkspaceGraphDelta },
): Promise<WorkspaceGraphWrite | null> {
  const { revision, delta } = input
  const changed = new Set(delta.changedUnitIds)
  const nodes = workspaceGraphNodes(
    delta.units.filter((unit) => changed.has(unit.servingId)),
  )
  const claims = graphClaims(delta.units).filter(
    (claim) => changed.has(claim.subjectId) || changed.has(claim.objectId),
  )
  const touched = [
    ...new Set([
      ...changed,
      ...claims.flatMap((claim) => [claim.subjectId, claim.objectId]),
    ]),
  ]
  const result = await graph.executeQuery(
    `MATCH (p:WorkspaceProjection {projectionKey: $projectionKey})
    WHERE p.revision = $baseRevision AND p.completedAt IS NOT NULL
    CALL {
      WITH p
      UNWIND $dropIds AS dropId
      MATCH (d:WorkspaceKnowledgeUnit {projectionKey: $projectionKey, id: dropId})
      OPTIONAL MATCH (d)-[e:WorkspaceSignal {projectionKey: $projectionKey}]-(nb:WorkspaceKnowledgeUnit {projectionKey: $projectionKey})
      RETURN count(DISTINCT d) AS droppedNodes, count(DISTINCT e) AS droppedEdges, collect(DISTINCT nb.id) AS oldNeighbors
    }
    CALL {
      WITH p
      UNWIND $dropIds AS dropId
      MATCH (d:WorkspaceKnowledgeUnit {projectionKey: $projectionKey, id: dropId})
      DETACH DELETE d
      RETURN count(*) AS deleted
    }
    CALL {
      WITH p
      UNWIND $nodes AS node
      MERGE (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey, id: node.id})
      ${nodePropertiesSetClause}
      RETURN count(n) AS writtenNodes
    }
    CALL {
      WITH p
      UNWIND $claims AS claim
      ${claimEdgeClause}
      RETURN count(r) AS writtenEdges
    }
    CALL {
      WITH p, oldNeighbors
      UNWIND ($touched + oldNeighbors) AS touchedId
      WITH DISTINCT touchedId
      MATCH (n:WorkspaceKnowledgeUnit {projectionKey: $projectionKey, id: touchedId})
      ${degreeClause}
      RETURN count(n) AS touchedNodes
    }
    SET p.revision = $revision,
      p.nodeCount = p.nodeCount - droppedNodes + writtenNodes,
      p.claimCount = p.claimCount - droppedEdges + writtenEdges,
      p.completedAt = $completedAt, p.writes = coalesce(p.writes, 0) + 1
    RETURN writtenNodes, writtenEdges`,
    {
      projectionKey: workspaceGraphKey(revision),
      baseRevision: markerRevision(delta.base),
      revision: markerRevision(revision),
      workspaceId: revision.workspaceId,
      dropIds: [...changed, ...delta.removedUnitIds],
      nodes,
      claims,
      touched,
      fromSource: FROM_SOURCE_PREDICATE,
      completedAt: new Date().toISOString(),
    },
  )
  const record = result.records[0]
  if (!record) return null
  return {
    mode: "partial",
    nodesWritten: Number(record.get("writtenNodes")),
    edgesWritten: Number(record.get("writtenEdges")),
  }
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

/**
 * Build the derived graph of the active revision. With a delta, apply the
 * delta to the graph of its base revision (`applyWorkspaceGraphDelta`).
 * Without a delta, or when the graph store does not hold the complete graph
 * of the base, write the full graph from the captured PostgreSQL projection,
 * never by parsing Git again. Returns null when the revision is not active.
 */
export async function projectWorkspaceGraph(
  revision: WorkspaceRevision,
  delta?: WorkspaceGraphDelta,
): Promise<WorkspaceGraphWrite | null> {
  const org = { orgId: requireCurrentOrgId(), orgSlug: requireCurrentOrgSlug() }
  // The units with their bodies are read only for a full write.
  const snapshot = delta
    ? null
    : await getWorkspaceProjectionSnapshot(revision.workspaceId)
  const projection = publishedProjection(
    (snapshot ?? (await getWorkspaceProjectionState(revision.workspaceId)))
      .projection,
  )
  if (
    projection?.kind !== "active" ||
    !sameWorkspaceRevision(projection.revision, revision)
  )
    return null
  let fullReason: WorkspaceGraphWrite["fullReason"]
  if (delta) {
    try {
      const written = await withGraphClient(org, () =>
        applyWorkspaceGraphDelta(getGraphClient(), { revision, delta }),
      )
      if (written) {
        await persistWorkspaceGraphResult({
          revision,
          result: { kind: "ready" },
        })
        return written
      }
      fullReason = "graph_base_mismatch"
    } catch (error) {
      // A graph engine without CALL subqueries refuses the query. The query
      // is atomic, so the graph did not change: write the full graph.
      log.warn({
        event: "workspace_graph_delta_failed",
        workspaceId: revision.workspaceId,
        message: error instanceof Error ? error.message : String(error),
      })
      fullReason = "graph_delta_failed"
    }
  }
  const { units } =
    snapshot ?? (await getWorkspaceProjectionSnapshot(revision.workspaceId))
  const written = await withGraphClient(org, () =>
    writeWorkspaceRevisionGraph(getGraphClient(), { revision, units }),
  )
  await persistWorkspaceGraphResult({ revision, result: { kind: "ready" } })
  return { ...written, ...(fullReason ? { fullReason } : {}) }
}

/**
 * The marker of a graph key. `writes` counts the writes of the key: each
 * full write and each delta adds 1, so a reader can see that a write ran
 * between two of its queries.
 */
const markerQuery =
  "MATCH (p:WorkspaceProjection {projectionKey: $projectionKey}) RETURN p.nodeCount AS nodeCount, p.claimCount AS claimCount, p.completedAt AS completedAt, p.writes AS writes"

/** True when a marker row has the three fields of a complete graph. */
function completeMarker(record: { get: (key: string) => unknown } | undefined) {
  return (
    record !== undefined &&
    z.number().safeParse(record.get("nodeCount")).success &&
    z.number().safeParse(record.get("claimCount")).success &&
    z.string().safeParse(record.get("completedAt")).success
  )
}

/** True when the graph store holds a complete graph for the revision. */
export async function hasWorkspaceGraph(input: {
  orgId: string
  orgSlug: string
  revision: WorkspaceRevision
}): Promise<boolean> {
  return withGraphClient(input, async () => {
    const marker = await getGraphClient().executeQuery(markerQuery, {
      projectionKey: workspaceGraphKey(input.revision),
    })
    // The read path needs the same three fields; a marker without them is
    // lost. As for a read, a complete graph of a newer revision of the same
    // binding counts.
    return completeMarker(marker.records[0])
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
 *
 * A write changes the graph between two queries of `read`, so `read` can
 * see nodes of one revision and edges of another. Thus this function reads
 * the marker before and after `read`. When a write ran between them (the
 * marker's `writes` changed), it discards the result, and any
 * `WorkspaceGraphMissingError` of `read`, and runs `read` again. `read` must
 * start each run from an empty result.
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
  const projectionKey = workspaceGraphKey(projection.revision)
  const missing = () =>
    new WorkspaceGraphMissingError("Workspace graph projection is unavailable.")
  return withGraphClient(input, async () => {
    const client = getGraphClient()
    const readMarker = async () =>
      (await client.executeQuery(markerQuery, { projectionKey }, options))
        .records[0]
    for (let attempt = 1; ; attempt++) {
      const marker = await readMarker()
      // A full write removes `completedAt` while it runs. The marker can hold
      // a newer revision of the same binding than `projection`: that graph is
      // complete, so the read uses it.
      if (!marker || !completeMarker(marker)) throw missing()
      let result: { value: T } | { error: WorkspaceGraphMissingError }
      try {
        result = { value: await read({ client, projectionKey, marker }) }
      } catch (error) {
        if (!(error instanceof WorkspaceGraphMissingError)) throw error
        result = { error }
      }
      const after = await readMarker()
      if (
        after &&
        completeMarker(after) &&
        after.get("writes") === marker.get("writes")
      ) {
        if ("error" in result) throw result.error
        return result.value
      }
      // Writes come one at a time for each hydrate, so a third run that
      // also overlaps a write is improbable. Do not wait without limit.
      if (attempt === 3) throw missing()
    }
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
