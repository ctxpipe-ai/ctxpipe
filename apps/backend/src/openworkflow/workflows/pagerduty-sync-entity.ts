import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { captureConnectorMirrorTarget } from "../../domain/workspaces/capture-connector-mirror.js"
import {
  getPagerdutyBindingWithRepoByConnectionId,
  getPagerdutyConnectionByConnectionId,
} from "../../models/pagerduty-connector.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import { parsePagerdutyConfigYamlContent } from "../../services/pagerduty/config-yaml.js"
import { capturePagerdutyIncrementalContent } from "../../services/pagerduty/sync.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { workspaceConnectorMirror } from "./workspace-connector-mirror.js"

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
  async ({ input, step, run }) =>
    withLogger(
      createLogger({
        workflow: "pagerduty-sync-entity",
        orgId: input.orgId,
        connectionId: input.connectionId,
      }),
      async () => {
        const env = parseEnv(process.env as Record<string, string | undefined>)
        const context = await step.run(
          {
            name: "load-pagerduty-entity-context",
            retryPolicy: { maximumAttempts: 1 },
          },
          async () => {
            const [connection, binding] = await Promise.all([
              getPagerdutyConnectionByConnectionId(
                input.orgId,
                input.connectionId,
                env,
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
            const captured = await captureConnectorMirrorTarget({
              repositoryGitUrl: binding.repositoryGitUrl,
              orgId: input.orgId,
              env,
              mirror: {
                provider: "pagerduty",
                connectionId: input.connectionId,
                repositoryId: binding.repositoryId,
              },
            })
            const config = parsePagerdutyConfigYamlContent(captured.config)
            if (!config) {
              throw new Error(
                "PagerDuty scope configuration is missing from the repository; expected pagerduty/config.yaml",
              )
            }
            return { binding, captured, config }
          },
        )
        if (!context) {
          return { written: 0, deleted: 0, errors: [] }
        }

        const captured = await step.run(
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
            const connection = await getPagerdutyConnectionByConnectionId(
              input.orgId,
              input.connectionId,
              env,
            )
            if (!connection || connection.status !== "installed") {
              throw new Error("PagerDuty authorization changed")
            }
            const syncResult = await capturePagerdutyIncrementalContent({
              orgId: input.orgId,
              env,
              connection,
              config: context.config,
              existingPaths: context.captured.paths,
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

        if (captured.files.length || captured.deletePaths.length) {
          await step.runWorkflow(
            workspaceConnectorMirror.spec,
            {
              orgId: input.orgId,
              workspaceId: context.captured.workspaceId,
              revision: context.captured.revision,
              mirror: context.captured.mirror,
              jobId: `wjob_${run.id}_mirror`,
              files: captured.files,
              deletePaths: captured.deletePaths,
            },
            { name: "commit-pagerduty-mirror" },
          )
        }

        return {
          written: captured.files.length,
          deleted: captured.deletePaths.length,
          errors: captured.errors,
        }
      },
    ),
)
