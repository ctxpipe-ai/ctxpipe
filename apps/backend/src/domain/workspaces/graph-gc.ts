import { listOrgWorkspaceProjections } from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import { getGraphClient, withGraphClient } from "../../platform/graph/client.js"
import { workspaceGraphRevisionKey } from "./graph-projection.js"
import type { ProjectionState, WorkspaceRevision } from "./revision.js"
import { publishedProjection } from "./revision.js"

/**
 * A key that no Workspace uses keeps its graph this long. A chat turn holds
 * the revision that it captured at its start, so it can still read an old key
 * for a while after a new revision is published. A turn that runs longer than
 * this can lose its graph.
 */
export const inactiveGraceMs = 24 * 60 * 60 * 1000

/** Find the graph keys that a Workspace serves or can write now. */
export function workspaceGraphKeys(state: ProjectionState): string[] {
  const published = publishedProjection(state)
  const revisions: WorkspaceRevision[] = []
  if (published?.kind === "active") revisions.push(published.revision)
  if ((state.kind === "building" || state.kind === "failed") && state.desired)
    revisions.push(state.desired)
  return revisions.map(workspaceGraphRevisionKey)
}

/**
 * The graph keys that the Workspaces of the org use: the published revision
 * and the desired revision of each one. One query reads all Workspaces.
 */
export async function loadWorkspaceGraphKeysInUse(
  orgId: string,
): Promise<ReadonlySet<string>> {
  return new Set(
    (await listOrgWorkspaceProjections(orgId)).flatMap(workspaceGraphKeys),
  )
}

/**
 * Remove the graph data of projection keys that no Workspace uses. Call it
 * from a periodic job, never from the write path.
 *
 * Rules:
 * - A key in use by a Workspace stays. This covers the served key and the key
 *   that a rebuild writes. `loadUse` runs again right before each removal, so
 *   a Workspace that adopted a key in the meantime keeps it.
 * - A key that has no use first gets an `inactiveSince` time on its marker.
 *   It goes only on a run after the grace period. A key that comes back into
 *   use loses that time.
 * - A key with nodes but no completion marker (a write that stopped before it
 *   finished) gets a marker with `inactiveSince` when no Workspace uses it. It
 *   goes after the same grace period. Readers see this marker as a missing
 *   graph, so they never serve it.
 * - Each run removes at most 20 keys. A second run finds nothing to remove.
 *
 * The marker does not hold the org. The graph store keeps one graph for each
 * org, and this job reads only the graph of `orgId`. If two orgs shared one
 * graph, each job could remove the keys of the other org.
 */
export async function collectInactiveWorkspaceGraphKeys(input: {
  orgId: string
  orgSlug: string
  loadUse: () => Promise<ReadonlySet<string>>
  now?: Date
}): Promise<{ removed: number }> {
  const now = input.now ?? new Date()
  const cutoff = now.getTime() - inactiveGraceMs
  return withGraphClient(input, async () => {
    const graph = getGraphClient()
    const markerRows = await graph.executeQuery(
      "MATCH (p:WorkspaceProjection) RETURN p.projectionKey AS key, p.inactiveSince AS inactiveSince",
    )
    const nodeRows = await graph.executeQuery(
      "MATCH (n:WorkspaceKnowledgeUnit) RETURN DISTINCT n.projectionKey AS key",
    )
    const inactiveSince = new Map<string, string | null>()
    for (const row of markerRows.records) {
      const key = row.get("key")
      const since = row.get("inactiveSince")
      if (typeof key === "string")
        inactiveSince.set(key, typeof since === "string" ? since : null)
    }
    for (const row of nodeRows.records) {
      const key = row.get("key")
      if (typeof key === "string" && !inactiveSince.has(key))
        inactiveSince.set(key, null)
    }

    const use = await input.loadUse()
    const keys = [...inactiveSince.keys()]
    const toMark = keys.filter(
      (key) => inactiveSince.get(key) === null && !use.has(key),
    )
    const toClear = keys.filter(
      (key) => inactiveSince.get(key) !== null && use.has(key),
    )
    // MERGE also makes the marker of a key whose write stopped early.
    if (toMark.length)
      await graph.executeQuery(
        "UNWIND $keys AS key MERGE (p:WorkspaceProjection {projectionKey: key}) SET p.inactiveSince = $now",
        { keys: toMark, now: now.toISOString() },
      )
    if (toClear.length)
      await graph.executeQuery(
        "UNWIND $keys AS key MATCH (p:WorkspaceProjection {projectionKey: key}) REMOVE p.inactiveSince",
        { keys: toClear },
      )

    const due = keys
      .filter((key) => {
        const since = inactiveSince.get(key)
        return since != null && !use.has(key) && Date.parse(since) <= cutoff
      })
      // One run removes at most 20 keys, so a run stays short.
      .slice(0, 20)
    let removed = 0
    for (const key of due) {
      // Read the use again before each removal: a Workspace can adopt a key
      // while an earlier removal runs.
      if ((await input.loadUse()).has(key)) continue
      // Remove the nodes and their edges first, the marker last. A run that
      // stops in between leaves the marker, so the next run finishes the job.
      // A reader sees a marker without its nodes as a missing graph.
      await graph.executeQuery(
        "MATCH (n:WorkspaceKnowledgeUnit {projectionKey: $key}) DETACH DELETE n",
        { key },
      )
      await graph.executeQuery(
        "MATCH (p:WorkspaceProjection {projectionKey: $key}) DELETE p",
        { key },
      )
      removed += 1
    }
    if (toMark.length || removed)
      log.info({
        event: "workspace_graph_gc",
        message: "Removed unused workspace graph keys",
        marked: toMark.length,
        removed,
      })
    return { removed }
  })
}
