import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  activateConnectorSync,
  assertConnectorContentSyncBinding,
  captureConnectorConfigSyncBinding,
  connectorContentBindingSchema,
} from "../../models/connector-content-sync.js"
import {
  getNotionBindingWithRepoByConnectionId,
  transitionNotionBindingState,
} from "../../models/notion-connector.js"
import {
  closePullRequest,
  parseGithubPullNumberFromUrl,
} from "../../services/github/installation-write-client.js"
import { syncNotionConfigYaml } from "../../services/notion/sync.js"
import { enqueueConnectorContentSync } from "../enqueue-connector-content-sync.js"

const notionSyncConfigInputSchema = z.object({
  contentSyncBinding: connectorContentBindingSchema.optional(),
  configKey: z.string().optional(),
  contentSyncGeneration: z.number().int().nonnegative().default(0),
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  connectionId: z.string().min(1),
  resources: z.array(
    z.object({
      externalId: z.string().min(1),
      type: z.enum(["page", "database"]),
      title: z.string().min(1),
      url: z.string().nullable().optional(),
      parentExternalId: z.string().nullable().optional(),
    }),
  ),
})

export type NotionConfigSyncInput = z.input<typeof notionSyncConfigInputSchema>

export const notionSyncConfig = defineWorkflow(
  { name: "notion-sync-config", schema: notionSyncConfigInputSchema },
  async ({ input, step, run }) => {
    if (
      !input.contentSyncBinding &&
      (input.contentSyncGeneration ?? 0) === 0 &&
      (await step.run({ name: "recover-legacy-config-content" }, () =>
        enqueueConnectorContentSync({
          provider: "notion",
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
    const capturedBinding = await step.run(
      { name: "capture-config-binding" },
      () =>
        captureConnectorConfigSyncBinding({
          orgId: input.orgId,
          connectionId: input.connectionId,
          contentSyncGeneration: input.contentSyncGeneration ?? 0,
          contentSyncBinding: input.contentSyncBinding,
        }),
    )
    if (!capturedBinding)
      throw new Error("Connector configuration activation was superseded")
    const binding = await step.run({ name: "load-notion-binding" }, () =>
      getNotionBindingWithRepoByConnectionId(input.orgId, input.connectionId),
    )
    if (!binding) throw new Error("Notion binding is not configured")
    if (binding.orgId !== input.orgId) {
      throw new Error("Notion binding does not belong to organization")
    }
    if (
      !binding.enabled ||
      binding.setupPhase !== "awaiting_merge" ||
      !binding.pendingConfigPrCreating
    ) {
      throw new Error("Notion binding is not ready for configuration sync")
    }

    if (
      binding.repositoryId !== capturedBinding.repositoryId ||
      binding.branch !== capturedBinding.branch
    )
      throw new Error("Connector configuration target was superseded")
    const result = await step.run({ name: "sync-config" }, async () => {
      await assertConnectorContentSyncBinding({
        ...input,
        contentSyncBinding: input.contentSyncBinding ?? capturedBinding,
      })
      return syncNotionConfigYaml({
        orgId: input.orgId,
        orgSlug: input.orgSlug,
        env: parseEnv(process.env),
        connectionId: input.connectionId,
        binding,
        resources: input.resources,
      })
    })
    if (result.changed) {
      const transitioned = await step.run(
        { name: "persist-config-pr-state" },
        () =>
          withOrgDbContext(input.orgId, () =>
            transitionNotionBindingState({
              connectionId: input.connectionId,
              expectedContentSyncGeneration: input.contentSyncGeneration ?? 0,
              expectedSetupPhase: "awaiting_merge",
              expectedPendingConfigPrCreating: true,
              repositoryId: binding.repositoryId,
              branch: binding.branch,
              pendingConfigPullUrl: result.pullUrl ?? null,
              pendingConfigPrCreating: false,
              setupPhase: "awaiting_merge",
            }),
          ),
      )
      if (!transitioned) {
        await step.run({ name: "close-superseded-config-pr" }, async () => {
          const pullNumber = result.pullUrl
            ? parseGithubPullNumberFromUrl(result.pullUrl)
            : undefined
          if (!pullNumber || !binding.githubConnectionId)
            throw new Error("Configuration PR cleanup context is missing")
          await closePullRequest({
            orgId: input.orgId,
            env: parseEnv(process.env),
            repositoryName: binding.repositoryName,
            githubConnectionId: binding.githubConnectionId,
            pullNumber,
            comment:
              "Closed because the Notion connector target changed during configuration sync.",
          })
        })
        throw new Error("Notion binding changed during configuration sync")
      }
    } else {
      await step.run({ name: "enqueue-initial-content-sync" }, async () => {
        if (
          !(await enqueueConnectorContentSync({
            orgId: input.orgId,
            orgSlug: input.orgSlug,
            connectionId: input.connectionId,
            provider: "notion",
            repositoryId: binding.repositoryId,
            branch: binding.branch,
            configKey: `config-workflow:${run.id}`,
          }))
        )
          throw new Error("Notion binding changed during configuration sync")
      })
    }
    return result
  },
)
