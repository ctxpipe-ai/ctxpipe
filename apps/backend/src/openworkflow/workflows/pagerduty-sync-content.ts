import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { captureConnectorMirrorTarget } from "../../domain/workspaces/capture-connector-mirror.js"
import {
  finalizePagerdutyBindingAfterContentWorkflow,
  getPagerdutyBindingWithRepoByConnectionId,
  getPagerdutyConnectionByConnectionId,
} from "../../models/pagerduty-connector.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import { parsePagerdutyConfigYamlContent } from "../../services/pagerduty/config-yaml.js"
import { capturePagerdutyContent } from "../../services/pagerduty/sync.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { isWorkflowControlSignal } from "../isSleepSignal.js"
import { workspaceConnectorMirror } from "./workspace-connector-mirror.js"

const pagerdutySyncContentInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
})

export const pagerdutySyncContent = defineWorkflow(
  {
    name: "pagerduty-sync-content",
    schema: pagerdutySyncContentInputSchema,
  },
  async ({ input, step, run }) =>
    withLogger(
      createLogger({
        workflow: "pagerduty-sync-content",
        orgId: input.orgId,
        connectionId: input.connectionId,
      }),
      async () => {
        const env = parseEnv(process.env as Record<string, string | undefined>)
        const markSyncFailed = () =>
          withOrgDbContext(input.orgId, () =>
            finalizePagerdutyBindingAfterContentWorkflow({
              connectionId: input.connectionId,
              workflowStatus: "failed",
            }),
          )
        const context = await step
          .run({ name: "load-pagerduty-sync-context" }, async () => {
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
              binding.orgId !== input.orgId ||
              !binding.enabled ||
              binding.setupPhase !== "initial_sync"
            ) {
              throw new Error("PagerDuty binding is not ready for initial sync")
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
            return { connection, binding, captured, config }
          })
          .catch(async (error) => {
            await markSyncFailed()
            throw error
          })

        try {
          const captured = await step.run(
            { name: "capture-pagerduty-content" },
            () =>
              capturePagerdutyContent({
                orgId: input.orgId,
                env,
                connection: context.connection,
                config: context.config,
                existingPaths: context.captured.paths,
              }),
          )
          if (
            captured.status !== "failed" &&
            (captured.files.length || captured.deletePaths.length)
          ) {
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

          await step.run({ name: "finalize-setup-phase" }, () =>
            withOrgDbContext(input.orgId, () =>
              finalizePagerdutyBindingAfterContentWorkflow({
                connectionId: input.connectionId,
                workflowStatus: captured.status,
              }),
            ),
          )

          return {
            status: captured.status,
            resourcesProcessed: captured.resourcesProcessed,
            resourcesFailed: captured.resourcesFailed,
            commitShas: [],
            errors: captured.errors,
          }
        } catch (error) {
          if (isWorkflowControlSignal(error)) throw error
          await markSyncFailed()
          throw error
        }
      },
    ),
)
