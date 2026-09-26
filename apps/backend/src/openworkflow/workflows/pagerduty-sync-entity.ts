import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getPagerdutyBindingWithRepoByConnectionId,
  getPagerdutyConnectionByConnectionId,
} from "../../models/pagerduty-connector.js"
import { getLogger } from "../../observability/logger.js"
import { loadPagerdutyScopeFromRepo } from "../../services/pagerduty/config-from-repo.js"
import { syncPagerdutyIncrementalContent } from "../../services/pagerduty/sync.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { runConnectorRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"

const pagerdutySyncEntityInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  incidentId: z.string().min(1),
})

export const pagerdutySyncEntity = defineWorkflow(
  {
    name: "pagerduty-sync-entity",
    schema: pagerdutySyncEntityInputSchema,
  },
  async ({ input, step }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const context = await step.run(
      { name: "load-pagerduty-entity-context" },
      async () => {
        const [connection, binding] = await Promise.all([
          withOrgDbContext(input.orgId, () =>
            getPagerdutyConnectionByConnectionId(
              input.orgId,
              input.connectionId,
              env,
            ),
          ),
          getPagerdutyBindingWithRepoByConnectionId(
            input.orgId,
            input.connectionId,
          ),
        ])
        if (!connection) {
          throw new Error("PagerDuty connection is not ready for sync")
        }
        if (!binding?.githubConnectionId) {
          throw new Error("PagerDuty binding is not configured")
        }
        if (
          connection.status !== "installed" ||
          !binding.enabled ||
          binding.setupPhase !== "live"
        ) {
          return null
        }
        const config = await loadPagerdutyScopeFromRepo({
          orgId: input.orgId,
          env,
          repositoryName: binding.repositoryName,
          githubConnectionId: binding.githubConnectionId,
          branch: binding.branch,
        })
        if (!config) {
          throw new Error(
            "PagerDuty scope configuration is missing from the repository; expected pagerduty/config.yaml",
          )
        }
        return { binding, connection, config }
      },
    )
    if (!context) {
      return { written: 0, deleted: 0, errors: [] }
    }

    const result = await step.run(
      {
        name: "apply-pagerduty-entity",
        retryPolicy: {
          maximumAttempts: 5,
          initialInterval: "1m",
          backoffCoefficient: 3,
          maximumInterval: "4h",
        },
      },
      async () => {
        const syncResult = await syncPagerdutyIncrementalContent({
          orgId: input.orgId,
          env,
          connection: context.connection,
          binding: context.binding,
          config: context.config,
          entity: {
            incidentId: input.incidentId,
          },
        })
        if (syncResult.status === "failed") {
          throw new Error(
            `PagerDuty entity sync failed: ${syncResult.errors
              .map((error) => `${error.externalId}: ${error.message}`)
              .join("; ")}`,
          )
        }
        return syncResult
      },
    )

    await runConnectorRepositoryIngestionWorkflow(
      step,
      {
        repositoryId: context.binding.repositoryId,
        orgId: input.orgId,
        targetBranch: context.binding.branch,
        indexingReason: "Applying PagerDuty updates",
      },
      {
        error: (error) =>
          getLogger().error(error, {
            step: "pagerduty-sync-entity.ingestion",
            connectionId: input.connectionId,
          }),
      },
    )

    return {
      written: result.written,
      deleted: result.deleted,
      errors: result.errors,
    }
  },
)
