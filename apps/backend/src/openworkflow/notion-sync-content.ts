import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../config/env.js"
import { withOrgDbContext } from "../db/client.js"
import {
  finalizeNotionSyncTargetAfterContentWorkflow,
  getNotionConnectionByConnectionId,
  getNotionSyncTargetByConnectionId,
  listNotionResourcesByConnectionId,
} from "../models/notion-connector.js"
import { syncNotionContent } from "../services/notion/sync.js"
import { parsedNotionRepoScopeSchema } from "./notion-scope-repo-schema.js"

const notionSyncContentInputSchema = z.object({
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  connectionId: z.string().min(1),
  scopeFromRepo: parsedNotionRepoScopeSchema.optional(),
})

export const notionSyncContent = defineWorkflow(
  { name: "notion-sync-content", schema: notionSyncContentInputSchema },
  async ({ input, step }) => {
    const context = await step.run({ name: "load-notion-sync-context" }, () =>
      withOrgDbContext(input.orgId, async () => ({
        connection: await getNotionConnectionByConnectionId(
          input.orgId,
          input.connectionId,
        ),
        target: await getNotionSyncTargetByConnectionId(input.connectionId),
        resources: await listNotionResourcesByConnectionId(input.connectionId),
      })),
    )
    if (!context.connection?.accessToken) {
      throw new Error("Notion connection is not ready for sync")
    }
    if (!context.target) {
      throw new Error("Notion sync target is not configured")
    }
    const notionConnection = context.connection
    const target = context.target

    const contentResult = await step.run({ name: "sync-content" }, () =>
      syncNotionContent({
        orgId: input.orgId,
        env: parseEnv(process.env as Record<string, string | undefined>),
        notionConnection,
        target,
        resources: context.resources,
        scopeFromRepo: input.scopeFromRepo,
      }),
    )

    await step.run({ name: "finalize-setup-phase" }, () =>
      withOrgDbContext(input.orgId, () =>
        finalizeNotionSyncTargetAfterContentWorkflow({
          connectionId: input.connectionId,
          workflowStatus: contentResult.status,
        }),
      ),
    )

    return {
      status: contentResult.status,
      resourcesProcessed: contentResult.resourcesProcessed,
      resourcesFailed: contentResult.resourcesFailed,
      commitShas: contentResult.commitSha ? [contentResult.commitSha] : [],
      errors: contentResult.errors,
    }
  },
)
