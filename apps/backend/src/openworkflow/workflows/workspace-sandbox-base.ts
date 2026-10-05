import { z } from "zod"
import { currentSandboxAgent } from "../../domain/workspaces/workspace-base-providers.js"
import {
  releaseFailedBaseBuild,
  reserveWorkspaceBaseBuild,
  runWorkspaceBaseBuild,
} from "../../domain/workspaces/workspace-sandbox-base.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/** The build step runs at most this many times (the first and two retries). */
const BUILD_ATTEMPTS = 3

/**
 * Build (or refresh) one Workspace's base in durable steps (ADR-047):
 * `reserve` (the `building` row, keyed by this run, is the lease) and `build`
 * (create the builder, clone and set up, capture and publish; safe to run
 * again at any point). OpenWorkflow runs `build` up to three times. When the
 * last attempt fails, `release` ends the lease at once, so the failed build
 * blocks no new build and holds no slot; the sweep deletes its row.
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
    try {
      const ref = await step.run(
        { name: "build", retryPolicy: { maximumAttempts: BUILD_ATTEMPTS } },
        () => runWorkspaceBaseBuild({ orgId: input.orgId, baseId }),
      )
      return { built: ref !== null }
    } catch (error) {
      const attempts = (error as { stepFailedAttempts?: number })
        .stepFailedAttempts
      if (attempts !== undefined && attempts >= BUILD_ATTEMPTS)
        await step.run({ name: "release" }, () =>
          releaseFailedBaseBuild({ orgId: input.orgId, baseId }),
        )
      throw error
    }
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
