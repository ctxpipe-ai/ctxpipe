import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getPagerdutyBindingByConnectionId,
  getPagerdutyConnectionByConnectionId,
  transitionPagerdutyBindingState,
} from "../../models/pagerduty-connector.js"
import { syncPagerdutyConfigYaml } from "../../services/pagerduty/sync.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { pagerdutySyncContent } from "./pagerduty-sync-content.js"

const pagerdutySyncConfigInputSchema = z.object({
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  connectionId: z.string().min(1),
  services: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      url: z.string().url().optional(),
    }),
  ),
})

export const pagerdutySyncConfig = defineWorkflow(
  {
    name: "pagerduty-sync-config",
    schema: pagerdutySyncConfigInputSchema,
  },
  async ({ input, step }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const binding = await step.run({ name: "load-pagerduty-binding" }, () =>
      getPagerdutyBindingByConnectionId(input.connectionId),
    )
    if (!binding) throw new Error("PagerDuty binding is not configured")
    if (binding.orgId !== input.orgId) {
      throw new Error("PagerDuty binding does not belong to organization")
    }
    if (
      !binding.enabled ||
      binding.setupPhase !== "awaiting_merge" ||
      !binding.pendingConfigPrCreating
    ) {
      throw new Error("PagerDuty binding is not ready for configuration sync")
    }
    const connection = await step.run(
      { name: "load-pagerduty-connection" },
      () =>
        withOrgDbContext(input.orgId, () =>
          getPagerdutyConnectionByConnectionId(
            input.orgId,
            input.connectionId,
            env,
          ),
        ),
    )
    if (!connection) throw new Error("PagerDuty connection not found")

    let expectedPhase: "awaiting_merge" | "initial_sync" = "awaiting_merge"
    let expectedPendingConfigPrCreating = true
    try {
      const result = await step.run({ name: "sync-config" }, () =>
        syncPagerdutyConfigYaml({
          orgId: input.orgId,
          orgSlug: input.orgSlug,
          env,
          connection,
          binding,
          services: input.services,
        }),
      )
      const transitioned = await step.run(
        { name: "persist-config-pr-state" },
        () =>
          withOrgDbContext(input.orgId, () =>
            transitionPagerdutyBindingState({
              connectionId: input.connectionId,
              expectedSetupPhase: "awaiting_merge",
              expectedPendingConfigPrCreating: true,
              repositoryId: binding.repositoryId,
              branch: binding.branch,
              pendingConfigPullUrl: result.changed
                ? (result.pullUrl ?? null)
                : null,
              pendingConfigPrCreating: false,
              setupPhase: result.changed ? "awaiting_merge" : "initial_sync",
            }),
          ),
      )
      if (!transitioned) {
        throw new Error("PagerDuty binding changed during configuration sync")
      }
      if (!result.changed) {
        expectedPhase = "initial_sync"
        expectedPendingConfigPrCreating = false
        await step.run({ name: "enqueue-initial-content-sync" }, () =>
          runWorkflowWithWorkerWake(pagerdutySyncContent.spec, {
            orgId: input.orgId,
            connectionId: input.connectionId,
          }),
        )
      }
      return result
    } catch (e) {
      await step.run({ name: "mark-config-failed" }, () =>
        withOrgDbContext(input.orgId, () =>
          transitionPagerdutyBindingState({
            connectionId: input.connectionId,
            expectedSetupPhase: expectedPhase,
            expectedPendingConfigPrCreating,
            repositoryId: binding.repositoryId,
            branch: binding.branch,
            pendingConfigPullUrl: binding.pendingConfigPullUrl ?? null,
            pendingConfigPrCreating: false,
            setupPhase: "config_failed",
          }),
        ),
      )
      throw e
    }
  },
)
