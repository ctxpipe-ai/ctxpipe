import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import { SOURCE_ADAPTERS } from "../../domain/workspace-sources/adapter.js"
import { sourceProviderSchema } from "../../domain/workspace-sources/sources-file.js"
import {
  addSourceSyncEvent,
  syncQueuedSourceEvents,
} from "../../domain/workspace-sources/sync-events.js"
import {
  cleanupRemovedSources,
  syncConnectionSources,
} from "../../domain/workspace-sources/sync.js"
import {
  readWorkspaceBlobs,
  writeWorkspaceSlice,
} from "../../domain/workspace-sources/write-slice.js"
import { getLogger } from "../../observability/logger.js"
import { enqueueWorkflow } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

export const workspaceSourcesSyncInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("connection"),
      orgId: z.string().min(1),
      connectionId: z.string().min(1),
      provider: sourceProviderSchema,
      /** A provider webhook event; only the matching sources sync. */
      event: z.unknown().optional(),
      /** "Sync now": its failures do not count toward the bounded tries. */
      manual: z.literal(true).optional(),
      /**
       * A coalesced sync (CTX-1595): it syncs the webhook events of the
       * connection that wait in `source_sync_events`.
       */
      queuedEvents: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cleanup"),
      orgId: z.string().min(1),
      workspaceId: z.string().min(1),
      revision: z.string().min(1),
      removed: z.array(
        z.object({
          provider: z.string().nullable(),
          connectionId: z.string().nullable(),
          scope: z.record(z.string(), z.unknown()),
        }),
      ),
    })
    .strict(),
])

/**
 * The wait of a coalesced sync after the oldest event that it syncs. The
 * webhooks of one connection in this window give one sync, and so one
 * connector mirror write and one merge for each Workspace (CTX-1595).
 */
const COALESCE_WINDOW_MS = 10 * 60 * 1000

/**
 * Queue one webhook event of a provider that coalesces its events
 * (`mergeEvents`). The event joins the coalesced sync that has not taken its
 * events yet, or starts one. Thus at most one sync of the connection waits,
 * and one more can run.
 */
export async function queueSourceSyncEvent(input: {
  orgId: string
  connectionId: string
  provider: z.infer<typeof sourceProviderSchema>
  event: unknown
}): Promise<void> {
  const oldest = await addSourceSyncEvent(input)
  if (!oldest) return
  let key = `workspace-sources:${input.connectionId}:events:${oldest.id}`
  for (;;) {
    const { workflowRun } = await enqueueWorkflow(
      workspaceSourcesSync.spec,
      {
        kind: "connection",
        orgId: input.orgId,
        connectionId: input.connectionId,
        provider: input.provider,
        queuedEvents: true,
      },
      {
        idempotencyKey: key,
        availableAt: new Date(oldest.createdAt.getTime() + COALESCE_WINDOW_MS),
      },
    )
    if (["pending", "running", "sleeping"].includes(workflowRun.status)) return
    // The run of the key ended before it took the oldest event (it failed or
    // was canceled). The next key starts a new run, and each webhook that
    // finds the same ended run gets the same next key.
    key = `${key}:after:${workflowRun.id}`
  }
}

/** ADR-050: fetch once for each connection, write for each Workspace. */
export const workspaceSourcesSync = defineWorkflow(
  { name: "workspace-sources-sync", schema: workspaceSourcesSyncInputSchema },
  async ({ input: queued, step, run }) => {
    const input = workspaceSourcesSyncInputSchema.parse(queued)
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const write = async (
      slice: Parameters<typeof writeWorkspaceSlice>[0],
    ): Promise<void> => {
      await writeWorkspaceSlice(slice, env)
    }
    if (input.kind === "cleanup")
      return step.run({ name: "cleanup-removed-sources" }, async () => ({
        writes: (
          await cleanupRemovedSources({
            orgId: input.orgId,
            workspaceId: input.workspaceId,
            revision: input.revision,
            removed: input.removed,
            adapters: SOURCE_ADAPTERS,
            write,
          })
        ).length,
      }))
    const adapter = SOURCE_ADAPTERS[input.provider]
    if (!adapter) return { fetchedScopes: 0, workspaces: [] }
    const sync = (event: unknown) =>
      syncConnectionSources({
        orgId: input.orgId,
        connectionId: input.connectionId,
        env,
        adapter,
        write,
        event,
        manual: input.manual,
        readExisting: (workspaceId, owners) =>
          readWorkspaceBlobs({ orgId: input.orgId, workspaceId, env, owners }),
      })
    if (adapter.mergeEvents && input.event !== undefined) {
      // A sync of one event, queued before the provider coalesced its
      // webhooks: the event joins the coalesced sync, and this run ends.
      await step.run({ name: "queue-event" }, () =>
        queueSourceSyncEvent({
          orgId: input.orgId,
          connectionId: input.connectionId,
          provider: input.provider,
          event: input.event,
        }),
      )
      getLogger().set({ sourcesSync: { handedOver: true } })
      return { fetchedScopes: 0, workspaces: [] }
    }
    if (input.queuedEvents) {
      const synced = await step.run({ name: "sync-queued-events" }, () =>
        syncQueuedSourceEvents({
          orgId: input.orgId,
          connectionId: input.connectionId,
          runId: run.id,
          adapter,
          sync,
        }),
      )
      getLogger().set({ sourcesSync: { coalescedEvents: synced.events } })
      return synced.result ?? { fetchedScopes: 0, workspaces: [] }
    }
    return step.run({ name: "sync-connection-sources" }, () =>
      sync(input.event),
    )
  },
)
