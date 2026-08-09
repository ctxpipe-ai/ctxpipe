import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getLinearConnectionByConnectionId,
  getLinearSyncTargetWithRepoByConnectionId,
  refreshLinearConnectionTokensWithLock,
} from "../../models/linear-connector.js"
import { getLogger } from "../../observability/logger.js"
import {
  linearTokenExpiresAt,
  refreshLinearOAuthToken,
} from "../../services/linear/client.js"
import { loadLinearScopeFromRepo } from "../../services/linear/config-from-repo.js"
import { syncLinearIncrementalContent } from "../../services/linear/sync.js"
import { runRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"

const LinearSyncEntityInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  entityType: z.enum([
    "cycle",
    "customerNeed",
    "document",
    "initiative",
    "issue",
    "issueLabel",
    "project",
    "team",
    "user",
  ]),
  externalId: z.string().min(1),
  action: z.enum(["upsert", "delete"]),
})

export const linearSyncEntity = defineWorkflow(
  {
    name: "linear-sync-entity",
    schema: LinearSyncEntityInputSchema,
  },
  async ({ input, step }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const context = await step.run(
      { name: "load-linear-entity-context" },
      async () => {
        const [connection, target] = await Promise.all([
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
        return { connection, target, config }
      },
    )
    if (!context) {
      return { written: 0, deleted: 0, failures: [] }
    }

    const result = await step.run(
      {
        name: "apply-linear-entity",
        retryPolicy: {
          maximumAttempts: 5,
          initialInterval: "1m",
          backoffCoefficient: 3,
          maximumInterval: "4h",
        },
      },
      async () => {
        const syncResult = await syncLinearIncrementalContent({
          orgId: input.orgId,
          env,
          connection: context.connection,
          target: context.target,
          config: context.config,
          entity: {
            entityType: input.entityType,
            externalId: input.externalId,
            action: input.action,
          },
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
        })
        if (syncResult.failures.length > 0) {
          throw new Error(
            `Linear entity sync failed: ${syncResult.failures
              .map(
                (failure) =>
                  `${failure.type}:${failure.id}: ${failure.message}`,
              )
              .join("; ")}`,
          )
        }
        return syncResult
      },
    )

    if (result.written > 0 || result.deleted > 0) {
      await step.run({ name: "ingest-linear-entity" }, () =>
        runRepositoryIngestionWorkflow(
          {
            repositoryId: context.target.repositoryId,
            orgId: input.orgId,
            indexingReason: "Applying Linear updates",
          },
          {
            error: (error) =>
              getLogger().error(error, {
                step: "linear-sync-entity.ingestion",
                connectionId: input.connectionId,
              }),
          },
        ),
      )
    }

    return result
  },
)
