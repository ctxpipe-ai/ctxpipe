import { assertNotInOrgDbContext } from "../../db/client.js"
import type { WorkspaceSourceRow } from "../../models/workspace-sources.js"
import { log } from "../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../../openworkflow/client.js"
import { workspaceSourcesSync } from "../../openworkflow/workflows/workspace-sources-sync.js"
import { SOURCE_ADAPTERS } from "./adapter.js"
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
  /**
   * A key for one provider change. A second enqueue with the same key (a
   * repeated webhook delivery) starts no new run.
   */
  dedupeKey?: string
}): Promise<void> {
  assertNotInOrgDbContext()
  const { dedupeKey, ...workflowInput } = input
  await runWorkflowWithWorkerWake(
    workspaceSourcesSync.spec,
    { kind: "connection", ...workflowInput },
    dedupeKey
      ? {
          idempotencyKey: `workspace-sources:${input.connectionId}:${dedupeKey}`,
        }
      : undefined,
  )
}

/** A provider without a sync adapter (GitHub) has nothing to sync or clean up. */
function hasAdapter(provider: string | null): boolean {
  const parsed = sourceProviderSchema.safeParse(provider)
  return parsed.success && SOURCE_ADAPTERS[parsed.data] !== undefined
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
    .filter((row) => row.status === "ok" && hasAdapter(row.provider))
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
    if (
      row.status === "ok" &&
      row.connectionId &&
      provider.success &&
      hasAdapter(provider.data)
    )
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
