import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  finalizeLinearBindingAfterContentWorkflow,
  getLinearConnectionByConnectionId,
  getLinearBindingWithRepoByConnectionId,
  refreshLinearConnectionTokensWithLock,
} from "../../models/linear-connector.js"
import { getLogger } from "../../observability/logger.js"
import {
  linearTokenExpiresAt,
  refreshLinearOAuthToken,
} from "../../services/linear/client.js"
import { loadLinearScopeFromRepo } from "../../services/linear/config-from-repo.js"
import { syncLinearContentToGit } from "../../services/linear/sync.js"
import { runRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"

const LinearSyncContentInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
})

export const linearSyncContent = defineWorkflow(
  {
    name: "linear-sync-content",
    schema: LinearSyncContentInputSchema,
  },
  async ({ input, step }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const markSyncFailed = () =>
      withOrgDbContext(input.orgId, () =>
        finalizeLinearBindingAfterContentWorkflow({
          connectionId: input.connectionId,
          workflowStatus: "failed",
        }),
      )
    const context = await step
      .run({ name: "load-linear-sync-context" }, async () => {
        const target = await getLinearBindingWithRepoByConnectionId(
          input.orgId,
          input.connectionId,
        )
        if (!target?.githubConnectionId) {
          throw new Error("Linear sync target is not configured")
        }
        const [connection, config] = await Promise.all([
          withOrgDbContext(input.orgId, () =>
            getLinearConnectionByConnectionId(
              input.orgId,
              input.connectionId,
              env,
            ),
          ),
          loadLinearScopeFromRepo({
            orgId: input.orgId,
            env,
            repositoryName: target.repositoryName,
            githubConnectionId: target.githubConnectionId,
            branch: target.branch,
          }),
        ])
        if (!connection) throw new Error("Linear connection not found")
        if (connection.status !== "installed") {
          throw new Error("Linear authorization is revoked")
        }
        if (!target.enabled || target.setupPhase !== "initial_sync") {
          throw new Error("Linear sync target is not ready for initial sync")
        }
        if (!config) throw new Error("linear/config.yaml was not found")
        return { connection, target, config }
      })
      .catch(async (error) => {
        await markSyncFailed()
        throw error
      })

    try {
      const result = await step.run({ name: "mirror-linear-content" }, () =>
        syncLinearContentToGit({
          orgId: input.orgId,
          env,
          connection: context.connection,
          target: context.target,
          config: context.config,
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

      if (result.status !== "failed") {
        await step.run({ name: "ingest-linear-content" }, () =>
          runRepositoryIngestionWorkflow(
            {
              repositoryId: context.target.repositoryId,
              orgId: input.orgId,
              indexingReason: "Syncing Linear content",
            },
            {
              error: (error) =>
                getLogger().error(error, {
                  step: "linear-sync-content.ingestion",
                  connectionId: input.connectionId,
                }),
            },
          ),
        )
      }

      await step.run({ name: "finalize-linear-sync" }, () =>
        withOrgDbContext(input.orgId, () =>
          finalizeLinearBindingAfterContentWorkflow({
            connectionId: input.connectionId,
            workflowStatus: result.status,
          }),
        ),
      )
      return result
    } catch (error) {
      await markSyncFailed()
      throw error
    }
  },
)
