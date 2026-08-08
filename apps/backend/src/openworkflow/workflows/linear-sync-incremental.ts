import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  clearLinearDirtyEntities,
  getLinearConnectionByConnectionId,
  getLinearSyncTargetWithRepoByConnectionId,
  listLinearDirtyEntities,
  updateLinearConnectionTokens,
} from "../../models/linear-connector.js"
import { getLogger } from "../../observability/logger.js"
import { loadLinearScopeFromRepo } from "../../services/linear/config-from-repo.js"
import { syncLinearIncrementalContent } from "../../services/linear/sync.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { runRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"

const LinearSyncIncrementalInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
})

const BATCH_SIZE = 100

export const linearSyncIncremental = defineWorkflow(
  {
    name: "linear-sync-incremental",
    schema: LinearSyncIncrementalInputSchema,
  },
  async ({ input, step }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const context = await step.run(
      { name: "load-linear-incremental-context" },
      async () => {
        const [connection, target, dirty] = await Promise.all([
          withOrgDbContext(input.orgId, () =>
            getLinearConnectionByConnectionId(
              input.orgId,
              input.connectionId,
              env,
            ),
          ),
          getLinearSyncTargetWithRepoByConnectionId(
            input.orgId,
            input.connectionId,
          ),
          listLinearDirtyEntities({
            connectionId: input.connectionId,
            limit: BATCH_SIZE,
          }),
        ])
        if (!connection) throw new Error("Linear connection not found")
        if (!target?.githubConnectionId) {
          throw new Error("Linear sync target is not configured")
        }
        const config = await loadLinearScopeFromRepo({
          orgId: input.orgId,
          env,
          repositoryName: target.repositoryName,
          githubConnectionId: target.githubConnectionId,
          branch: target.branch,
        })
        if (!config) throw new Error("linear/config.yaml was not found")
        return { connection, target, dirty, config }
      },
    )
    if (context.dirty.length === 0) {
      return { written: 0, deleted: 0, failures: [] }
    }

    const result = await step.run(
      { name: "apply-linear-incremental-content" },
      () =>
        syncLinearIncrementalContent({
          orgId: input.orgId,
          env,
          connection: context.connection,
          target: context.target,
          config: context.config,
          dirty: context.dirty,
          onTokenRefresh: (tokens) =>
            withOrgDbContext(input.orgId, () =>
              updateLinearConnectionTokens({
                orgId: input.orgId,
                connectionId: input.connectionId,
                env,
                ...tokens,
              }),
            ),
        }),
    )

    const failedKeys = new Set(
      result.failures.map((failure) => `${failure.type}:${failure.id}`),
    )
    const completedRows = context.dirty.filter(
      (row) => !failedKeys.has(`${row.entityType}:${row.externalId}`),
    )
    await step.run({ name: "clear-linear-dirty-revisions" }, () =>
      clearLinearDirtyEntities(
        completedRows.map((row) => ({ id: row.id, revision: row.revision })),
      ),
    )

    if (result.written > 0 || result.deleted > 0) {
      await step.run({ name: "ingest-linear-incremental-content" }, () =>
        runRepositoryIngestionWorkflow(
          {
            repositoryId: context.target.repositoryId,
            orgId: input.orgId,
            indexingReason: "Applying Linear updates",
          },
          {
            error: (error) =>
              getLogger().error(error, {
                step: "linear-sync-incremental.ingestion",
                connectionId: input.connectionId,
              }),
          },
        ),
      )
    }

    if (context.dirty.length === BATCH_SIZE && result.failures.length === 0) {
      await runWorkflowWithWorkerWake(linearSyncIncremental.spec, input)
    }
    return result
  },
)
