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
  getLinearBindingWithRepoByConnectionId,
  getLinearConnectionByConnectionId,
  transitionLinearBindingState,
} from "../../models/linear-connector.js"
import { closePullRequest } from "../../services/github/installation-write-client.js"
import { syncLinearConfigYaml } from "../../services/linear/sync.js"
import { enqueueConnectorContentSync } from "../enqueue-connector-content-sync.js"

const LinearSyncConfigInputSchema = z.object({
  contentSyncBinding: connectorContentBindingSchema.optional(),
  configKey: z.string().optional(),
  contentSyncGeneration: z.number().int().nonnegative().default(0),
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  connectionId: z.string().min(1),
  scopes: z.array(
    z.object({
      externalId: z.string().min(1),
      type: z.enum(["team", "project", "document", "initiative"]),
      title: z.string().min(1),
      url: z.string().url().nullable(),
      parentExternalId: z.string().nullable(),
      teamId: z.string().nullable(),
      teamKey: z.string().nullable(),
    }),
  ),
})

export type LinearConfigSyncInput = z.input<typeof LinearSyncConfigInputSchema>

export const linearSyncConfig = defineWorkflow(
  {
    name: "linear-sync-config",
    schema: LinearSyncConfigInputSchema,
  },
  async ({ input, step, run }) => {
    if (
      !input.contentSyncBinding &&
      (input.contentSyncGeneration ?? 0) === 0 &&
      (await step.run({ name: "recover-legacy-config-content" }, () =>
        enqueueConnectorContentSync({
          provider: "linear",
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
    const target = await step.run({ name: "load-linear-binding" }, () =>
      getLinearBindingWithRepoByConnectionId(input.orgId, input.connectionId),
    )
    if (
      !target?.enabled ||
      target.setupPhase !== "awaiting_merge" ||
      !target.pendingConfigPrCreating
    )
      throw new Error("Linear sync target is not ready for configuration sync")
    if (
      target.repositoryId !== capturedBinding.repositoryId ||
      target.branch !== capturedBinding.branch
    )
      throw new Error("Connector configuration target was superseded")
    const result = await step.run({ name: "sync-config" }, async () => {
      await assertConnectorContentSyncBinding({
        ...input,
        contentSyncBinding: input.contentSyncBinding ?? capturedBinding,
      })
      const env = parseEnv(process.env)
      const connection = await withOrgDbContext(input.orgId, () =>
        getLinearConnectionByConnectionId(input.orgId, input.connectionId, env),
      )
      if (!connection || connection.status !== "installed")
        throw new Error("Linear authorization is revoked")
      return syncLinearConfigYaml({
        orgId: input.orgId,
        orgSlug: input.orgSlug,
        env,
        connection,
        target,
        scopes: input.scopes,
      })
    })
    if (result.changed) {
      await step.run({ name: "persist-config-pr-state" }, async () => {
        const updated = await withOrgDbContext(input.orgId, () =>
          transitionLinearBindingState({
            connectionId: input.connectionId,
            expectedContentSyncGeneration: input.contentSyncGeneration ?? 0,
            expectedSetupPhase: "awaiting_merge",
            expectedPendingConfigPrCreating: true,
            repositoryId: target.repositoryId,
            branch: target.branch,
            pendingConfigPullUrl: result.pullUrl ?? null,
            pendingConfigPrCreating: false,
            setupPhase: "awaiting_merge",
          }),
        )
        if (!updated) {
          if (result.pullNumber && target.githubConnectionId)
            await closePullRequest({
              orgId: input.orgId,
              env: parseEnv(process.env),
              repositoryName: target.repositoryName,
              githubConnectionId: target.githubConnectionId,
              pullNumber: result.pullNumber,
              comment:
                "Closed because the Linear connector target changed during configuration sync.",
            })
          throw new Error(
            "Linear sync target changed during configuration sync",
          )
        }
      })
    } else {
      await step.run({ name: "enqueue-initial-content-sync" }, async () => {
        if (
          !(await enqueueConnectorContentSync({
            orgId: input.orgId,
            connectionId: input.connectionId,
            provider: "linear",
            repositoryId: target.repositoryId,
            branch: target.branch,
            configKey: `config-workflow:${run.id}`,
          }))
        )
          throw new Error(
            "Linear sync target changed during configuration sync",
          )
      })
    }
    return result
  },
)
