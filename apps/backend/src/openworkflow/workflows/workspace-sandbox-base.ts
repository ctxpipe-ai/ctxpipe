import { z } from "zod"
import { currentSandboxAgent } from "../../domain/workspaces/workspace-base-providers.js"
import {
  publishWorkspaceBase,
  reserveWorkspaceBaseBuild,
  runWorkspaceBaseBuild,
} from "../../domain/workspaces/workspace-sandbox-base.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/**
 * Build (or refresh) one Workspace's base in durable steps (ADR-047): reserve
 * the build (its `building` row is the lease, cleaned up by the sweep once
 * expired), build (create the builder, clone and set up, capture; retried by
 * OpenWorkflow), publish. Requested by new conversation starts; reserve
 * decides whether a build is needed. Unused bases are deleted by the org's
 * sandbox sweep.
 */
export const workspaceSandboxBase = defineWorkflow(
  {
    name: "workspace-sandbox-base",
    schema: z.object({
      orgId: z.string().min(1),
      workspaceId: z.string().min(1),
    }),
  },
  async ({ input, step }) => {
    const reserved = await step.run({ name: "reserve" }, async () => {
      const agent = await currentSandboxAgent()
      if (!agent) return null
      const baseId = await reserveWorkspaceBaseBuild({ ...input, agent })
      return baseId ? { baseId, provider: agent.provider } : null
    })
    if (!reserved) return { built: false }
    const built = await step.run(
      { name: "build", retryPolicy: { maximumAttempts: 3 } },
      () =>
        runWorkspaceBaseBuild({ orgId: input.orgId, baseId: reserved.baseId }),
    )
    if (!built) return { built: false }
    const published = await step.run({ name: "publish" }, () =>
      publishWorkspaceBase({ ...input, ...reserved, built }),
    )
    return { built: published }
  },
)

/**
 * Ask for a base build. Requests within one 10-minute window share a run, so
 * concurrent starts in a Workspace queue one; a failed build is retried by
 * the next window's first start.
 */
export async function requestWorkspaceSandboxBase(
  orgId: string,
  workspaceId: string,
  now: Date = new Date(),
): Promise<void> {
  const window = Math.floor(now.getTime() / (10 * 60_000))
  await runWorkflowWithWorkerWake(
    workspaceSandboxBase.spec,
    { orgId, workspaceId },
    { idempotencyKey: `workspace-sandbox-base:${workspaceId}:${window}` },
  )
}
