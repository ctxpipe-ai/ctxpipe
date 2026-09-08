import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getConfluenceSyncTargetWithRepoByConnectionId,
  updateConfluenceSyncTargetPrState,
} from "../../models/confluence-sync-target.js"
import {
  activateConnectorSync,
  captureConnectorConfigSyncBinding,
  connectorContentBindingSchema,
} from "../../models/connector-content-sync.js"
import { syncConfluenceConfigYaml } from "../../services/confluence/sync.js"
import {
  closePullRequest,
  parseGithubPullNumberFromUrl,
} from "../../services/github/installation-write-client.js"
import { enqueueConnectorContentSync } from "../enqueue-connector-content-sync.js"

const confluenceSyncConfigInputSchema = z.object({
  spaces: z
    .array(
      z.object({
        spaceKey: z.string().min(1),
        selectedPageIds: z.array(z.string()).nullable(),
      }),
    )
    .optional(),
  contentSyncBinding: connectorContentBindingSchema.optional(),
  configKey: z.string().optional(),
  contentSyncGeneration: z.number().int().nonnegative().default(0),
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  connectionId: z.string().min(1),
})

export type ConfluenceConfigSyncInput = z.input<
  typeof confluenceSyncConfigInputSchema
>

export const confluenceSyncConfig = defineWorkflow(
  {
    name: "confluence-sync-config",
    schema: confluenceSyncConfigInputSchema,
  },
  async ({ input, step, run }) => {
    if (
      !input.contentSyncBinding &&
      (input.contentSyncGeneration ?? 0) === 0 &&
      (await step.run({ name: "recover-legacy-config-content" }, () =>
        enqueueConnectorContentSync({
          provider: "confluence",
          orgId: input.orgId,
          orgSlug: input.orgSlug,
          connectionId: input.connectionId,
          legacyConfigRecovery: true,
          configKey: `legacy-config:${run.id}`,
        }),
      ))
    )
      return { changed: false }
    if (
      !(await step.run({ name: "activate-config-sync" }, () =>
        activateConnectorSync({
          purpose: "config",
          orgId: input.orgId,
          connectionId: input.connectionId,
          workflowRunId: run.id,
        }),
      ))
    )
      throw new Error("Connector configuration activation was superseded")
    if (
      !(await step.run({ name: "capture-config-binding" }, () =>
        captureConnectorConfigSyncBinding({
          orgId: input.orgId,
          connectionId: input.connectionId,
          contentSyncGeneration: input.contentSyncGeneration ?? 0,
        }),
      ))
    )
      throw new Error("Connector configuration activation was superseded")
    const target = await step.run({ name: "load-confluence-binding" }, () =>
      getConfluenceSyncTargetWithRepoByConnectionId(
        input.orgId,
        input.connectionId,
      ),
    )
    if (
      !target ||
      target.orgId !== input.orgId ||
      !target.enabled ||
      target.setupPhase !== "awaiting_merge" ||
      !target.pendingConfigPrCreating
    )
      throw new Error(
        "Confluence sync target is not ready for configuration sync",
      )
    const result = await step.run({ name: "sync-config" }, () =>
      syncConfluenceConfigYaml({
        orgId: input.orgId,
        orgSlug: input.orgSlug,
        env: parseEnv(process.env),
        connectionId: input.connectionId,
        target,
        spaces: input.spaces,
      }),
    )
    if (result.changed) {
      const transitioned = await step.run(
        { name: "persist-config-pr-state" },
        () =>
          withOrgDbContext(input.orgId, () =>
            updateConfluenceSyncTargetPrState({
              connectionId: input.connectionId,
              pendingConfigPullUrl: result.pullUrl ?? null,
              pendingConfigPrCreating: false,
              setupPhase: "awaiting_merge",
              expectedBinding: {
                contentSyncGeneration: input.contentSyncGeneration ?? 0,
                repositoryId: target.repositoryId,
                branch: target.branch,
              },
            }),
          ),
      )
      if (!transitioned) {
        await step.run({ name: "close-superseded-config-pr" }, async () => {
          const pullNumber = result.pullUrl
            ? parseGithubPullNumberFromUrl(result.pullUrl)
            : undefined
          if (!pullNumber || !target.githubConnectionId)
            throw new Error("Configuration PR cleanup context is missing")
          await closePullRequest({
            orgId: input.orgId,
            env: parseEnv(process.env),
            repositoryName: target.repositoryName,
            githubConnectionId: target.githubConnectionId,
            pullNumber,
            comment:
              "Closed because the Confluence connector target changed during configuration sync.",
          })
        })
        throw new Error("Confluence binding changed during configuration sync")
      }
    } else {
      await step.run({ name: "enqueue-initial-content-sync" }, async () => {
        if (
          !(await enqueueConnectorContentSync({
            orgId: input.orgId,
            orgSlug: input.orgSlug,
            connectionId: input.connectionId,
            provider: "confluence",
            repositoryId: target.repositoryId,
            branch: target.branch,
            configKey: `config-workflow:${run.id}`,
          }))
        )
          throw new Error(
            "Confluence sync target changed during configuration sync",
          )
      })
    }
    return result
  },
)
