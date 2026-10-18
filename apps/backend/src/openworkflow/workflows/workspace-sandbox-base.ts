import { z } from "zod"
import { currentSandboxAgent } from "../../domain/workspaces/workspace-base-providers.js"
import {
  reserveWorkspaceBaseBuild,
  runWorkspaceBaseBuild,
} from "../../domain/workspaces/workspace-sandbox-base.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/**
 * Build (or refresh) one Workspace's base in durable steps (ADR-047):
 * `reserve` (the `building` row, keyed by this run, is the lease) and `build`
 * (create the builder, clone and set up, capture and publish). `build` runs
 * once: a failed build marks its row `destroy_failed` itself (no lease, no
 * slot; the sweep deletes it), and the next 10-minute window's first start
 * requests a new build.
 * Requested by new sandbox starts when the base is missing or stale; reserve
 * decides. Unused bases are deleted by the org's sandbox sweep.
 */
export const workspaceSandboxBase = defineWorkflow(
  {
    name: "workspace-sandbox-base",
    schema: z.object({
      orgId: z.string().min(1),
      workspaceId: z.string().min(1),
    }),
  },
  async ({ input, step, run }) => {
    const baseId = await step.run({ name: "reserve" }, async () => {
      const agent = await currentSandboxAgent()
      if (!agent) return null
      return reserveWorkspaceBaseBuild({ ...input, runId: run.id, agent })
    })
    if (!baseId) return { built: false }
    const ref = await step.run(
      { name: "build", retryPolicy: { maximumAttempts: 1 } },
      () => runWorkspaceBaseBuild({ orgId: input.orgId, baseId }),
    )
    return { built: ref !== null }
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
