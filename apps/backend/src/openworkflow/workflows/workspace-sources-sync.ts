import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import { SOURCE_ADAPTERS } from "../../domain/workspace-sources/adapter.js"
import { sourceProviderSchema } from "../../domain/workspace-sources/sources-file.js"
import {
  cleanupRemovedSources,
  syncConnectionSources,
} from "../../domain/workspace-sources/sync.js"
import {
  readWorkspaceBlobs,
  writeWorkspaceSlice,
} from "../../domain/workspace-sources/write-slice.js"
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

/** ADR-050: fetch once for each connection, write for each Workspace. */
export const workspaceSourcesSync = defineWorkflow(
  { name: "workspace-sources-sync", schema: workspaceSourcesSyncInputSchema },
  async ({ input: queued, step }) => {
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
    return step.run({ name: "sync-connection-sources" }, () =>
      syncConnectionSources({
        orgId: input.orgId,
        connectionId: input.connectionId,
        env,
        adapter,
        write,
        event: input.event,
        manual: input.manual,
        readExisting: (workspaceId, owners) =>
          readWorkspaceBlobs({ orgId: input.orgId, workspaceId, env, owners }),
      }),
    )
  },
)
