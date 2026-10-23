import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  markWorkspaceGraphLost,
  persistWorkspaceGraphResult,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import {
  hasWorkspaceGraph,
  readWorkspaceGraph,
  WorkspaceGraphMissingError,
  workspaceGraphRevisionKey,
} from "./graph-projection.js"
import type { PublishedProjection, WorkspaceRevision } from "./revision.js"

/** The graph of the active revision is being written. Read it again later. */
export class WorkspaceGraphBuildingError extends Error {
  override readonly name = "WorkspaceGraphBuildingError"
}

type GraphOrg = { orgId: string; orgSlug: string }

/**
 * Start one hydrate run that writes the lost graph of a ready revision again
 * from PostgreSQL. The graph phase goes back to pending. Only the first caller
 * for each loss starts the run.
 */
async function rebuildLostWorkspaceGraph(
  input: GraphOrg & { revision: WorkspaceRevision },
): Promise<void> {
  const { orgId, revision } = input
  await withOrgIdContext({ id: orgId, slug: input.orgSlug }, async () => {
    const lostAt = await markWorkspaceGraphLost(revision)
    if (!lostAt) return
    log.warn({
      event: "workspace_graph_rebuild_started",
      message:
        "Workspace graph is missing from the graph store; starting a rebuild",
      workspaceId: revision.workspaceId,
    })
    try {
      // A lazy import: the OpenWorkflow client connects to the database when
      // it loads, and chat tools import this module.
      const { enqueueWorkspaceGraphRebuild } = await import(
        "../../openworkflow/enqueue-workspace-hydrate.js"
      )
      await enqueueWorkspaceGraphRebuild({
        orgId,
        revision,
        revisionKey: workspaceGraphRevisionKey(revision),
        lostAt,
      })
    } catch (error) {
      await persistWorkspaceGraphResult({
        revision,
        result: { kind: "failed", message: "Could not start the rebuild" },
      })
      throw error
    }
  })
}

/**
 * Start one hydrate run when the graph or the index phase of the active
 * revision failed, for example while the graph store was down. That run
 * builds each phase that is not ready again, with no new commit. The run key
 * holds the UTC hour, so a phase that fails again gets its next run in the
 * next hour, not on each read. Resolves true while that run is not finished.
 */
async function retryFailedWorkspacePhases(
  input: GraphOrg & { projection: PublishedProjection | null },
): Promise<boolean> {
  const { projection } = input
  if (
    projection?.kind !== "active" ||
    (projection.stores.graph.kind !== "failed" &&
      projection.stores.index.kind !== "failed")
  )
    return false
  const hour = new Date()
  hour.setUTCMinutes(0, 0, 0)
  // A lazy import, for the same cause as in `rebuildLostWorkspaceGraph`.
  const { enqueueWorkspaceGraphRebuild } = await import(
    "../../openworkflow/enqueue-workspace-hydrate.js"
  )
  return enqueueWorkspaceGraphRebuild({
    orgId: input.orgId,
    revision: projection.revision,
    revisionKey: workspaceGraphRevisionKey(projection.revision),
    lostAt: hour,
  })
}

/**
 * Read the graph of the published revision. Each graph reader (the graph
 * route, chat, MCP tools) uses this function. A graph that is pending, or
 * that the graph store lost, gives `WorkspaceGraphBuildingError`; a lost
 * graph also starts its rebuild. A failed graph or index phase starts a
 * retry.
 */
export async function readOrRebuildWorkspaceGraph(
  input: GraphOrg & { projection: PublishedProjection | null },
) {
  return readOrRebuild(input, readWorkspaceGraph)
}

/**
 * Run one graph read with the state rules of `readOrRebuildWorkspaceGraph`.
 * A bounded read (for example `expandWorkspaceGraph`) uses this function.
 */
export async function readOrRebuild<
  I extends GraphOrg & { projection: PublishedProjection | null },
  T,
>(input: I, read: (input: I) => Promise<T>): Promise<T> {
  const { projection } = input
  const retried = await retryFailedWorkspacePhases(input).catch(
    (error: unknown) => {
      log.warn({
        event: "workspace_phase_retry_failed",
        message: error instanceof Error ? error.message : String(error),
      })
      return false
    },
  )
  if (
    retried &&
    projection?.kind === "active" &&
    projection.stores.graph.kind === "failed"
  )
    throw new WorkspaceGraphBuildingError("Workspace graph is being built.")
  if (
    projection?.kind === "active" &&
    projection.stores.graph.kind === "pending"
  )
    throw new WorkspaceGraphBuildingError("Workspace graph is being built.")
  try {
    return await read(input)
  } catch (error) {
    if (
      !(error instanceof WorkspaceGraphMissingError) ||
      projection?.kind !== "active"
    )
      throw error
    await rebuildLostWorkspaceGraph({ ...input, revision: projection.revision })
    throw new WorkspaceGraphBuildingError("Workspace graph is being built.")
  }
}

/**
 * Start a rebuild when the graph phase of the active revision is ready but
 * the graph store has no graph under its key. This occurs after a new
 * projection version and after the graph store loses data.
 */
export async function rebuildWorkspaceGraphWhenMissing(
  input: GraphOrg & { projection: PublishedProjection | null },
): Promise<boolean> {
  const { projection } = input
  if (projection?.kind !== "active" || projection.stores.graph.kind !== "ready")
    return false
  if (await hasWorkspaceGraph({ ...input, revision: projection.revision }))
    return false
  await rebuildLostWorkspaceGraph({ ...input, revision: projection.revision })
  return true
}
