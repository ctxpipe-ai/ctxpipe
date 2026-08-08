import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  clearLinearDirtyEntities,
  deadLetterLinearDirtyEntities,
  getLinearConnectionByConnectionId,
  getLinearSyncTargetWithRepoByConnectionId,
  listLinearDirtyEntities,
  refreshLinearConnectionTokensWithLock,
} from "../../models/linear-connector.js"
import { getLogger } from "../../observability/logger.js"
import {
  linearTokenExpiresAt,
  refreshLinearOAuthToken,
} from "../../services/linear/client.js"
import { loadLinearScopeFromRepo } from "../../services/linear/config-from-repo.js"
import { syncLinearIncrementalContent } from "../../services/linear/sync.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { runRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"

const LinearSyncIncrementalInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  retryAttempt: z.number().int().min(0).default(0),
})

const BATCH_SIZE = 100
const MAX_RETRY_ATTEMPTS = 5
const RETRY_DELAYS_MINUTES = [1, 5, 15, 60, 240] as const

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
        if (
          connection.status !== "installed" ||
          !target.enabled ||
          target.setupPhase !== "live"
        ) {
          return null
        }
        const config = await loadLinearScopeFromRepo({
          orgId: input.orgId,
          env,
          repositoryName: target.repositoryName,
          githubConnectionId: target.githubConnectionId,
          branch: target.branch,
        })
        if (!config) throw new Error("linear/config.yaml was not found")
        if (config.workspaceId !== connection.workspaceId) {
          throw new Error(
            "linear/config.yaml workspace does not match the Linear connection",
          )
        }
        return { connection, target, dirty, config }
      },
    )
    if (!context) {
      return { written: 0, deleted: 0, failures: [] }
    }
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
          onTokenRefresh: (expectedRefreshToken, expectedAccessToken) =>
            withOrgDbContext(input.orgId, () =>
              refreshLinearConnectionTokensWithLock({
                orgId: input.orgId,
                connectionId: input.connectionId,
                env,
                expectedRefreshToken,
                expectedAccessToken,
                refresh: async (refreshToken) => {
                  const token = await refreshLinearOAuthToken({
                    env,
                    refreshToken,
                  })
                  return {
                    accessToken: token.access_token,
                    refreshToken: token.refresh_token ?? refreshToken,
                    accessTokenExpiresAt: linearTokenExpiresAt(
                      token.expires_in,
                    ),
                  }
                },
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
    const exhaustedRows =
      result.failures.length > 0 && input.retryAttempt >= MAX_RETRY_ATTEMPTS
        ? context.dirty.filter((row) =>
            failedKeys.has(`${row.entityType}:${row.externalId}`),
          )
        : []
    if (exhaustedRows.length > 0) {
      getLogger().error(
        new Error(
          `${exhaustedRows.length} Linear updates exhausted automatic retries`,
        ),
        {
          step: "linear-sync-incremental.retries_exhausted",
          connectionId: input.connectionId,
          failedEntityCount: exhaustedRows.length,
        },
      )
    }
    await step.run({ name: "clear-linear-dirty-revisions" }, () =>
      clearLinearDirtyEntities(
        completedRows.map((row) => ({
          id: row.id,
          revision: row.revision,
        })),
      ),
    )
    if (exhaustedRows.length > 0) {
      await step.run({ name: "dead-letter-linear-dirty-revisions" }, () =>
        deadLetterLinearDirtyEntities(
          exhaustedRows.map((row) => ({
            id: row.id,
            revision: row.revision,
          })),
        ),
      )
    }

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

    const shouldContinueBatch =
      context.dirty.length === BATCH_SIZE &&
      completedRows.length + exhaustedRows.length > 0
    const shouldRetryFailures =
      result.failures.length > 0 && input.retryAttempt < MAX_RETRY_ATTEMPTS
    if (shouldContinueBatch || shouldRetryFailures) {
      const retryAttempt = shouldRetryFailures ? input.retryAttempt + 1 : 0
      const delayMinutes = shouldRetryFailures
        ? RETRY_DELAYS_MINUTES[
            Math.min(retryAttempt - 1, RETRY_DELAYS_MINUTES.length - 1)
          ]
        : undefined
      await runWorkflowWithWorkerWake(
        linearSyncIncremental.spec,
        {
          orgId: input.orgId,
          connectionId: input.connectionId,
          retryAttempt,
        },
        delayMinutes ? { availableAt: `${delayMinutes}m` } : undefined,
      )
    }
    return result
  },
)
