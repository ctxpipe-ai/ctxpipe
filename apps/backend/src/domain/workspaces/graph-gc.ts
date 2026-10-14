import { log } from "../../observability/logger.js"
import { getGraphClient, withGraphClient } from "../../platform/graph/client.js"
import { workspaceGraphRevisionKey } from "./graph-projection.js"
import type { ProjectionState, WorkspaceRevision } from "./revision.js"
import { publishedProjection } from "./revision.js"

/**
 * A key that no Workspace uses keeps its graph this long. A chat turn holds
 * the revision that it captured at its start, so it can still read an old key
 * for a while after a new revision is published.
 */
const inactiveGraceMs = 24 * 60 * 60 * 1000

/** One run removes at most this many keys, so a run stays short. */
const keysPerRun = 20

/** The graph keys that one Workspace uses, and whether its graph is settled. */
export type WorkspaceGraphUse = {
  workspaceId: string
  /** The keys of the published revision, of its previous revision, and of the desired revision. */
  keys: ReadonlySet<string>
  /** False while the active revision has no ready graph. Its old keys stay until then. */
  settled: boolean
}

/** Find the graph keys that a Workspace serves or can write now. */
export function workspaceGraphUse(
  workspaceId: string,
  state: ProjectionState,
): WorkspaceGraphUse {
  const published = publishedProjection(state)
  const revisions: WorkspaceRevision[] = []
  if (published?.kind === "active") revisions.push(published.revision)
  if ((state.kind === "building" || state.kind === "failed") && state.desired)
    revisions.push(state.desired)
  return {
    workspaceId,
    keys: new Set(revisions.map(workspaceGraphRevisionKey)),
    settled:
      published?.kind !== "active" || published.stores.graph.kind === "ready",
  }
}

type Marker = {
  key: string
  workspaceId: string | null
  inactiveSince: string | null
}

/**
 * Remove the graph data of projection keys that no Workspace uses. Call it
 * from a periodic job, never from the write path.
 *
 * Rules:
 * - A key in use by a Workspace stays. This covers the served key and the key
 *   that a rebuild writes. `loadUse` runs again right before a removal, so a
 *   Workspace that adopted a key in the meantime keeps it.
 * - A key without a completion marker stays. It can be a write in progress.
 * - A key that has no use first gets an `inactiveSince` time on its marker.
 *   It goes only on a run after the grace period. A key that comes back into
 *   use loses that time.
 * - A Workspace whose active graph is not ready keeps its old keys.
 * - Each run removes at most `keysPerRun` keys. A second run finds nothing to
 *   remove.
 */
export async function collectInactiveWorkspaceGraphKeys(input: {
  orgId: string
  orgSlug: string
  loadUse: () => Promise<readonly WorkspaceGraphUse[]>
  now?: Date
}): Promise<{ removed: number }> {
  const now = input.now ?? new Date()
  const cutoff = now.getTime() - inactiveGraceMs
  return withGraphClient(input, async () => {
    const graph = getGraphClient()
    const result = await graph.executeQuery(
      "MATCH (p:WorkspaceProjection) RETURN p.projectionKey AS key, p.workspaceId AS workspaceId, p.inactiveSince AS inactiveSince",
    )
    const markers: Marker[] = result.records.flatMap((row) => {
      const key = row.get("key")
      if (typeof key !== "string") return []
      const workspaceId = row.get("workspaceId")
      const inactiveSince = row.get("inactiveSince")
      return [
        {
          key,
          workspaceId: typeof workspaceId === "string" ? workspaceId : null,
          inactiveSince:
            typeof inactiveSince === "string" ? inactiveSince : null,
        },
      ]
    })
    const inactive = (use: readonly WorkspaceGraphUse[], marker: Marker) =>
      !use.some((item) => item.keys.has(marker.key)) &&
      use.find((item) => item.workspaceId === marker.workspaceId)?.settled !==
        false

    const use = await input.loadUse()
    const toMark = markers.filter(
      (marker) => marker.inactiveSince === null && inactive(use, marker),
    )
    const toClear = markers.filter(
      (marker) => marker.inactiveSince !== null && !inactive(use, marker),
    )
    if (toMark.length)
      await graph.executeQuery(
        "UNWIND $keys AS key MATCH (p:WorkspaceProjection {projectionKey: key}) SET p.inactiveSince = $now",
        { keys: toMark.map((marker) => marker.key), now: now.toISOString() },
      )
    if (toClear.length)
      await graph.executeQuery(
        "UNWIND $keys AS key MATCH (p:WorkspaceProjection {projectionKey: key}) REMOVE p.inactiveSince",
        { keys: toClear.map((marker) => marker.key) },
      )

    const due = markers
      .filter(
        (marker) =>
          marker.inactiveSince !== null &&
          !toClear.includes(marker) &&
          Date.parse(marker.inactiveSince) <= cutoff,
      )
      .slice(0, keysPerRun)
    if (due.length === 0) {
      if (toMark.length)
        log.info({
          event: "workspace_graph_gc",
          message: "Marked unused workspace graph keys",
          marked: toMark.length,
          removed: 0,
        })
      return { removed: 0 }
    }
    // Read the use again: a Workspace can adopt a key after the first read.
    const freshUse = await input.loadUse()
    let removed = 0
    for (const marker of due) {
      if (!inactive(freshUse, marker)) continue
      // Remove the nodes and their edges first, the marker last. A run that
      // stops in between leaves the marker, so the next run finishes the job.
      // A reader sees a marker without its nodes as a missing graph.
      await graph.executeQuery(
        "MATCH (n:WorkspaceKnowledgeUnit {projectionKey: $key}) DETACH DELETE n",
        { key: marker.key },
      )
      await graph.executeQuery(
        "MATCH (p:WorkspaceProjection {projectionKey: $key}) DELETE p",
        { key: marker.key },
      )
      removed += 1
    }
    log.info({
      event: "workspace_graph_gc",
      message: "Removed unused workspace graph keys",
      marked: toMark.length,
      removed,
    })
    return { removed }
  })
}
