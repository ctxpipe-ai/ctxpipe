import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getLinearConnectionByConnectionId,
  getLinearSyncTargetWithRepoByConnectionId,
  transitionLinearSyncTargetState,
} from "../../models/linear-connector.js"
import { closePullRequest } from "../../services/github/installation-write-client.js"
import { syncLinearConfigYaml } from "../../services/linear/sync.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { linearSyncContent } from "./linear-sync-content.js"

const LinearSyncConfigInputSchema = z.object({
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

export const linearSyncConfig = defineWorkflow(
  {
    name: "linear-sync-config",
    schema: LinearSyncConfigInputSchema,
  },
  async ({ input }) => {
    const target = await getLinearSyncTargetWithRepoByConnectionId(
      input.orgId,
      input.connectionId,
    )
    if (!target) throw new Error("Linear sync target is not configured")
    if (
      !target.enabled ||
      target.setupPhase !== "awaiting_merge" ||
      !target.pendingConfigPrCreating
    ) {
      throw new Error("Linear sync target is not ready for configuration sync")
    }

    let failurePhase: "config_failed" | "sync_failed" = "config_failed"
    let expectedPhase: "awaiting_merge" | "initial_sync" = "awaiting_merge"
    let expectedPendingConfigPrCreating = true
    try {
      const env = parseEnv(process.env as Record<string, string | undefined>)
      const connection = await withOrgDbContext(input.orgId, () =>
        getLinearConnectionByConnectionId(input.orgId, input.connectionId, env),
      )
      if (!connection) throw new Error("Linear connection not found")
      if (connection.status !== "installed") {
        throw new Error("Linear authorization is revoked")
      }
      const result = await syncLinearConfigYaml({
        orgId: input.orgId,
        orgSlug: input.orgSlug,
        env,
        connection,
        target,
        scopes: input.scopes,
      })
      if (result.changed) {
        const updated = await withOrgDbContext(input.orgId, () =>
          transitionLinearSyncTargetState({
            connectionId: input.connectionId,
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
          if (result.pullNumber && target.githubConnectionId) {
            await closePullRequest({
              orgId: input.orgId,
              env,
              repositoryName: target.repositoryName,
              githubConnectionId: target.githubConnectionId,
              pullNumber: result.pullNumber,
              comment:
                "Closed because the Linear connector target changed during configuration sync.",
            })
          }
          throw new Error(
            "Linear sync target changed during configuration sync",
          )
        }
      } else {
        failurePhase = "sync_failed"
        const updated = await withOrgDbContext(input.orgId, () =>
          transitionLinearSyncTargetState({
            connectionId: input.connectionId,
            expectedSetupPhase: "awaiting_merge",
            expectedPendingConfigPrCreating: true,
            repositoryId: target.repositoryId,
            branch: target.branch,
            pendingConfigPullUrl: null,
            pendingConfigPrCreating: false,
            setupPhase: "initial_sync",
          }),
        )
        if (!updated) {
          throw new Error(
            "Linear sync target changed during configuration sync",
          )
        }
        expectedPhase = "initial_sync"
        expectedPendingConfigPrCreating = false
        await runWorkflowWithWorkerWake(linearSyncContent.spec, {
          orgId: input.orgId,
          connectionId: input.connectionId,
        })
      }
      return result
    } catch (error) {
      await withOrgDbContext(input.orgId, () =>
        transitionLinearSyncTargetState({
          connectionId: input.connectionId,
          expectedSetupPhase: expectedPhase,
          expectedPendingConfigPrCreating,
          repositoryId: target.repositoryId,
          branch: target.branch,
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          setupPhase: failurePhase,
        }),
      )
      throw error
    }
  },
)
