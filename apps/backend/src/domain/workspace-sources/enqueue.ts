import { assertNotInOrgDbContext } from "../../db/client.js"
import type { WorkspaceSourceRow } from "../../models/workspace-sources.js"
import { log } from "../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../../openworkflow/client.js"
import { workspaceSourcesSync } from "../../openworkflow/workflows/workspace-sources-sync.js"
import type { PlannedSourceRow } from "./projection-plan.js"
import { type SourceProvider, sourceProviderSchema } from "./sources-file.js"

/**
 * Sync one connection for all its `ok` sources. A provider webhook passes its
 * `event`, and then only the sources that match the event sync.
 */
export async function enqueueConnectionSourcesSync(input: {
  orgId: string
  connectionId: string
  provider: SourceProvider
  event?: unknown
}): Promise<void> {
  assertNotInOrgDbContext()
  await runWorkflowWithWorkerWake(workspaceSourcesSync.spec, {
    kind: "connection",
    ...input,
  })
}

/**
 * After a projection: delete the managed files of removed or changed sources
 * that no other source owns, and sync each connection that gained or changed
 * an `ok` source.
 */
export async function enqueueSourceProjectionFollowUps(input: {
  orgId: string
  workspaceId: string
  /** The Workspace revision of the projection. */
  revision: string
  projected: {
    added: PlannedSourceRow[]
    changed: Array<{ before: WorkspaceSourceRow; after: PlannedSourceRow }>
    removed: WorkspaceSourceRow[]
  }
}): Promise<void> {
  assertNotInOrgDbContext()
  const removed = [
    ...input.projected.removed,
    ...input.projected.changed.map((change) => change.before),
  ]
    .filter((row) => row.status === "ok")
    .map(({ provider, connectionId, scope }) => ({
      provider,
      connectionId,
      scope,
    }))
  if (removed.length)
    await runWorkflowWithWorkerWake(workspaceSourcesSync.spec, {
      kind: "cleanup",
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      revision: input.revision,
      removed,
    })
  const connections = new Map<string, SourceProvider>()
  for (const row of [
    ...input.projected.added,
    ...input.projected.changed.map((change) => change.after),
  ]) {
    const provider = sourceProviderSchema.safeParse(row.provider)
    if (row.status === "ok" && row.connectionId && provider.success)
      connections.set(row.connectionId, provider.data)
  }
  for (const [connectionId, provider] of connections) {
    try {
      await enqueueConnectionSourcesSync({
        orgId: input.orgId,
        connectionId,
        provider,
      })
    } catch (error) {
      log.error({
        step: "workspace_sources.enqueue_sync",
        connectionId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
